# Hedge Music Alpha — Cloudflare Free Tier (No Laptop)

Cloned from `lash122/hedge-music` and rewritten for **Cloudflare only** (Pages + D1 + R2 + KV). No Supabase, no Netlify, no laptop ingest.

## What changed

| Before (Supabase + laptop) | After (Cloudflare free) |
|---|---|
| `tools/ingest.js` polling `yt-dlp -x --audio-format mp3` + `ffmpeg` | `functions/api/queue.js` ingests instantly via `noembed.com/oembed` (no ffmpeg, no laptop). `pending → done` in one request |
| Supabase Postgres + `supabase-*.sql` + RLS | D1 SQLite `migrations/0001_initial.sql` (free 5GB, 5M reads/day) |
| Supabase Storage `tracks` bucket (1GB) | R2 `hedge-music-tracks` (free 10GB, no egress) + `/api/stream?id=` Range support |
| Supabase Auth + `auth.users` + `is_admin` | D1 `users` + `sessions` + KV `SESSIONS` + httpOnly `hm_token` cookie |
| `supabase-js@2` CDN + realtime `channel` | Pure `fetch` + polling every 10s (Workers free has no WebSocket) |
| `sw.js` Supabase bypass | `sw.js` `/api/` bypass + cache `tracks-v1` for offline |
| `netlify.toml` | `wrangler.toml` + `functions/api/*.js` |
| `music.js` Supabase | `music.js` Cloudflare (`music.supabase.js` kept as backup) |
| `admin.html` Supabase | `admin.html` Cloudflare (Make me admin button, no SQL) |

**No laptop needed:** phone queues → Worker creates `tracks` row immediately. No `node tools/ingest.js --watch`.

## Quick start (Cloudflare)

```bash
# 1. Install Wrangler
npm i -g wrangler

# 2. Create resources (once)
wrangler d1 create hedge-music-alpha-db
wrangler r2 bucket create hedge-music-tracks
wrangler kv namespace create SESSIONS
# put returned database_id / bucket names into wrangler.toml

# 3. Apply schema
wrangler d1 execute hedge-music-alpha-db --file=./migrations/0001_initial.sql

# 4. Dev (Pages + Functions)
wrangler pages dev . --d1=DB --r2=R2 --kv=SESSIONS
# open http://localhost:8788/music.html

# 5. Deploy (free)
wrangler pages deploy . --project-name=hedge-music-alpha
# or git push -> Cloudflare Pages auto-deploy (Build command: none, Publish dir: .)
```

Set env in Pages Dashboard → Settings → Variables: none required (D1/R2/KV are bindings).

## Auth flow

- Sign up → row in `users` + auto `approved_users` if first user
- Log in → `sessions` row + `hm_token` httpOnly cookie (30d)
- Admin → `admin_users` table; click **Make me admin** in `admin.html` (or `INSERT INTO admin_users` via `wrangler d1 execute`)
- Approval gate → `isApproved()` checks `admin_users` OR `approved_users`; unapproved sees `Awaiting approval`

## Ingest flow (no laptop)

1. `music.html` → `POST /api/queue {original_url}` (auth required)
2. Worker → `fetchMetadata()` via `https://noembed.com/embed?url=` (and youtube oembed fallback)
3. Worker → `INSERT INTO tracks` + `UPDATE ingest_queue status=done`
4. PWA → `GET /api/tracks` shows it instantly; polls `loadQueue()` every 10s for badge

If URL is direct `*.mp3`, Worker fetches and PUTs to R2. Otherwise `storage_path` is logical key and `/api/stream?id=` serves placeholder (original_url fallback until real R2 object). Swap to real `yt-dlp` by deploying a tiny Fly.io worker and calling it from `queue.js` if you need 1800-site transcoding.

## Files

- `wrangler.toml` — Pages + D1/R2/KV
- `migrations/0001_initial.sql` — D1 schema (port of all supabase-*.sql)
- `functions/_utils.js` — auth/hash/metadata helpers
- `functions/api/auth.js` — login/signup/logout/check
- `functions/api/tracks.js` — list/delete (owner/admin)
- `functions/api/queue.js` — queue + immediate ingest (replaces tools/ingest.js)
- `functions/api/playlists.js` / `playlist-tracks.js` — private playlists
- `functions/api/stream.js` — R2 Range + fallback
- `functions/api/events.js` / `admin.js` — analytics + admin dashboard
- `music.js` — Cloudflare client (backup at `music.supabase.js`)
- `music.html` / `index.html` / `admin.html` — no Supabase CDN
- `sw.js` — Cloudflare-aware cache
- `tools/` — kept but not needed (laptop ingest legacy)

## Limits (free tier)

- Workers 100k req/day, 10ms CPU — ingest uses `fetch` I/O, not CPU
- D1 5GB, 5M reads/day, 100k writes/day
- R2 10GB storage, 10M reads/mo
- KV 1GB, 100k reads/day (sessions fallback to D1 if KV missing)

## Revert to Supabase

Restore `music.supabase.js` → `music.js`, restore `admin.supabase.html` → `admin.html`, and point `index.html` `script` back to Supabase CDN.
