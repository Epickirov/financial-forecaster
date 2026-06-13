import { json, getUser } from './_lib.js';

// GET /api/me -> { user } or { user: null } (200 either way, so boot can branch cleanly)
export async function onRequestGet(context) {
  const user = await getUser(context.env.DB, context.request);
  return json({ user: user || null });
}
