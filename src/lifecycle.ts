import type { Pool } from 'pg';

/** Starts due auctions. Idempotent and safe to run on many instances. */
export async function startDueAuctions(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(
    `UPDATE auctions SET status='LIVE'
     WHERE status='SCHEDULED' AND starts_at <= now() AND ends_at > now() RETURNING id`);
  return rows.map(r => r.id);
}

/**
 * Closes expired auctions. FOR UPDATE SKIP LOCKED means two workers never close the
 * same auction, and a worker never waits on a row a bidder currently holds.
 * Winner = highest bid, only if reserve met; otherwise UNSOLD.
 */
export async function closeExpiredAuctions(pool: Pool): Promise<{ id: string; status: string; winnerId: string | null }[]> {
  const client = await pool.connect();
  const out: { id: string; status: string; winnerId: string | null }[] = [];
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id, reserve_price_cents FROM auctions
       WHERE status='LIVE' AND ends_at <= now() FOR UPDATE SKIP LOCKED`);
    for (const a of due.rows) {
      const top = await client.query(
        `SELECT user_id, amount_cents FROM bids WHERE auction_id=$1
         ORDER BY amount_cents DESC, created_at ASC LIMIT 1`, [a.id]);
      const t = top.rows[0];
      const sold = t && (a.reserve_price_cents == null || Number(t.amount_cents) >= Number(a.reserve_price_cents));
      const status = sold ? 'SOLD' : 'UNSOLD';
      const winnerId = sold ? t.user_id : null;
      await client.query(`UPDATE auctions SET status=$2, winner_id=$3 WHERE id=$1`, [a.id, status, winnerId]);
      out.push({ id: a.id, status, winnerId });
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return out;
}
