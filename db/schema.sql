CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'BUYER' CHECK (role IN ('BUYER','ADMIN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  make TEXT NOT NULL, model TEXT NOT NULL, year INT NOT NULL, km INT NOT NULL,
  image_url TEXT,
  description TEXT,
  start_price_cents BIGINT NOT NULL CHECK (start_price_cents > 0),
  reserve_price_cents BIGINT,
  min_increment_cents BIGINT NOT NULL DEFAULT 10000 CHECK (min_increment_cents > 0),
  current_price_cents BIGINT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED'
    CHECK (status IN ('SCHEDULED','LIVE','SOLD','UNSOLD','CANCELLED')),
  winner_id UUID REFERENCES users(id),
  bid_count INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS auctions_status_ends ON auctions(status, ends_at);
CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  amount_cents BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS bids_auction_amount ON bids(auction_id, amount_cents DESC);
