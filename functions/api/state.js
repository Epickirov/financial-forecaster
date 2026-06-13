import { json, getUser } from './_lib.js';

const MAX_BYTES = 2_000_000; // ~2MB guard on a single workspace blob

// GET /api/state -> { state } (the user's saved workspace, or null if none yet)
export async function onRequestGet(context) {
  const { env, request } = context;
  const user = await getUser(env.DB, request);
  if (!user) return json({ error: '未登录' }, 401);
  const row = await env.DB.prepare('SELECT json FROM app_state WHERE user_id = ?').bind(user.id).first();
  let state = null;
  if (row) { try { state = JSON.parse(row.json); } catch { state = null; } }
  return json({ state });
}

// PUT /api/state  { state } -> upserts the user's workspace
export async function onRequestPut(context) {
  const { env, request } = context;
  const user = await getUser(env.DB, request);
  if (!user) return json({ error: '未登录' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求格式错误' }, 400); }
  const state = body && body.state;
  if (state == null || typeof state !== 'object' || Array.isArray(state)) return json({ error: '状态无效' }, 400);

  const str = JSON.stringify(state);
  if (str.length > MAX_BYTES) return json({ error: '数据过大' }, 413);

  await env.DB.prepare(
    `INSERT INTO app_state (user_id, json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = datetime('now')`
  ).bind(user.id, str).run();
  return json({ ok: true });
}
