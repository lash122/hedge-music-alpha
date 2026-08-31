import { json, requireAuth } from '../_utils.js';

// GET /api/ingest-pending
// Admin-only. Returns everything the GitHub Actions runner (or laptop script) needs to process:
// 1. queue: ingest_queue rows still 'pending' (queued from the phone)
// 2. upgrade: tracks with metadata only (no R2 file yet, embed playback) worth converting
// POST /api/ingest-pending {queue_id, track_id, status, error}
//   -> marks a queue row done/error (admin only). Idempotent.
export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });

  const { user } = await requireAuth(env, request);
  if (!user) return json({ error: 'Auth required' }, 401);
  const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
  if (!adminRow) return json({ error: 'Admin only' }, 403);

  if (request.method === 'GET') {
    const queue = await env.DB.prepare(
      "SELECT id, original_url, extractor, created_at FROM ingest_queue WHERE status='pending' ORDER BY created_at ASC LIMIT 50"
    ).all();
    const upgrade = await env.DB.prepare(
      "SELECT id, original_url, extractor, title, extractor_id FROM tracks WHERE (file_size IS NULL OR file_size = 0) AND extractor IN ('youtube','soundcloud','bandcamp') AND original_url LIKE 'http%' ORDER BY created_at ASC LIMIT 50"
    ).all();
    return json({ queue: queue.results || [], upgrade: upgrade.results || [] });
  }

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const qid = String(body.queue_id || '');
    const status = String(body.status || '');
    if (!qid || !['done', 'error', 'processing'].includes(status)) return json({ error: 'queue_id + status(done|error|processing) required' }, 400);
    const error = String(body.error || '').slice(0, 500) || null;
    await env.DB.prepare('UPDATE ingest_queue SET status=?, error=? WHERE id=?').bind(status, error, qid).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
