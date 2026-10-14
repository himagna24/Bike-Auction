import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { placeBid, validateBid, BidError } from '../src/bids.js';
import { closeExpiredAuctions } from '../src/lifecycle.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/bikes' });
const users: string[] = [];
let auctionId = '';

beforeAll(async () => {
  await pool.query(readFileSync('db/schema.sql', 'utf8'));
  for (let i = 0; i < 50; i++) {
    const r = await pool.query(`INSERT INTO users(email,password_hash) VALUES($1,'x') RETURNING id`, [`t${Date.now()}_${i}@x.io`]);
    users.push(r.rows[0].id);
  }
  const a = await pool.query(
    `INSERT INTO auctions(title,make,model,year,km,start_price_cents,min_increment_cents,current_price_cents,starts_at,ends_at,status)
     VALUES('t','Honda','CB',2020,1000,100000,1000,100000,now()-interval '1 hour',now()+interval '1 hour','LIVE') RETURNING id`);
  auctionId = a.rows[0].id;
});
afterAll(() => pool.end());

describe('validateBid (pure rules)', () => {
  const base = { status: 'LIVE', starts_at: new Date(0), ends_at: new Date(2e12), created_by: 's',
    current_price_cents: 1000, min_increment_cents: 100, bid_count: 1 };
  it('rejects below increment', () => expect(() => validateBid(base, 'u', 1050, new Date())).toThrow(BidError));
  it('accepts at increment', () => expect(() => validateBid(base, 'u', 1100, new Date())).not.toThrow());
  it('rejects seller', () => expect(() => validateBid(base, 's', 5000, new Date())).toThrow(BidError));
  it('rejects ended', () => expect(() => validateBid({ ...base, ends_at: new Date(1) }, 'u', 5000, new Date())).toThrow(BidError));
});

describe('concurrency', () => {
  it('50 simultaneous bids leave consistent state', async () => {
    const results = await Promise.allSettled(users.map((u, i) =>
      placeBid(pool, { auctionId, userId: u, amountCents: 100000 + (i + 1) * 1000, idempotencyKey: `k-${i}` })));
    const { rows: [a] } = await pool.query(`SELECT current_price_cents, bid_count FROM auctions WHERE id=$1`, [auctionId]);
    const { rows: [m] } = await pool.query(`SELECT max(amount_cents) m, count(*) c FROM bids WHERE auction_id=$1`, [auctionId]);
    expect(Number(a.current_price_cents)).toBe(Number(m.m));
    expect(a.bid_count).toBe(Number(m.c));
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(Number(m.c));
    const { rows: bids } = await pool.query(`SELECT amount_cents FROM bids WHERE auction_id=$1 ORDER BY created_at`, [auctionId]);
    for (let i = 1; i < bids.length; i++)
      expect(Number(bids[i].amount_cents) - Number(bids[i - 1].amount_cents)).toBeGreaterThanOrEqual(1000);
  });
  it('replayed idempotency key does not double-bid', async () => {
    const before = (await pool.query(`SELECT bid_count FROM auctions WHERE id=$1`, [auctionId])).rows[0].bid_count;
    const r = await placeBid(pool, { auctionId, userId: users[0], amountCents: 999999, idempotencyKey: 'k-0' });
    expect(r.replay).toBe(true);
    expect((await pool.query(`SELECT bid_count FROM auctions WHERE id=$1`, [auctionId])).rows[0].bid_count).toBe(before);
  });
  it('closer picks winner once', async () => {
    await pool.query(`UPDATE auctions SET ends_at=now()-interval '1 second' WHERE id=$1`, [auctionId]);
    const [a, b] = await Promise.all([closeExpiredAuctions(pool), closeExpiredAuctions(pool)]);
    // other expired auctions in the DB may also be closed; only count ours. Exactly one worker must have closed it.
    expect([...a, ...b].filter(r => r.id === auctionId).length).toBe(1);
    const { rows: [r] } = await pool.query(`SELECT status FROM auctions WHERE id=$1`, [auctionId]);
    expect(r.status).toBe('SOLD');
  });
});
