# Deployment (Render + Neon, free tiers)

The app deploys as **one Docker web service** (API + WebSockets + frontend) plus a **Postgres database**.

## 1. Database (Neon)
1. Create an account at neon.tech and a new project (pick the region closest to your Render region).
2. Copy the **connection string** (looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`).

## 2. Push the code to GitHub
Create a repo and push the project. `.env` is git-ignored; never commit secrets.

## 3. Web service (Render)
1. render.com → **New → Web Service** → connect the GitHub repo.
2. **Runtime:** Docker (it uses the `Dockerfile`; the build compiles the API and the frontend).
3. **Health check path:** `/health`
4. **Environment variables:**
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | your Neon connection string |
   | `DATABASE_SSL` | `true` |
   | `JWT_SECRET` | a new random 48+ char string (do not reuse the local one) |
   | `NODE_ENV` | `production` |
5. Deploy. The container runs `migrate` on every start (idempotent), then the server. Render supplies `PORT` automatically.

## 4. Load demo data
The seed script needs the same environment variables. From your laptop (PowerShell):
```powershell
$env:DATABASE_URL="<your Neon connection string>"
$env:DATABASE_SSL="true"
$env:JWT_SECRET="anything-32-characters-or-longer-xxxxxxxx"
npm run seed
```
> `seed` **deletes all bids and auctions** and recreates the demo set. Run it again shortly before a review so the demo auctions are still live.

## 5. Verify
- `https://<your-app>.onrender.com/health` → `{"status":"ok"}`
- Open the site, log in with a demo account, place a bid, open a second window and watch it update.
- `/metrics` shows the Prometheus metrics.

## Operating notes
- **Logs:** Render dashboard → Logs (JSON, one line per event; search by `requestId` or `auctionId`).
- **Free tier sleeps** after ~15 min idle; open the site once before showing it to anyone.
- **Rollback:** Render → Deploys → redeploy a previous build. Schema changes are additive (`IF NOT EXISTS`).
- **Several instances:** requires the Socket.IO Redis adapter first (see ARCHITECTURE.md).
