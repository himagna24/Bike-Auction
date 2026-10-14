import express, { type Request, type Response, type NextFunction } from 'express';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { Server as IOServer } from 'socket.io';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { BidError, placeBid } from './bids.js';
import { closeExpiredAuctions, startDueAuctions } from './lifecycle.js';
import { hashPassword, verifyPassword, signToken, requireAuth, requireAdmin, verifyToken } from './auth.js';
import * as m from './metrics.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] });
const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: config.corsOrigin } });

app.set('trust proxy', 1); // behind Render/Fly proxy; needed for correct client IP in rate limiting
app.use(helmet({ contentSecurityPolicy: { directives: {
  ...helmet.contentSecurityPolicy.getDefaultDirectives(),
  'img-src': ["'self'", 'data:', 'https:'],
} } }));
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '50kb' }));
app.use(pinoHttp({
  logger: log,
  genReqId: (req, res) => {
    const id = (req.headers['x-request-id'] as string) ?? randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
}));
app.use((req, res, next) => {
  const end = m.httpDuration.startTimer();
  res.on('finish', () => end({ method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode }));
  next();
});

// ---------- ops endpoints ----------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/ready', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
  catch { res.status(503).json({ status: 'db_unavailable' }); }
});
app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', m.registry.contentType);
  res.end(await m.registry.metrics());
});

// ---------- helpers ----------
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const maskEmail = (e: string) => `${e.slice(0, 2)}***`;
const dto = (a: any) => ({
  id: a.id, title: a.title, make: a.make, model: a.model, year: a.year, km: a.km,
  imageUrl: a.image_url, description: a.description, status: a.status,
  startPriceCents: Number(a.start_price_cents), currentPriceCents: Number(a.current_price_cents),
  minIncrementCents: Number(a.min_increment_cents), bidCount: a.bid_count,
  startsAt: a.starts_at, endsAt: a.ends_at, winnerId: a.winner_id, reserveMet:
    a.reserve_price_cents == null ? true : Number(a.current_price_cents) >= Number(a.reserve_price_cents),
  serverTime: new Date().toISOString(),
});

// ---------- auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } } });
const creds = z.object({ email: z.string().email().max(254).toLowerCase(), password: z.string().min(8).max(128) });

app.post('/api/auth/register', loginLimiter, wrap(async (req, res) => {
  const { email, password } = creds.parse(req.body);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id, role`, [email, await hashPassword(password)]);
    res.status(201).json({ token: signToken(rows[0]), user: { id: rows[0].id, email, role: rows[0].role } });
  } catch (e: any) {
    if (e.code === '23505') throw new BidError('EMAIL_TAKEN', 'Email already registered', 409);
    throw e;
  }
}));

app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = creds.parse(req.body);
  const { rows } = await pool.query(`SELECT id, role, password_hash FROM users WHERE email=$1`, [email]);
  const u = rows[0];
  // Same error for unknown email and bad password: don't leak which emails exist.
  if (!u || !(await verifyPassword(u.password_hash, password)))
    throw new BidError('BAD_CREDENTIALS', 'Invalid email or password', 401);
  req.log.info({ userId: u.id }, 'login');
  res.json({ token: signToken(u), user: { id: u.id, email, role: u.role } });
}));

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await pool.query(`SELECT id,email,role FROM users WHERE id=$1`, [req.user!.id]);
  if (!rows[0]) throw new BidError('UNAUTHENTICATED', 'User no longer exists', 401);
  res.json(rows[0]);
}));

// ---------- auctions ----------
app.get('/api/auctions', wrap(async (req, res) => {
  const status = z.enum(['SCHEDULED', 'LIVE', 'SOLD', 'UNSOLD', 'CANCELLED']).optional().parse(req.query.status);
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit);
  const { rows } = await pool.query(
    `SELECT * FROM auctions WHERE ($1::text IS NULL OR status=$1)
     ORDER BY (status='LIVE') DESC, ends_at ASC LIMIT $2`, [status ?? null, limit]);
  res.json({ items: rows.map(dto) });
}));

app.get('/api/auctions/:id', wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const a = (await pool.query(`SELECT * FROM auctions WHERE id=$1`, [id])).rows[0];
  if (!a) throw new BidError('NOT_FOUND', 'Auction not found', 404);
  const bids = await pool.query(
    `SELECT b.id, b.amount_cents, b.created_at, b.user_id, u.email FROM bids b JOIN users u ON u.id=b.user_id
     WHERE b.auction_id=$1 ORDER BY b.amount_cents DESC LIMIT 20`, [id]);
  res.json({ ...dto(a), bids: bids.rows.map(b => ({
    id: b.id, amountCents: Number(b.amount_cents), createdAt: b.created_at,
    userId: b.user_id, bidder: maskEmail(b.email) })) });
}));

const auctionBody = z.object({
  title: z.string().min(3).max(120), make: z.string().min(1).max(50), model: z.string().min(1).max(50),
  year: z.number().int().min(1950).max(new Date().getFullYear() + 1), km: z.number().int().min(0).max(1_000_000),
  imageUrl: z.string().url().max(500).optional(), description: z.string().max(2000).optional(),
  startPriceCents: z.number().int().positive(), reservePriceCents: z.number().int().positive().optional(),
  minIncrementCents: z.number().int().positive().default(10000),
  startsAt: z.coerce.date(), endsAt: z.coerce.date(),
}).refine(v => v.endsAt > v.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine(v => v.reservePriceCents == null || v.reservePriceCents >= v.startPriceCents,
    { message: 'reserve must be >= start price', path: ['reservePriceCents'] });

app.post('/api/auctions', requireAuth, requireAdmin, wrap(async (req, res) => {
  const b = auctionBody.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO auctions(title,make,model,year,km,image_url,description,start_price_cents,reserve_price_cents,
       min_increment_cents,current_price_cents,starts_at,ends_at,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8,$11,$12,$13) RETURNING *`,
    [b.title, b.make, b.model, b.year, b.km, b.imageUrl ?? null, b.description ?? null, b.startPriceCents,
     b.reservePriceCents ?? null, b.minIncrementCents, b.startsAt, b.endsAt, req.user!.id]);
  req.log.info({ auctionId: rows[0].id, adminId: req.user!.id }, 'auction created');
  res.status(201).json(dto(rows[0]));
}));

// Edits only allowed before the auction starts, so nobody can change terms under bidders.
app.patch('/api/auctions/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = auctionBody.parse(req.body);
  const { rows } = await pool.query(
    `UPDATE auctions SET title=$2,make=$3,model=$4,year=$5,km=$6,image_url=$7,description=$8,start_price_cents=$9,
       reserve_price_cents=$10,min_increment_cents=$11,current_price_cents=$9,starts_at=$12,ends_at=$13
     WHERE id=$1 AND status='SCHEDULED' RETURNING *`,
    [id, b.title, b.make, b.model, b.year, b.km, b.imageUrl ?? null, b.description ?? null, b.startPriceCents,
     b.reservePriceCents ?? null, b.minIncrementCents, b.startsAt, b.endsAt]);
  if (!rows[0]) throw new BidError('NOT_EDITABLE', 'Only scheduled auctions can be edited', 409);
  req.log.info({ auctionId: id, adminId: req.user!.id }, 'auction edited');
  res.json(dto(rows[0]));
}));

app.post('/api/auctions/:id/cancel', requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { rows } = await pool.query(
    `UPDATE auctions SET status='CANCELLED' WHERE id=$1 AND status IN ('SCHEDULED','LIVE') RETURNING *`, [id]);
  if (!rows[0]) throw new BidError('NOT_CANCELLABLE', 'Auction cannot be cancelled', 409);
  req.log.warn({ auctionId: id, adminId: req.user!.id }, 'auction cancelled');
  io.to(`auction:${id}`).emit('auction:status', { auctionId: id, status: 'CANCELLED' });
  res.json(dto(rows[0]));
}));

// ---------- bidding ----------
const bidLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon',
  message: { error: { code: 'RATE_LIMITED', message: 'Slow down, too many bids' } } });

app.post('/api/auctions/:id/bids', requireAuth, bidLimiter, wrap(async (req, res) => {
  const auctionId = z.string().uuid().parse(req.params.id);
  const { amountCents } = z.object({ amountCents: z.number().int().positive() }).parse(req.body);
  const idempotencyKey = z.string().min(8).max(100).parse(req.header('idempotency-key'));
  const done = m.bidLatency.startTimer();
  try {
    const r = await placeBid(pool, { auctionId, userId: req.user!.id, amountCents, idempotencyKey });
    if (!r.replay) {
      m.bidsPlaced.inc();
      req.log.info({ auctionId, userId: req.user!.id, amountCents, extended: r.extended }, 'bid placed');
      io.to(`auction:${auctionId}`).emit('bid', {
        auctionId, bidId: r.bidId, amountCents: r.amountCents, endsAt: r.endsAt, extended: r.extended,
        userId: req.user!.id, at: new Date().toISOString() });
    }
    res.status(r.replay ? 200 : 201).json({ bidId: r.bidId, amountCents: r.amountCents, endsAt: r.endsAt, extended: r.extended });
  } catch (e) {
    if (e instanceof BidError) m.bidsRejected.inc({ code: e.code });
    throw e;
  } finally { done(); }
}));

// ---------- static frontend (single deployable: API + SPA on one origin) ----------
const webDir = fileURLToPath(new URL('../web/dist', import.meta.url));
if (existsSync(webDir)) {
  app.use(express.static(webDir, { maxAge: '1h', index: false }));
  app.get(/^\/(?!api\/|socket\.io\/|health|ready|metrics).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

// ---------- errors ----------
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError)
    return void res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid input', details: err.flatten() } });
  if (err instanceof BidError)
    return void res.status(err.status).json({ error: { code: err.code, message: err.message } });
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
});

// ---------- websockets ----------
io.use((socket, next) => { // auth is optional: spectators can watch, but identify when possible
  const t = socket.handshake.auth?.token;
  if (t) try { socket.data.user = verifyToken(t); } catch { /* treat as anonymous */ }
  next();
});
io.on('connection', (socket) => {
  m.wsConnections.inc();
  socket.on('join', (auctionId: unknown) => {
    if (z.string().uuid().safeParse(auctionId).success) socket.join(`auction:${auctionId}`);
  });
  socket.on('leave', (auctionId: unknown) => { if (typeof auctionId === 'string') socket.leave(`auction:${auctionId}`); });
  socket.on('disconnect', () => m.wsConnections.dec());
});

// ---------- lifecycle worker ----------
// Polling is safe with many instances: starts are idempotent UPDATEs, closes use SKIP LOCKED.
let ticking = false;
async function tick() {
  if (ticking) return; // never overlap with a slow previous tick
  ticking = true;
  try {
    for (const id of await startDueAuctions(pool)) {
      log.info({ auctionId: id }, 'auction started');
      io.to(`auction:${id}`).emit('auction:status', { auctionId: id, status: 'LIVE' });
    }
    for (const c of await closeExpiredAuctions(pool)) {
      log.info({ auctionId: c.id, status: c.status, winnerId: c.winnerId }, 'auction closed');
      m.auctionsClosed.inc({ status: c.status });
      io.to(`auction:${c.id}`).emit('auction:status', { auctionId: c.id, status: c.status, winnerId: c.winnerId });
    }
  } catch (e) { log.error({ err: e }, 'worker tick failed'); }
  finally { ticking = false; }
}

const timer = setInterval(tick, config.workerIntervalMs);
server.listen(config.port, () => log.info({ port: config.port }, 'server listening'));

// graceful shutdown: stop taking work, drain, close pool
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log.info({ sig }, 'shutting down');
    clearInterval(timer);
    io.close();
    server.close(async () => { await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
