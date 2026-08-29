import { json, uuid, hashPassword, setCookie, getCookie, parseAuth, getUserFromToken, isAdmin, isApproved } from '../_utils.js';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' } });

  // POST /api/auth  {action: login|signup|logout}
  if (path.endsWith('/api/auth') || path.endsWith('/api/auth/')) {
    if (request.method === 'GET') {
      const token = parseAuth(request);
      const user = await getUserFromToken(env, token);
      if (!user) return json({ user: null });
      const admin = await isAdmin(env, user);
      const approved = await isApproved(env, user);
      return json({ user, isAdmin: admin, isApproved: approved });
    }
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const action = (body.action || '').toLowerCase();
      if (action === 'logout') {
        const token = parseAuth(request) || getCookie(request, 'hm_token');
        if (token) {
          try { await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run(); } catch {}
          try { if (env.SESSIONS) await env.SESSIONS.delete('sess:' + token); } catch {}
        }
        return json({ ok: true }, 200, { 'set-cookie': setCookie('hm_token', '', { httpOnly: true, maxAge: 0 }) });
      }
      const email = String(body.email || '').trim().toLowerCase();
      const pass = String(body.password || '');
      if (!email || !pass) return json({ error: 'Email and password required' }, 400);
      if (!email.includes('@')) return json({ error: 'Invalid email' }, 400);
      if (pass.length < 6) return json({ error: 'Password min 6 chars' }, 400);

      if (action === 'signup') {
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
        if (existing) return json({ error: 'Email already registered' }, 409);
        const id = uuid();
        const ph = await hashPassword(pass);
        await env.DB.prepare('INSERT INTO users(id,email,password_hash) VALUES(?,?,?)').bind(id, email, ph).run();
        // Auto-approve first user or all? mimic supabase-approval: insert into approved_users for all existing, new needs approval
        // For Cloudflare alpha, auto-approve everyone to keep simple and still allow admin approval gate if desired
        // Check if approved_users empty -> auto approve first user as admin candidate
        const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM approved_users').first();
        if (!cnt || cnt.c === 0) {
          try { await env.DB.prepare('INSERT OR IGNORE INTO approved_users(user_id) VALUES(?)').bind(id).run(); } catch {}
        }
        const token = uuid();
        const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').bind(token, id, exp).run();
        try { if (env.SESSIONS) await env.SESSIONS.put('sess:' + token, JSON.stringify({ user: { id, email } }), { expirationTtl: 30 * 24 * 3600 }); } catch {}
        return json({ user: { id, email } }, 200, { 'set-cookie': setCookie('hm_token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 }) });
      }
      // login
      const row = await env.DB.prepare('SELECT id,email,password_hash FROM users WHERE email=?').bind(email).first();
      if (!row) return json({ error: 'Invalid email or password' }, 401);
      const ph = await hashPassword(pass);
      if (ph !== row.password_hash) return json({ error: 'Invalid email or password' }, 401);
      const token = uuid();
      const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      await env.DB.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').bind(token, row.id, exp).run();
      try { if (env.SESSIONS) await env.SESSIONS.put('sess:' + token, JSON.stringify({ user: { id: row.id, email: row.email } }), { expirationTtl: 30 * 24 * 3600 }); } catch {}
      const admin = await isAdmin(env, { id: row.id });
      const approved = await isApproved(env, { id: row.id });
      return json({ user: { id: row.id, email: row.email }, isAdmin: admin, isApproved: approved }, 200, { 'set-cookie': setCookie('hm_token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 }) });
    }
  }
  return json({ error: 'Not found' }, 404);
}
