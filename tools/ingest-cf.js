#!/usr/bin/env node
/**
 * ingest-cf.js — plan S2 (laptop mode) against the Cloudflare app.
 * Same idea as the old Supabase ingest.js: poll pending, yt-dlp -x mp3, POST /api/upload.
 * Admin-only endpoint; logs in with ADMIN_EMAIL/ADMIN_PASSWORD from tools/.env (gitignored).
 *
 * Usage:
 *   node ingest-cf.js --check     verify deps + login + endpoint reachability
 *   node ingest-cf.js --once      process all pending once
 *   node ingest-cf.js --watch     poll every 30s
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env loader (no deps)
try {
  const envPath = join(__dirname, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const SITE = (process.env.SITE_URL || 'https://hedge-music-alpha.pages.dev').replace(/\/+$/, '');
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const FFPROBE = process.env.FFMPEG_PATH || 'ffprobe';
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const QUALITY = process.env.AUDIO_QUALITY || '0';

const args = process.argv.slice(2);
const WATCH = args.includes('--watch');
const ONCE = args.includes('--once') || args.length === 0;
const CHECK = args.includes('--check');

const log = (m) => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const err = (m) => console.error(`[ERR] ${m}`);

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { ...opts });
    let out = '', errout = '';
    p.stdout?.on('data', d => out += d);
    p.stderr?.on('data', d => errout += d);
    p.on('close', code => code === 0 ? resolve({ out, errout }) : reject(new Error(`${cmd} exit ${code}: ${errout.slice(0, 500)}`)));
    p.on('error', reject);
  });
}

let SESSION_COOKIE = null;

async function login() {
  const r = await fetch(`${SITE}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'login', email: EMAIL, password: PASSWORD }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/hm_token=([^;]+)/);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !m) throw new Error(`login failed: ${j.error || r.status}`);
  SESSION_COOKIE = `hm_token=${m[1]}`;
  if (j.isAdmin !== true) err('WARNING: account is NOT admin — /api/upload will 403');
  return j;
}

async function apiGet(path) {
  const r = await fetch(SITE + path, { headers: { cookie: SESSION_COOKIE } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function apiPostJson(path, payload) {
  const r = await fetch(SITE + path, {
    method: 'POST',
    headers: { cookie: SESSION_COOKIE, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function apiUploadFile(file, meta) {
  const buf = await readFile(file);
  const q = new URLSearchParams({
    original_url: meta.original_url,
    title: (meta.title || 'Unknown').slice(0, 200),
    artist: (meta.artist || '').slice(0, 120),
    thumbnail: (meta.thumbnail || '').slice(0, 500),
    duration: String(meta.duration || ''),
    extractor: (meta.extractor || 'youtube').slice(0, 30),
    extractor_id: String(meta.extractor_id || '').slice(0, 80),
  });
  const r = await fetch(`${SITE}/api/upload?${q}`, {
    method: 'POST',
    headers: { cookie: SESSION_COOKIE, 'content-type': 'audio/mpeg', 'content-length': String(buf.length) },
    body: buf,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function getMetadata(url) {
  const { out } = await run(YT_DLP, ['--print-json', '--no-download', '--no-playlist', '--no-warnings', url]);
  return JSON.parse(out.trim().split('\n')[0]);
}
function probeDuration(file) {
  return run(FFPROBE, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    .then(({ out }) => Math.round(parseFloat(out.trim()) || 0) || null)
    .catch(() => null);
}

let busy = false;
async function processQueue() {
  if (busy) return;
  busy = true;
  try {
    const { queue, upgrade } = await apiGet('/api/ingest-pending');
    const jobs = [
      ...queue.map(q => ({ original_url: q.original_url, queue_id: q.id })),
      ...upgrade.map(t => ({ original_url: t.original_url, queue_id: null })),
    ].slice(0, 10);
    if (!jobs.length) { log('nothing pending'); return; }
    log(`${jobs.length} job(s) — yt-dlp ${QUALITY} quality`);

    const tmp = join(__dirname, 'tmp');
    mkdirSync(tmp, { recursive: true });

    for (const job of jobs) {
      log(`\n→ ${job.original_url}`);
      let mp3Path = null;
      try {
        const meta = await getMetadata(job.original_url);
        const base = join(tmp, `ing-${Date.now()}`);
        await run(YT_DLP, ['-x', '--audio-format', 'mp3', '--audio-quality', QUALITY,
          '--no-playlist', '--no-warnings', '-o', `${base}.%(ext)s`, job.original_url]);
        mp3Path = `${base}.mp3`;
        if (!existsSync(mp3Path)) {
          const cands = readdirSync(tmp).filter(f => f.startsWith('ing-') && f.endsWith('.mp3'))
            .map(f => join(tmp, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
          mp3Path = cands[0] || null;
          if (!mp3Path) throw new Error('mp3 not produced');
        }
        const size = statSync(mp3Path).size;
        if (size > 95 * 1024 * 1024) throw new Error(`file too large: ${size}`);
        const duration = await probeDuration(mp3Path);
        const up = await apiUploadFile(mp3Path, {
          original_url: job.original_url,
          title: meta.title, artist: meta.artist || meta.uploader || meta.channel || '',
          thumbnail: meta.thumbnail || meta.thumbnails?.at(-1)?.url || '',
          duration: duration || meta.duration, extractor: meta.extractor,
          extractor_id: meta.id,
        });
        log(`  ✓ ${up.upgraded ? 'upgraded existing' : 'added'}: ${(meta.title || '').slice(0, 60)} (${(size / 1048576).toFixed(1)}MB)`);
        if (job.queue_id) await apiPostJson('/api/ingest-pending', { queue_id: job.queue_id, status: 'done' });
      } catch (e) {
        err(`  ✗ ${String(e.message || e).slice(0, 300)}`);
        if (job.queue_id) {
          try { await apiPostJson('/api/ingest-pending', { queue_id: job.queue_id, status: 'error', error: String(e.message || e).slice(0, 300) }); } catch {}
        }
      } finally {
        if (mp3Path) { try { unlinkSync(mp3Path); } catch {} }
      }
    }
  } catch (e) {
    err(String(e.message || e));
  } finally {
    busy = false;
  }
}

async function main() {
  if (!EMAIL || !PASSWORD) { err('set ADMIN_EMAIL / ADMIN_PASSWORD in tools/.env (copy from .env.example)'); process.exit(1); }
  try { await run(YT_DLP, ['--version']); } catch { err(`yt-dlp not found (${YT_DLP}) — pip install yt-dlp`); process.exit(1); }
  try { await run(FFPROBE, ['-version']); } catch { err(`ffprobe not found (${FFPROBE}) — install ffmpeg`); process.exit(1); }
  const me = await login();
  log(`logged in as ${me.user?.email} (admin: ${!!me.isAdmin}) — site: ${SITE}`);
  if (CHECK) { log('checks pass'); return; }
  if (WATCH) { log(`watching every ${POLL_MS / 1000}s`); await processQueue(); setInterval(processQueue, POLL_MS); }
  else { await processQueue(); }
}

main().catch(e => { err(e.stack || e.message); process.exit(1); });
