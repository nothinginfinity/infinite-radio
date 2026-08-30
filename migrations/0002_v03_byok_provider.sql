ALTER TABLE channel_policies ADD COLUMN generation_cap_per_day INTEGER NOT NULL DEFAULT 500 CHECK (generation_cap_per_day > 0);
ALTER TABLE channel_policies ADD COLUMN model TEXT NOT NULL DEFAULT 'fixture';

ALTER TABLE generations ADD COLUMN model TEXT;
ALTER TABLE generations ADD COLUMN error_code TEXT;

ALTER TABLE tracks ADD COLUMN model TEXT;
ALTER TABLE tracks ADD COLUMN content_type TEXT NOT NULL DEFAULT 'audio/wav';

ALTER TABLE provider_receipts ADD COLUMN model TEXT;
ALTER TABLE provider_receipts ADD COLUMN duration_seconds REAL;
ALTER TABLE provider_receipts ADD COLUMN cost_microusd INTEGER;
ALTER TABLE provider_receipts ADD COLUMN terms_uri TEXT;
