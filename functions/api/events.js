import { json, uuid, requireAuth } from '../_utils.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  const { user } = await requireAuth(env, request);
  if (request.method === 'POST') {
    if (!user) return json({ error: 'Auth required' }, 401);
    const body = await request.json().catch(() => ({}));
    const event = String(body.event || '');
    if (!['view', 'play', 'queue', 'search', 'playlist_add', 'queue_error'].includes(event)) return json({ error: 'Invalid event' }, 400);
    const track_id = body.track_id ? String(body.track_id) : null;
    const meta = body.meta ? JSON.stringify(body.meta).slice(0, 2000) : null;
    await env.DB.prepare('INSERT INTO track_events(id,track_id,user_id,event,meta) VALUES(?,?,?,?,?)').bind(uuid(), track_id, user.id, event, meta).run();
    return json({ ok: true });
  }
  if (request.method === 'GET') {
    if (!user) return json({ error: 'Auth required' }, 401);
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    if (!adminRow) return json({ error: 'Admin only' }, 403);
    const url = new URL(request.url);
    if (url.searchParams.get('stats') === '1') {
      const stats = await env.DB.prepare(`SELECT 
        (SELECT COUNT(*) FROM tracks) as tracks_total,
        (SELECT COUNT(*) FROM ingest_queue WHERE status='pending') as queue_pending,
        (SELECT COUNT(*) FROM ingest_queue WHERE status='error') as queue_errors,
        (SELECT COUNT(*) FROM playlists) as playlists_total,
        (SELECT COUNT(*) FROM track_events WHERE event='play') as plays_total,
        (SELECT COUNT(*) FROM track_events WHERE event='view') as views_total,
        (SELECT COUNT(*) FROM track_events WHERE event='queue') as queues_total`).first();
      return json(stats);
    }
    return json({ error: 'Use ?stats=1' }, 400);
  }
  return json({ error: 'Method not allowed' }, 405);
}
