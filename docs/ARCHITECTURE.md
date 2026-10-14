# Architecture & Design

## Overview
One Node process serves the REST API, the WebSocket server, the lifecycle worker and the built React app.
PostgreSQL is the single source of truth. This keeps the system simple to deploy and reason about, while
the pieces that would block horizontal scaling are isolated and documented (see "Scaling path").

```
Browser (React) ──HTTPS──▶ Express ──SQL──▶ PostgreSQL
        ▲                    │  ▲
        └──── WebSocket ─────┘  └── lifecycle worker (setInterval, same process)
```

## Data model
- `users(id, email unique, password_hash, role)`
- `auctions(id, bike details, start_price, reserve_price, min_increment, current_price, starts_at, ends_at, status, winner_id, bid_count, created_by)`
- `bids(id, auction_id, user_id, amount, idempotency_key, created_at)` with `UNIQUE(user_id, idempotency_key)`

Indexes: `auctions(status, ends_at)` serves the worker's "what is due" query; `bids(auction_id, amount DESC)` serves
bid history and winner lookup. `current_price` and `bid_count` are denormalised onto `auctions` so list pages
need no aggregate query; they are updated in the same transaction as the bid insert, so they cannot drift.
Money is stored as integer paise (never floats).

## Auction lifecycle
```
SCHEDULED ──(starts_at reached)──▶ LIVE ──(ends_at reached)──▶ SOLD | UNSOLD
    └──────────── admin cancel ───────┘──▶ CANCELLED
```
SOLD requires the highest bid to meet the reserve (if one is set); otherwise UNSOLD.
A worker polls every 2 s. Starting is an idempotent `UPDATE`. Closing selects due auctions with
`FOR UPDATE SKIP LOCKED`, so with several instances each auction is closed by exactly one worker, and a worker
never waits on a row a bidder is currently locking.

## Bid placement (the critical path)
`POST /api/auctions/:id/bids` → `placeBid()` in a single transaction:
1. `SELECT … FROM auctions WHERE id=$1 FOR UPDATE` (also reads `now()` from the database)
2. If `(user, Idempotency-Key)` already has a bid → return it (safe client retries)
3. Validate: status is LIVE, `now < ends_at`, bidder is not the creator, amount ≥ current + increment (≥ start price for the first bid)
4. Insert the bid; update `current_price`, `bid_count`
5. Anti-sniping: if ≤ 30 s remain, extend `ends_at` by 30 s
6. Commit, then broadcast over WebSocket

**Why a pessimistic lock:** an auction is a hot row by nature. Under contention an optimistic version check would
make most concurrent bidders fail and retry; locking serialises them cheaply (one short transaction) and the
validation always sees the latest price. Different auctions never block each other.
**Why the DB clock:** client clocks and per-instance app clocks can disagree; one clock decides who was in time.
The UI computes its countdown from `serverTime` returned by the API, not from the browser's clock.

## Real-time
Socket.IO, one room per auction. The server emits `bid` / `auction:status`; clients re-fetch the auction
(simple and always consistent). On reconnect the client re-joins and re-fetches, so missed events self-heal.
The WebSocket is read-only: all writes go through authenticated REST, so there is one validation path.

## Security
argon2id hashing · JWT (1 h) with role claim · zod validation on every input · parameterised SQL only ·
helmet + CSP · CORS allowlist · rate limits (10 auth attempts / 15 min / IP; 30 bids / min / user) ·
identical error for unknown email vs wrong password · bidder emails masked in public responses ·
secrets only from environment · non-root Docker user.

## Observability
- pino JSON logs; every request has an `x-request-id` (honoured from the caller or generated); the `Authorization` header is redacted; business events (bid placed, auction started/closed/cancelled) are logged with auction and user IDs.
- `/metrics` (Prometheus): `bids_placed_total`, `bids_rejected_total{code}`, `bid_latency_seconds`, `http_request_duration_seconds`, `active_auctions`, `ws_connections`, `auctions_closed_total{status}`, plus default Node metrics.
- `/health` (liveness) and `/ready` (checks the database).
- Graceful shutdown on SIGTERM: stop worker, close sockets, drain HTTP, close the DB pool.

## Scaling path (not implemented)
1. **Several app instances:** add the Socket.IO Redis adapter so a bid handled on instance A reaches sockets on B. Bid correctness already holds (row lock in Postgres) and the worker is already multi-instance safe.
2. **Rate limits:** move the limiter store to Redis (it is per-process now).
3. **Read load:** list/detail reads can move to a read replica or short-TTL cache; writes stay on the primary.
4. **Worker:** replace polling with a job queue (BullMQ) with a delayed job at `ends_at` (re-scheduled on anti-snipe extension).
5. **Hot auction at extreme load:** the per-auction row lock caps throughput at roughly one bid per transaction time (a few ms); a queue-per-auction would be the next step.
