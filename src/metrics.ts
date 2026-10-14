import client from 'prom-client';
import { pool } from './db.js';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const bidsPlaced = new client.Counter({ name: 'bids_placed_total', help: 'Accepted bids', registers: [registry] });
export const bidsRejected = new client.Counter({
  name: 'bids_rejected_total', help: 'Rejected bids by reason', labelNames: ['code'], registers: [registry] });
export const bidLatency = new client.Histogram({
  name: 'bid_latency_seconds', help: 'Time to process a bid', buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1], registers: [registry] });
export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP latency', labelNames: ['method', 'route', 'status'], registers: [registry] });
export const wsConnections = new client.Gauge({ name: 'ws_connections', help: 'Open websocket connections', registers: [registry] });
export const auctionsClosed = new client.Counter({
  name: 'auctions_closed_total', help: 'Auctions closed by outcome', labelNames: ['status'], registers: [registry] });
new client.Gauge({
  name: 'active_auctions', help: 'Auctions currently LIVE', registers: [registry],
  async collect() {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM auctions WHERE status='LIVE'`);
    this.set(rows[0].n);
  },
});
