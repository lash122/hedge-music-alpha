import { json, uuid, requireAuth, youtubeId } from '../_utils.js';

// POST /api/upload?original_url=...&title=...&artist=...&duration=...&extractor=...&extractor_id=...&thumbnail=...
// Body: raw audio bytes (audio/mpeg). Admin only. Streams to R2, upserts the D1 tracks row.
// - New track -> INSERT
// - Metadata-only track (queued earlier, embed playback) -> upgraded in place to a real MP3
export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const { user } = await requireAuth(env, request);
  if (!user) return json({ error: 'Auth required' }, 401);
  const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
  if (!adminRow) return json({ error: 'Admin only' }, 403);

  const url = new URL(request.url);
  const original_url = url.searchParams.get('original_url') || '';
  if (!original_url || !/^https?:\/\//i.test(original_url)) return json({ error: 'original_url (http/https) required' }, 400);
  if (original_url.length >= 2048) return json({ error: 'original_url too long' }, 400);

  const title = (url.searchParams.get('title') || 'Unknown').slice(0, 200);
  const artist = (url.searchParams.get('artist') || '').slice(0, 120);
  const thumbnail = url.searchParams.get('thumbnail') || null;
  const duration = parseInt(url.searchParams.get('duration') || '', 10) || null;
  const extractor = (url.searchParams.get('extractor') || 'youtube').slice(0, 30);
  let extractor_id = url.searchParams.get('extractor_id') || youtubeId(original_url) || uuid().slice(0, 8);
  extractor_id = String(extractor_id).slice(0, 80);

  // Size: rely on Content-Length (curl --data-binary @file and fetch both set it)
  const size = parseInt(request.headers.get('content-length') || '0', 10);
  if (!size || size > 100 * 1024 * 1024) return json({ error: 'Missing/oversized body (max 100MB)' }, 400);
  const ctype = request.headers.get('content-type') || '';
  if (ctype && !/^audio\/|^video\/|^application\/octet-stream/i.test(ctype)) return json({ error: 'Bad content-type (expect audio/*)' }, 400);

  // R2 key: flat <safe-id>.mp3 (same convention as the migrated library)
  const safe = extractor_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'track';
  const storage_path = `${safe}.mp3`;

  // Stream body straight into R2 (no buffering)
  try {
    await env.R2.put(storage_path, request.body, { httpMetadata: { contentType: 'audio/mpeg', cacheControl: 'public, max-age=31536000, immutable' } });
  } catch (e) {
    return json({ error: 'R2 upload failed: ' + String(e.message || e).slice(0, 200) }, 500);
  }

  // Upsert on original_url
  const existing = await env.DB.prepare('SELECT id FROM tracks WHERE original_url=?').bind(original_url).first();
  let trackId, upgraded = false;
  if (existing) {
    trackId = existing.id;
    await env.DB.prepare(
      'UPDATE tracks SET storage_path=?, file_size=?, duration_sec=COALESCE(?, duration_sec), title=?, artist=?, thumbnail_url=COALESCE(?, thumbnail_url), extractor=?, extractor_id=? WHERE id=?'
    ).bind(storage_path, size, duration, title, artist, thumbnail, extractor, extractor_id, trackId).run();
    upgraded = true;
  } else {
    trackId = uuid();
    await env.DB.prepare(
      'INSERT INTO tracks (id,original_url,extractor,extractor_id,title,artist,thumbnail_url,storage_path,duration_sec,file_size,owner_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'))'
    ).bind(trackId, original_url, extractor, extractor_id, title, artist, thumbnail, storage_path, duration, size, user.id).run();
  }
  return json({ ok: true, trackId, upgraded, storage_path, size });
}
