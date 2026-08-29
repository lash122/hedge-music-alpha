export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
export function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  };
}
export function uuid() {
  return crypto.randomUUID();
}
export async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashPassword(pass, salt = 'hedge-music-salt-v1') {
  return await sha256(salt + pass);
}
export function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
export function setCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (opts.httpOnly) s += '; HttpOnly';
  if (opts.secure) s += '; Secure';
  if (opts.maxAge) s += `; Max-Age=${opts.maxAge}`;
  return s;
}
export function parseAuth(req) {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return getCookie(req, 'hm_token') || null;
}
export async function getUserFromToken(env, token) {
  if (!token) return null;
  // Try KV first, fallback to DB
  try {
    if (env.SESSIONS) {
      const v = await env.SESSIONS.get('sess:' + token, 'json');
      if (v && v.user) return v.user;
    }
  } catch {}
  // DB fallback
  const row = await env.DB.prepare('SELECT token, user_id, expires_at FROM sessions WHERE token=?').bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const u = await env.DB.prepare('SELECT id, email, created_at FROM users WHERE id=?').bind(row.user_id).first();
  if (!u) return null;
  return u;
}
export async function isAdmin(env, user) {
  if (!user) return false;
  const r = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
  return !!r;
}
export async function isApproved(env, user) {
  if (!user) return false;
  if (await isAdmin(env, user)) return true;
  const r = await env.DB.prepare('SELECT 1 FROM approved_users WHERE user_id=?').bind(user.id).first();
  return !!r;
}
export async function requireAuth(env, req) {
  const token = parseAuth(req);
  const user = await getUserFromToken(env, token);
  return { token, user };
}
// Extract metadata without yt-dlp: oembed + noembed fallback (free, no ffmpeg)
export async function fetchMetadata(url) {
  // Try noembed (supports ~100 sites) then youtube oembed as fallback
  try {
    const r = await fetch('https://noembed.com/embed?url=' + encodeURIComponent(url), { cf: { cacheTtl: 3600 } });
    if (r.ok) {
      const j = await r.json();
      if (j.title) return { title: j.title.slice(0, 200), artist: (j.author_name || '').slice(0, 120), thumbnail: j.thumbnail_url || null, extractor: detectExtractor(url) };
    }
  } catch {}
  try {
    if (/youtube\.com|youtu\.be/.test(url)) {
      const r = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent(url) + '&format=json', { cf: { cacheTtl: 3600 } });
      if (r.ok) {
        const j = await r.json();
        return { title: j.title.slice(0, 200), artist: (j.author_name || '').slice(0, 120), thumbnail: j.thumbnail_url || null, extractor: 'youtube' };
      }
    }
  } catch {}
  // fallback: use URL itself
  return { title: url.slice(0, 80), artist: detectExtractor(url), thumbnail: null, extractor: detectExtractor(url) };
}
function detectExtractor(url) {
  try {
    const h = new URL(url).hostname;
    if (h.includes('youtube') || h.includes('youtu.be')) return 'youtube';
    if (h.includes('soundcloud')) return 'soundcloud';
    if (h.includes('bandcamp')) return 'bandcamp';
    if (h.includes('vimeo')) return 'vimeo';
    if (h.includes('tiktok')) return 'tiktok';
    return h.replace(/^www\./, '').split('.')[0].slice(0, 30) || 'unknown';
  } catch { return 'unknown'; }
}
