import { json, uuid, requireAuth, isApproved } from '../_utils.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  const url = new URL(request.url);
  const { user } = await requireAuth(env, request);

  // Global shared: all authenticated + approved can read all tracks (like supabase-global-shared)
  if (request.method === 'GET') {
    if (!user) return json({ error: 'Auth required' }, 401);
    const approved = await isApproved(env, user);
    if (!approved) return json({ error: 'Awaiting approval' }, 403);
    const { results } = await env.DB.prepare('SELECT * FROM tracks ORDER BY created_at DESC LIMIT 500').all();
    return json(results || []);
  }
  if (request.method === 'DELETE') {
    if (!user) return json({ error: 'Auth required' }, 401);
    // only admin or owner can delete (like admin delete)
    const trackId = url.searchParams.get('id');
    if (!trackId) return json({ error: 'id required' }, 400);
    const track = await env.DB.prepare('SELECT * FROM tracks WHERE id=?').bind(trackId).first();
    if (!track) return json({ error: 'Not found' }, 404);
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    const isAdmin = !!adminRow;
    if (track.owner_id !== user.id && !isAdmin) return json({ error: 'Not allowed' }, 403);
    // delete R2 file
    try { if (track.storage_path && env.R2) await env.R2.delete(track.storage_path); } catch {}
    try { await env.DB.prepare('DELETE FROM playlist_tracks WHERE track_id=?').bind(trackId).run(); } catch {}
    try { await env.DB.prepare('DELETE FROM track_events WHERE track_id=?').bind(trackId).run(); } catch {}
    await env.DB.prepare('DELETE FROM tracks WHERE id=?').bind(trackId).run();
    return json({ ok: true });
  }
  return json({ error: 'Method not allowed' }, 405);
}
