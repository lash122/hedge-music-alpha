import { json, uuid, requireAuth, isApproved } from '../_utils.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  const { user } = await requireAuth(env, request);
  const url = new URL(request.url);

  if (request.method === 'GET') {
    if (!user) return json([]);
    // playlists private per user, admin sees all
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    const isAdmin = !!adminRow;
    let results;
    if (url.searchParams.get('all') === '1' && isAdmin) {
      results = (await env.DB.prepare('SELECT * FROM playlists ORDER BY created_at').all()).results;
    } else {
      results = (await env.DB.prepare('SELECT * FROM playlists WHERE owner_id=? ORDER BY created_at').bind(user.id).all()).results;
    }
    const pts = isAdmin && url.searchParams.get('all') === '1'
      ? (await env.DB.prepare('SELECT * FROM playlist_tracks ORDER BY position').all()).results
      : (await env.DB.prepare('SELECT pt.* FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id WHERE p.owner_id=? ORDER BY pt.position').bind(user.id).all()).results;
    return json({ playlists: results || [], playlist_tracks: pts || [] });
  }

  if (request.method === 'POST') {
    if (!user) return json({ error: 'Log in required' }, 401);
    if (!await isApproved(env, user)) return json({ error: 'Awaiting approval' }, 403);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return json({ error: 'Name required' }, 400);
    if (name.length >= 100) return json({ error: 'Name too long' }, 400);
    const id = uuid();
    await env.DB.prepare('INSERT INTO playlists(id,name,owner_id) VALUES(?,?,?)').bind(id, name, user.id).run();
    return json({ id, name });
  }

  if (request.method === 'DELETE') {
    if (!user) return json({ error: 'Auth required' }, 401);
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id required' }, 400);
    const row = await env.DB.prepare('SELECT * FROM playlists WHERE id=?').bind(id).first();
    if (!row) return json({ error: 'Not found' }, 404);
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    const isAdmin = !!adminRow;
    if (row.owner_id !== user.id && !isAdmin) return json({ error: 'Not allowed' }, 403);
    await env.DB.prepare('DELETE FROM playlists WHERE id=?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
