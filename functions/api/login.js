import { json, hashPassword, safeEqual, createSession, sessionCookie, validEmail } from './_lib.js';

// POST /api/login  { email, password } -> verifies + creates session
export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  let body;
  try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!validEmail(email) || !password) return json({ error: '邮箱或密码不正确' }, 401);

  const user = await db.prepare('SELECT id, email, pw_hash, pw_salt, pw_iter FROM users WHERE email = ?')
    .bind(email).first();
  // Always run the KDF (even on unknown email) to keep timing uniform.
  const { hash } = await hashPassword(password, user ? user.pw_salt : undefined, user ? user.pw_iter : undefined);
  if (!user || !safeEqual(hash, user.pw_hash)) return json({ error: '邮箱或密码不正确' }, 401);

  const { token, maxAge } = await createSession(db, user.id);
  return json({ user: { id: user.id, email: user.email } }, 200, { 'Set-Cookie': sessionCookie(token, maxAge) });
}
