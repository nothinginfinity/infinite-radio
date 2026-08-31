-- Durable canonical structured-composition library.
--
-- Every accepted infinite-radio-score-v1 composition (Workers AI or
-- deterministic fixture, after passing schema validation and the musical
-- temporal-coverage quality gate) is persisted here as immutable score JSON.
-- This is the first-class music artifact for V0.4 -- no rendered WAV is
-- required or stored for this slice; the browser WebAudio renderer replays
-- score_json directly.
--
-- score_json is never overwritten once written (writes use
-- ON CONFLICT DO NOTHING keyed on composition_id), so replaying the same
-- composition can never mutate history. Only the lifecycle `status` /
-- `selected_at` columns are updated as a composition moves from buffered to
-- selected, so buffered-but-never-heard material stays distinguishable from
-- material that actually became the current station composition.

CREATE TABLE IF NOT EXISTS compositions (
  composition_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  creator_id TEXT,
  schema_version TEXT NOT NULL,
  score_json TEXT NOT NULL,
  composer TEXT,
  model TEXT,
  bpm REAL NOT NULL,
  key_root TEXT,
  key_mode TEXT,
  bars INTEGER NOT NULL,
  duration_seconds REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'buffered' CHECK (status IN ('buffered', 'selected')),
  created_at TEXT NOT NULL,
  selected_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS compositions_channel_created_idx
  ON compositions(channel_id, created_at DESC);
