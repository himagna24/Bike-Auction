import type { Pool } from 'pg';

export class BidError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}

export const ANTI_SNIPE_WINDOW_MS = 30_000;
export const ANTI_SNIPE_EXTENSION_MS = 30_000;

export interface BidInput { auctionId: string; userId: string; amountCents: number; idempotencyKey: string }
export interface BidResult { bidId: string; amountCents: number; endsAt: Date; extended: boolean; replay: boolean }

/** Pure rule check so it can be unit-tested without a DB. */
export function validateBid(a: {
  status: string; ends_at: Date; starts_at: Date; created_by: string | null;
  current_price_cents: string | number; min_increment_cents: string | number; bid_count: number;
}, userId: string, amountCents: number, now: Date) {
  if (a.status !== 'LIVE' || now < a.starts_at || now >= a.ends_at)
    throw new BidError('AUCTION_NOT_LIVE', 'Auction is not accepting bids');
  if (a.created_by === userId) throw new BidError('OWN_AUCTION', 'You cannot bid on your own auction', 403);
  const current = Number(a.current_price_cents);
  const inc = Number(a.min_increment_cents);
  // First bid may match the start price; later bids must beat the current by the increment.
  const min = a.bid_count === 0 ? current : current + inc;
  if (amountCents < min) throw new BidError('BID_TOO_LOW', `Minimum bid is ${min}`, 422);
}

/**
 * Concurrency strategy: pessimistic row lock. SELECT ... FOR UPDATE serialises all
 * bids on one auction, so validation always sees the latest price. Different
 * auctions don't block each other. Time is read from the DB (now()), never the client.
 */
export async function placeBid(pool: Pool, input: BidInput): Promise<BidResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT *, now() AS db_now FROM auctions WHERE id = $1 FOR UPDATE`, [input.auctionId]);
    const a = rows[0];
    if (!a) throw new BidError('NOT_FOUND', 'Auction not found', 404);

    // Idempotent retry: same user + key returns the original result.
    const dup = await client.query(
      `SELECT id, amount_cents FROM bids WHERE user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey]);
    if (dup.rows[0]) {
      await client.query('COMMIT');
      return { bidId: dup.rows[0].id, amountCents: Number(dup.rows[0].amount_cents),
               endsAt: a.ends_at, extended: false, replay: true };
    }

    const now: Date = a.db_now;
    validateBid(a, input.userId, input.amountCents, now);

    const ins = await client.query(
      `INSERT INTO bids (auction_id,user_id,amount_cents,idempotency_key)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.auctionId, input.userId, input.amountCents, input.idempotencyKey]);

    const remaining = a.ends_at.getTime() - now.getTime();
    const extended = remaining <= ANTI_SNIPE_WINDOW_MS;
    const upd = await client.query(
      `UPDATE auctions SET current_price_cents=$2, bid_count=bid_count+1,
         ends_at = CASE WHEN $3::boolean THEN ends_at + ($4::int * interval '1 millisecond') ELSE ends_at END
       WHERE id=$1 RETURNING ends_at`,
      [input.auctionId, input.amountCents, extended, ANTI_SNIPE_EXTENSION_MS]);
    await client.query('COMMIT');
    return { bidId: ins.rows[0].id, amountCents: input.amountCents,
             endsAt: upd.rows[0].ends_at, extended, replay: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}
