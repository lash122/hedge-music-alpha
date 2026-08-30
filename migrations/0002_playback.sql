-- Playback fix: direct audio URL extraction (cobalt instances)
-- Run in D1 Console (safe to ignore "duplicate column" if run twice)
ALTER TABLE tracks ADD COLUMN direct_url TEXT;
ALTER TABLE tracks ADD COLUMN direct_url_fetched_at TEXT;
