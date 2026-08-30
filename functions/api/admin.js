import { json, requireAuth } from '../_utils.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  const { user } = await requireAuth(env, request);
  if (!user) return json({ error: 'Auth required' }, 401);
  const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
  const isAdmin = !!adminRow;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // BOOTSTRAP: first-ever user claims admin before the gate blocks them.
  // Only allowed when NO admin exists yet, so it can never be abused later.
  if (action === 'seed_admin' && request.method === 'POST') {
    if (isAdmin) return json({ ok: true, already: true });
    const anyAdmin = await env.DB.prepare('SELECT 1 FROM admin_users LIMIT 1').first();
    if (anyAdmin) return json({ error: 'An admin already exists' }, 403);
    await env.DB.prepare('INSERT OR IGNORE INTO admin_users(user_id) VALUES(?)').bind(user.id).run();
    await env.DB.prepare('INSERT OR IGNORE INTO approved_users(user_id) VALUES(?)').bind(user.id).run();
    return json({ ok: true });
  }

  if (!isAdmin) return json({ error: 'Admin only' }, 403);

  if (action === 'is_admin') return json({ isAdmin: true });
  if (action === 'pending') {
    const { results } = await env.DB.prepare(`SELECT u.id, u.email, u.created_at FROM users u LEFT JOIN approved_users a ON a.user_id=u.id LEFT JOIN admin_users ad ON ad.user_id=u.id WHERE a.user_id IS NULL AND ad.user_id IS NULL ORDER BY u.created_at DESC`).all();
    return json(results || []);
  }
  if (action === 'approve' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const uid = String(body.user_id || '');
    if (!uid) return json({ error: 'user_id required' }, 400);
    await env.DB.prepare('INSERT OR IGNORE INTO approved_users(user_id,approved_by) VALUES(?,?)').bind(uid, user.id).run();
    return json({ ok: true });
  }
  if (action === 'stats') {
    const stats = await env.DB.prepare(`SELECT 
      (SELECT COUNT(*) FROM tracks) as tracks_total,
      (SELECT COUNT(*) FROM ingest_queue WHERE status='pending') as queue_pending,
      (SELECT COUNT(*) FROM ingest_queue WHERE status='error') as queue_errors,
      (SELECT COUNT(*) FROM ingest_queue WHERE status='done') as queue_done,
      (SELECT COUNT(*) FROM playlists) as playlists_total,
      (SELECT COUNT(*) FROM track_events WHERE event='play') as plays_total,
      (SELECT COUNT(*) FROM track_events WHERE event='view') as views_total,
      (SELECT COUNT(*) FROM track_events WHERE event='queue') as queues_total`).first();
    return json(stats);
  }
  if (action === 'leaderboard') {
    const { results } = await env.DB.prepare(`SELECT t.id, t.title, t.artist, t.extractor, t.storage_path, t.created_at,
      (SELECT COUNT(*) FROM track_events e WHERE e.track_id=t.id AND e.event='play') as plays,
      (SELECT COUNT(*) FROM track_events e WHERE e.track_id=t.id AND e.event='view') as views,
      (SELECT COUNT(*) FROM track_events e WHERE e.track_id=t.id AND e.event='queue') as queues
      FROM tracks t ORDER BY plays DESC LIMIT 20`).all();
    return json(results || []);
  }
  if (action === 'events') {
    const { results } = await env.DB.prepare(`SELECT e.created_at, e.event, e.track_id, u.email, t.title FROM track_events e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN tracks t ON t.id=e.track_id ORDER BY e.created_at DESC LIMIT 30`).all();
    return json(results || []);
  }
  if (action === 'queue') {
    const { results } = await env.DB.prepare('SELECT original_url,status,error,created_at FROM ingest_queue ORDER BY created_at DESC LIMIT 20').all();
    return json(results || []);
  }

  return json({ error: 'Unknown action' }, 400);
}
