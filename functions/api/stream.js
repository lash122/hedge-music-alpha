import { fetchDirectAudio } from '../_utils.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || url.pathname.split('/').pop();
  if (!id) return new Response('id required', { status: 400 });

  const track = await env.DB.prepare('SELECT * FROM tracks WHERE id=?').bind(id).first();
  if (!track) return new Response('Not found', { status: 404 });

  // 1. R2 first (direct .mp3 uploads + cached files)
  if (track.storage_path && env.R2) {
    try {
      const obj = await env.R2.get(track.storage_path);
      if (obj) {
        const headers = new Headers();
        headers.set('content-type', obj.httpMetadata?.contentType || 'audio/mpeg');
        headers.set('cache-control', 'public, max-age=3600');
        headers.set('accept-ranges', 'bytes');
        const range = request.headers.get('range');
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : obj.size - 1;
            const slice = await env.R2.get(track.storage_path, { range: { offset: start, length: end - start + 1 } });
            if (slice) {
              headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
              headers.set('content-length', String(end - start + 1));
              return new Response(slice.body, { status: 206, headers });
            }
          }
        }
        return new Response(obj.body, { headers });
      }
    } catch {}
  }

  // 2. direct_url (Piped proxy, combined mp4/audio) — 302 so the browser streams it directly.
  //    googlevideo/Piped URLs expire (~6h), so refresh on demand if stale (older than 3h) or dead.
  if (track.direct_url) {
    const fetchedAt = track.direct_url_fetched_at ? new Date(track.direct_url_fetched_at).getTime() : 0;
    const ageH = (Date.now() - fetchedAt) / 3600000;
    if (ageH < 3) {
      return new Response(null, { status: 302, headers: { location: track.direct_url, 'cache-control': 'no-store' } });
    }
    // stale -> re-resolve via Piped
    const fresh = await fetchDirectAudio(track.original_url);
    if (fresh?.directUrl) {
      try {
        await env.DB.prepare('UPDATE tracks SET direct_url=?, direct_url_fetched_at=? WHERE id=?')
          .bind(fresh.directUrl, new Date().toISOString(), track.id).run();
      } catch {}
      return new Response(null, { status: 302, headers: { location: fresh.directUrl, 'cache-control': 'no-store' } });
    }
    // re-resolve failed (all instances down?) -> serve stale rather than fail
    return new Response(null, { status: 302, headers: { location: track.direct_url, 'cache-control': 'no-store' } });
  }

  // 3. original_url as direct file (user queued an .mp3 link but R2 upload failed)
  if (track.original_url && /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(track.original_url)) {
    return new Response(null, { status: 302, headers: { location: track.original_url, 'cache-control': 'no-store' } });
  }

  // 4. nothing playable (metadata-only queue) — client shows a helpful toast
  return new Response(JSON.stringify({ error: 'No playable source', original_url: track.original_url }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
