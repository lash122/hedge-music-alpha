-- Hedge Music Alpha — D1 (SQLite) schema
-- Port of supabase-music.sql + hybrid + private + approval + analytics
-- Cloudflare Free: D1 5GB, no RLS — auth enforced in Workers

-- Users (replaces auth.users)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, -- uuid
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, -- sha256(salt+pass) simple, or bcrypt via Worker
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Admin allowlist
CREATE TABLE IF NOT EXISTS admin_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Approved users (manual approval gate)
CREATE TABLE IF NOT EXISTS approved_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Tracks (global shared, private bucket via R2)
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY, -- uuid
  original_url TEXT UNIQUE NOT NULL,
  extractor TEXT,
  extractor_id TEXT,
  title TEXT NOT NULL,
  artist TEXT,
  thumbnail_url TEXT,
  storage_path TEXT NOT NULL, -- r2 key: <owner_id>/<extractor>-<id>.mp3 or placeholder
  duration_sec INTEGER,
  file_size INTEGER, -- bigint
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tracks_extractor ON tracks(extractor, extractor_id);
CREATE INDEX IF NOT EXISTS idx_tracks_created ON tracks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracks_owner ON tracks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tracks_owner_created ON tracks(owner_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_storage_path ON tracks(storage_path);

-- Ingest queue (pending -> done/error, auto-processed by Worker, no laptop)
CREATE TABLE IF NOT EXISTS ingest_queue (
  id TEXT PRIMARY KEY,
  original_url TEXT NOT NULL CHECK(length(original_url) < 2048 AND original_url LIKE 'http%'),
  extractor TEXT,
  extractor_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','error')),
  error TEXT,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON ingest_queue(status, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_owner_status ON ingest_queue(owner_id, status, created_at DESC);

-- Playlists (private per user, global view for admin)
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) > 0 AND length(name) < 100),
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists(owner_id);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);

-- Analytics
CREATE TABLE IF NOT EXISTS track_events (
  id TEXT PRIMARY KEY,
  track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event TEXT NOT NULL CHECK(event IN ('view','play','queue','search','playlist_add','queue_error')),
  meta TEXT, -- JSON string
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_track_time ON track_events(track_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_event_time ON track_events(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON track_events(user_id, created_at DESC);

-- Sessions (KV-backed, but keep table as fallback for free without KV)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
