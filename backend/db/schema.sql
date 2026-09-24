-- Vortyx Pulse — PostgreSQL schema
-- Run this once against your Render Postgres database before starting the server.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ============ USERS ============
-- NOTE: signup/login is being built separately. This table is the minimum
-- the backend needs to exist alongside whatever auth system is wired up.
-- If your auth system already has its own users table, either point this
-- schema at it or keep this table in sync via a shared user id.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  google_id TEXT UNIQUE,      -- Google's "sub" claim — how we recognize returning users
  name TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free', -- 'free' | '3mo' | 'annual' | 'perm'
  plan_expires_at TIMESTAMPTZ,       -- null for 'perm' and unset free accounts use created_at+30d
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Token quota tracking (see config/plans.js for the actual limits per plan)
  tokens_used_this_period INT NOT NULL DEFAULT 0,
  period_reset_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);

-- Safe to re-run: adds the quota columns if this table already existed
-- from before Phase 1 (e.g. a fresh Supabase import of an old dump).
ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_used_this_period INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS period_reset_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days');

-- ============ API KEYS ============
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,      -- e.g. vp_live_a1B2c3D4 (safe to display)
  key_hash TEXT NOT NULL,        -- sha256 of the full key; full key is only ever shown once
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ============ PAYMENTS ============
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,            -- '3mo' | 'annual' | 'perm'
  amount_usd NUMERIC(10,2) NOT NULL,
  method TEXT NOT NULL,          -- 'card' | 'USDT' | 'BTC' | 'LTC' | 'ETH'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'rejected'
  tx_reference TEXT,             -- crypto tx hash or Stripe payment intent id
  confirmed_by UUID REFERENCES users(id), -- admin who confirmed it
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);

-- ============ REPORTS ============
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- ============ CONVERSATIONS (website chat) ============
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

-- ============ USAGE (optional, for the Usage dashboard tab) ============
CREATE TABLE IF NOT EXISTS request_logs (
  id BIGSERIAL PRIMARY KEY,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE CASCADE, -- null for website-chat requests
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  modality TEXT NOT NULL, -- 'text' | 'audio' | 'video'
  source TEXT NOT NULL DEFAULT 'api', -- 'api' | 'web'
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_request_logs_user_date ON request_logs(user_id, created_at);

-- Safe to re-run: relax api_key_id to nullable + add source column if this
-- table already existed from before website chat was added.
ALTER TABLE request_logs ALTER COLUMN api_key_id DROP NOT NULL;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'api';
