import { json, destroySession, clearCookie } from './_lib.js';

// POST /api/logout -> revokes the current session
export async function onRequestPost(context) {
  await destroySession(context.env.DB, context.request);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
