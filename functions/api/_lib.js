// =====================================================================
// _lib.js — shared helpers for the auth + state API (Cloudflare Pages
// Functions, D1-backed). Underscore-prefixed so it is not itself routed.
// Runs on the Workers runtime: WebCrypto (crypto.subtle) + btoa/atob are
// globally available.
// =====================================================================
const enc = new TextEncoder();
const COOKIE = 'kmty_session';
const SESSION_DAYS = 30;
const PW_ITER = 100000;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// PBKDF2(SHA-256). Reuse the stored salt+iter on verify so the hash matches.
export async function hashPassword(password, saltB64, iter) {
  const iterations = iter || PW_ITER;
  const salt = saltB64 ? fromB64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return { hash: b64(bits), salt: b64(salt), iter: iterations };
}

// constant-time string compare (avoids leaking match length via timing)
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sessionCookie(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function readCookie(request) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}

// Mint a session, store only its hash. Returns the raw token for the cookie.
// expires_at is computed IN SQL so it has the same text format datetime('now')
// produces — mixing in an ISO-8601 string ('...T...Z') would make the string
// comparison in getUser off by up to a day.
export async function createSession(db, userId) {
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
    .bind(tokenHash, userId, `+${SESSION_DAYS} days`).run();
  return { token, maxAge: SESSION_DAYS * 86400 };
}

// Resolve the current user from the session cookie, or null.
export async function getUser(db, request) {
  const token = readCookie(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db.prepare(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
  ).bind(tokenHash).first();
  return row || null;
}

export async function destroySession(db, request) {
  const token = readCookie(request);
  if (!token) return;
  const tokenHash = await sha256Hex(token);
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export function validEmail(e) {
  return typeof e === 'string' && e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
}
