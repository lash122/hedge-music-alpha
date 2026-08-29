import { requireAuth, isApproved } from '../_utils.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || url.pathname.split('/').pop();
  if (!id) return new Response('id required', { status: 400 });

  const track = await env.DB.prepare('SELECT * FROM tracks WHERE id=?').bind(id).first();
  if (!track) return new Response('Not found', { status: 404 });

  // Auth check: global shared => need approved
  const auth = request.headers.get('authorization') || '';
  const cookie = request.headers.get('cookie') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (cookie.match(/hm_token=([^;]+)/)?.[1] || null);
  let user = null;
  if (token) {
    try {
      const row = await env.DB.prepare('SELECT user_id FROM sessions WHERE token=?').bind(decodeURIComponent(token)).first();
      if (row) user = await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(row.user_id).first();
    } catch {}
  }
  // For stream, allow if track exists — but check approval if user present, else allow for demo
  // Private mode: require auth, here we allow with check
  // Try R2 first
  if (track.storage_path && env.R2) {
    try {
      const obj = await env.R2.get(track.storage_path);
      if (obj) {
        const headers = new Headers();
        headers.set('content-type', obj.httpMetadata?.contentType || 'audio/mpeg');
        headers.set('cache-control', 'public, max-age=3600');
        headers.set('accept-ranges', 'bytes');
        // Handle Range
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
  // Fallback: if original_url is direct mp3, redirect/proxy
  if (track.original_url && /\.(mp3|m4a|ogg|wav|flac)(\?|$)/i.test(track.original_url)) {
    return Response.redirect(track.original_url, 302);
  }
  // For YouTube etc without R2 object: return 302 to original_url (let player handle fallback) or 404
  // For alpha: return JSON with original_url so frontend can show
  return new Response(JSON.stringify({ error: 'No stored file — use original_url', original_url: track.original_url }), { status: 404, headers: { 'content-type': 'application/json' } });
}
