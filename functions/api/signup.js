import { json, hashPassword, createSession, sessionCookie, validEmail } from './_lib.js';

// POST /api/signup  { email, password } -> creates account + session
export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  let body;
  try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!validEmail(email)) return json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 8) return json({ error: '密码至少需要 8 位' }, 400);

  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ error: '该邮箱已被注册' }, 409);

  const { hash, salt, iter } = await hashPassword(password);
  const res = await db.prepare('INSERT INTO users (email, pw_hash, pw_salt, pw_iter) VALUES (?, ?, ?, ?)')
    .bind(email, hash, salt, iter).run();
  const userId = res.meta.last_row_id;

  const { token, maxAge } = await createSession(db, userId);
  return json({ user: { id: userId, email } }, 200, { 'Set-Cookie': sessionCookie(token, maxAge) });
}
