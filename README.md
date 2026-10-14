# BikeBid – Live Motorcycle Auction Platform

Registered users bid on used motorcycles in real time. Admins create and manage auctions.
Multiple auctions run at once; bids are concurrency-safe; auctions start and close automatically.

**Live demo:** `<your-deployed-url>`

| Role  | Email               | Password   |
|-------|---------------------|------------|
| Admin | admin@bikes.test    | Admin123!  |
| Buyer | buyer1@bikes.test   | Buyer123!  |
| Buyer | buyer2@bikes.test   | Buyer123!  |

(The login page also has one-click "Demo buyer" / "Demo admin" buttons.)

## Features
- Register / login, roles (`BUYER`, `ADMIN`), argon2 password hashing, JWT auth
- Auction list (Live / Upcoming / Ended) and a live auction page: price, countdown, bid form, bid history
- Real-time updates over WebSockets (Socket.IO, one room per auction)
- Concurrency-safe bidding (row lock), idempotent bid requests, anti-sniping (+30s for bids in the last 30s)
- Automatic lifecycle: `SCHEDULED → LIVE → SOLD / UNSOLD`, or `CANCELLED` by an admin; reserve price support
- Admin: create and cancel auctions (API also supports editing scheduled auctions)
- Observability: structured JSON logs with request IDs, `/health`, `/ready`, Prometheus `/metrics`
- Rate limiting, input validation, security headers

## Tech stack
Node 22 + TypeScript + Express · PostgreSQL 16 · Socket.IO · React + Vite · Vitest · Docker · GitHub Actions

## Quick start (local)
Prerequisites: Node 22+, PostgreSQL 16 (or Docker), Git.

```bash
# 1. database (Docker option; otherwise create a local database named "bikes")
docker compose up -d

# 2. configuration
cp .env.example .env        # Windows: copy .env.example .env
# edit .env: set DATABASE_URL and a JWT_SECRET of 32+ random characters

# 3. install, create tables, load demo data
npm install
npm --prefix web install
npm run migrate
npm run seed

# 4. run backend (port 3000) and frontend (port 5173) in two terminals
npm run dev
cd web && npm run dev
```
Open http://localhost:5173.

## Environment variables
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | Postgres connection string |
| `DATABASE_SSL` | no | `false` | set `true` for hosted Postgres (Neon etc.) |
| `JWT_SECRET` | yes | – | signs auth tokens; 32+ random chars |
| `JWT_TTL` | no | `1h` | token lifetime |
| `CORS_ORIGIN` | no | `http://localhost:5173` | comma-separated allowed origins |
| `PORT` | no | `3000` | HTTP port |
| `WORKER_INTERVAL_MS` | no | `2000` | lifecycle worker poll interval |
| `LOG_LEVEL` | no | `info` | pino log level |

## Scripts
`npm run dev` · `npm test` · `npm run build` · `npm run migrate` · `npm run seed` (wipes and reloads demo auctions)

## Tests
```bash
npm test
```
Needs a running Postgres (uses `DATABASE_URL`). 7 tests:
- bid rule unit tests (increment, seller, ended auction)
- **50 simultaneous bids** leave price, bid count and bid rows consistent
- replaying an idempotency key does not create a second bid
- two workers closing at once close the auction exactly once

CI (`.github/workflows/ci.yml`) runs typecheck + tests against a Postgres service on every push.

## API
All errors look like `{ "error": { "code": "BID_TOO_LOW", "message": "..." } }`. Money is integer minor units (paise).

| Method & path | Auth | Notes |
|---|---|---|
| `POST /api/auth/register`, `POST /api/auth/login` | – | rate limited |
| `GET /api/me` | user | |
| `GET /api/auctions?status=&limit=` | – | list |
| `GET /api/auctions/:id` | – | detail + last 20 bids (bidder emails masked) |
| `POST /api/auctions` | admin | create |
| `PATCH /api/auctions/:id` | admin | only while `SCHEDULED` |
| `POST /api/auctions/:id/cancel` | admin | |
| `POST /api/auctions/:id/bids` | user | body `{amountCents}`, header `Idempotency-Key` required |
| `GET /health`, `/ready`, `/metrics` | – | ops |

WebSocket: client emits `join` with an auction id; server emits `bid` and `auction:status`.

## Docs
- [Architecture & design](docs/ARCHITECTURE.md)
- [Assumptions & trade-offs](docs/TRADEOFFS.md)
- [Deployment](docs/DEPLOYMENT.md)
