# Assumptions & Trade-offs

## Assumptions
- Single currency (INR), stored as integer paise. One bike per auction.
- No payments or escrow: "SOLD" records the winner; settlement happens off-platform.
- Anyone can register as a buyer; admin accounts are created by seed/DB only (no self-serve admin).
- The admin who creates an auction cannot bid on it.
- First bid may equal the start price; later bids must beat the current price by the minimum increment.
- Demo scale: one region, one app instance, tens of concurrent users per auction.

## Decisions and why
| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Bid concurrency | `SELECT … FOR UPDATE` on the auction row | optimistic version + retry | auction rows are inherently contended; locking serialises cheaply and avoids retry storms |
| Closing auctions | polling worker + `SKIP LOCKED` | BullMQ / delayed jobs | no extra infrastructure; still safe with multiple instances |
| Real-time | Socket.IO, server broadcasts, clients re-fetch | send full state in events | re-fetching can't drift out of sync; reconnect self-heals |
| Time | DB `now()` and server-sent `endsAt` | client or app-server clock | one authoritative clock |
| Writes over WebSocket | REST only | bid via socket | single validated, rate-limited, idempotent path |
| Frontend serving | Express serves the built SPA | separate static host | one deployable, same origin, no CORS in production |
| Prices | integer paise | decimals/floats | no rounding errors |

## What I deliberately did not build
- **No Redis.** Single instance, so no Socket.IO adapter and per-process rate limits. The scaling path is documented in ARCHITECTURE.md.
- **No refresh tokens.** One 1-hour JWT. Simpler, but users must log in again after an hour.
- **Token in localStorage.** Exposed if the site has an XSS bug; an httpOnly cookie would need CSRF protection. CSP and React's escaping reduce the risk, but this is a conscious trade-off.
- **No audit table, notifications, watchlist, image upload** (images are URLs), **no admin edit form** (the API supports editing scheduled auctions).
- **No frontend or end-to-end tests.** Testing effort went to the bid and lifecycle core and its concurrency behaviour.

## Known limitations
- **Closing lag:** the worker runs every 2 s, so the status can flip up to ~2 s after `ends_at`. Bids after `ends_at` are still rejected immediately because validation uses the DB clock.
- **Unbounded anti-sniping:** each late bid extends by 30 s with no cap, so a bidding war can run on. A maximum total extension would fix this.
- **`/metrics` is public.** Fine for a demo; in production restrict it by network or auth.
- **Rate limits are per instance** (in-memory), so they weaken behind multiple instances.
- **Idempotency key scope:** keys are unique per user across auctions; clients should generate a fresh UUID per bid (the UI does).
- **`reserveMet` is shown to everyone,** which reveals whether the hidden reserve has been reached. Chosen for transparency; some auctions hide it.
- **Hosted Postgres TLS** is enabled without certificate pinning (`rejectUnauthorized: false`) for compatibility with managed providers.
- **Dev-only dependency advisories:** `npm audit` flags test/dev tooling (vitest, vite, esbuild); production dependencies report 0 vulnerabilities.
- **Seed data is relative to the seed time**, so demo auctions eventually end; re-run `npm run seed` (which wipes bids and auctions) or create new auctions as admin.
- **Free hosting tiers sleep** when idle; the first request after a pause can take 30–60 s.
