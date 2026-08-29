import { json, uuid, requireAuth, isApproved, fetchMetadata } from '../_utils.js';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });
  const url = new URL(request.url);
  const { user } = await requireAuth(env, request);

  if (request.method === 'GET') {
    if (!user) return json([]);
    // admin sees all, others see own (like hybrid private queue)
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    const isAdmin = !!adminRow;
    let results;
    if (isAdmin) {
      results = (await env.DB.prepare('SELECT * FROM ingest_queue ORDER BY created_at DESC LIMIT 50').all()).results;
    } else {
      results = (await env.DB.prepare('SELECT * FROM ingest_queue WHERE owner_id=? ORDER BY created_at DESC LIMIT 50').bind(user.id).all()).results;
    }
    return json(results || []);
  }

  if (request.method === 'POST') {
    if (!user) return json({ error: 'Log in to queue' }, 401);
    if (!await isApproved(env, user)) return json({ error: 'Awaiting approval' }, 403);
    const body = await request.json().catch(() => ({}));
    let original_url = String(body.original_url || body.url || '').trim();
    if (!original_url) return json({ error: 'URL required' }, 400);
    if (original_url.length >= 2048) return json({ error: 'URL too long' }, 400);
    try { new URL(original_url); } catch { return json({ error: 'Invalid URL' }, 400); }
    if (!/^https?:\/\//i.test(original_url)) return json({ error: 'URL must start https://' }, 400);

    const id = uuid();
    // Insert pending
    await env.DB.prepare('INSERT INTO ingest_queue(id,original_url,status,owner_id) VALUES(?,?,?,?)').bind(id, original_url, 'pending', user.id).run();

    // Immediate ingest — no laptop, Cloudflare does it
    // This is the key difference: queue -> done in same request
    try {
      await env.DB.prepare('UPDATE ingest_queue SET status=? WHERE id=?').bind('processing', id).run();
      const meta = await fetchMetadata(original_url);
      const extractor = meta.extractor || 'unknown';
      const extractor_id = original_url.slice(0, 80); // simple dedup key
      // dedup check
      const dup = await env.DB.prepare('SELECT id FROM tracks WHERE original_url=?').bind(original_url).first();
      if (dup) {
        await env.DB.prepare('UPDATE ingest_queue SET status=?, extractor=?, extractor_id=? WHERE id=?').bind('done', extractor, extractor_id, id).run();
        return json({ ok: true, queueId: id, trackId: dup.id, dedup: true, status: 'done' });
      }
      // Try to fetch actual audio and store in R2 (no ffmpeg, store as original)
      let storage_path = `${user.id}/${extractor}-${id.slice(0, 8)}.mp3`;
      let file_size = null;
      let duration_sec = null;
      let thumb = meta.thumbnail;
      // For YouTube: we can't fetch googlevideo without yt-dlp, so store placeholder and use oembed thumb
      // For R2 demo: create a tiny placeholder if R2 available, or skip upload and store metadata only
      // Attempt to fetch audio stream if URL is direct mp3
      if (/\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(original_url)) {
        try {
          const r = await fetch(original_url);
          if (r.ok) {
            const buf = await r.arrayBuffer();
            file_size = buf.byteLength;
            if (file_size < 100 * 1024 * 1024 && env.R2) {
              await env.R2.put(storage_path, buf, { httpMetadata: { contentType: r.headers.get('content-type') || 'audio/mpeg' } });
            }
          }
        } catch {}
      } else {
        // No direct file: store without R2 object, playback will use /api/stream proxy that returns original URL
        // Keep storage_path as logical key, no R2 object needed for MVP
        file_size = null;
      }
      const title = meta.title || 'Unknown';
      const artist = meta.artist || '';
      const trackId = uuid();
      await env.DB.prepare('INSERT INTO tracks(id,original_url,extractor,extractor_id,title,artist,thumbnail_url,storage_path,duration_sec,file_size,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .bind(trackId, original_url, extractor, extractor_id, title, artist, thumb, storage_path, duration_sec, file_size, user.id).run();
      await env.DB.prepare('UPDATE ingest_queue SET status=?, extractor=?, extractor_id=? WHERE id=?').bind('done', extractor, extractor_id, id).run();
      // analytics queue event
      try { await env.DB.prepare('INSERT INTO track_events(id,track_id,user_id,event,meta) VALUES(?,?,?,?,?)').bind(uuid(), trackId, user.id, 'queue', JSON.stringify({ url: original_url.slice(0, 120) })).run(); } catch {}
      return json({ ok: true, queueId: id, trackId, status: 'done', title });
    } catch (e) {
      const msg = String(e.message || e).slice(0, 500);
      await env.DB.prepare('UPDATE ingest_queue SET status=?, error=? WHERE id=?').bind('error', msg, id).run();
      try { await env.DB.prepare('INSERT INTO track_events(id,user_id,event,meta) VALUES(?,?,?,?)').bind(uuid(), user.id, 'queue_error', JSON.stringify({ url: original_url.slice(0, 80), error: msg.slice(0, 120) })).run(); } catch {}
      return json({ error: msg, queueId: id, status: 'error' }, 500);
    }
  }

  if (request.method === 'DELETE') {
    if (!user) return json({ error: 'Auth required' }, 401);
    const qid = url.searchParams.get('id');
    if (!qid) return json({ error: 'id required' }, 400);
    const row = await env.DB.prepare('SELECT * FROM ingest_queue WHERE id=?').bind(qid).first();
    if (!row) return json({ error: 'Not found' }, 404);
    const adminRow = await env.DB.prepare('SELECT 1 FROM admin_users WHERE user_id=?').bind(user.id).first();
    const isAdmin = !!adminRow;
    if (row.owner_id !== user.id && !isAdmin) return json({ error: 'Not allowed' }, 403);
    if (row.status !== 'pending' && !isAdmin) return json({ error: 'Only pending can be deleted' }, 400);
    await env.DB.prepare('DELETE FROM ingest_queue WHERE id=?').bind(qid).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
