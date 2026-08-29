import { json, requireAuth, isApproved } from '../_utils.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  const { user } = await requireAuth(env, request);
  if (!user) return json({ error: 'Auth required' }, 401);
  if (!await isApproved(env, user)) return json({ error: 'Awaiting approval' }, 403);
  const url = new URL(request.url);

  if (request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const playlist_id = String(body.playlist_id || '');
    const track_id = String(body.track_id || '');
    if (!playlist_id || !track_id) return json({ error: 'playlist_id and track_id required' }, 400);
    const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id=?').bind(playlist_id).first();
    if (!pl) return json({ error: 'Playlist not found' }, 404);
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    const isAdmin = !!adminRow;
    if (pl.owner_id !== user.id && !isAdmin) return json({ error: 'Not allowed' }, 403);
    const exists = await env.DB.prepare('SELECT 1 FROM playlist_tracks WHERE playlist_id=? AND track_id=?').bind(playlist_id, track_id).first();
    if (exists) return json({ error: 'Already in playlist' }, 409);
    const maxRow = await env.DB.prepare('SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id=?').bind(playlist_id).first();
    const pos = (maxRow?.m ?? 0) + 1;
    await env.DB.prepare('INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES(?,?,?)').bind(playlist_id, track_id, pos).run();
    return json({ ok: true, position: pos });
  }

  if (request.method === 'DELETE') {
    const pid = url.searchParams.get('playlist_id');
    const tid = url.searchParams.get('track_id');
    if (!pid || !tid) return json({ error: 'playlist_id and track_id required' }, 400);
    const pl = await env.DB.prepare('SELECT * FROM playlists WHERE id=?').bind(pid).first();
    if (!pl) return json({ error: 'Not found' }, 404);
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    const isAdmin = !!adminRow;
    if (pl.owner_id !== user.id && !isAdmin) return json({ error: 'Not allowed' }, 403);
    await env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?').bind(pid, tid).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
