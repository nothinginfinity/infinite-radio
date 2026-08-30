PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS creators (
  creator_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  channel_id TEXT PRIMARY KEY,
  owner_creator_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_creator_id) REFERENCES creators(creator_id)
);

CREATE TABLE IF NOT EXISTS memberships (
  channel_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, creator_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  FOREIGN KEY (creator_id) REFERENCES creators(creator_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_policies (
  channel_id TEXT PRIMARY KEY,
  buffer_target_seconds INTEGER NOT NULL DEFAULT 90 CHECK (buffer_target_seconds > 0),
  generation_cap_per_hour INTEGER NOT NULL DEFAULT 120 CHECK (generation_cap_per_hour > 0),
  provider TEXT NOT NULL DEFAULT 'fixture',
  credential_ref TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prompts (
  prompt_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  votes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (channel_id, idempotency_key),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS prompts_channel_created_idx ON prompts(channel_id, created_at);

CREATE TABLE IF NOT EXISTS generations (
  generation_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  prompt_id TEXT,
  idempotency_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, idempotency_key),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS generations_channel_status_idx ON generations(channel_id, status, created_at);

CREATE TABLE IF NOT EXISTS tracks (
  track_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  generation_id TEXT,
  asset_key TEXT NOT NULL,
  duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (channel_id, asset_key),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS tracks_channel_created_idx ON tracks(channel_id, created_at);

CREATE TABLE IF NOT EXISTS votes (
  channel_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, prompt_id, voter_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  FOREIGN KEY (prompt_id) REFERENCES prompts(prompt_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS provider_receipts (
  receipt_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_request_id TEXT,
  latency_ms INTEGER,
  cost_atomic INTEGER,
  provenance_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id) REFERENCES generations(generation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS provider_receipts_channel_idx ON provider_receipts(channel_id, created_at);
