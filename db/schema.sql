-- =====================================================================
-- kmty-forecaster-db — schema for auth + per-user state
-- Apply locally:  npx wrangler d1 execute kmty-forecaster-db --local  --file=db/schema.sql
-- Apply remote:   npx wrangler d1 execute kmty-forecaster-db --remote --file=db/schema.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL UNIQUE,
  pw_hash    TEXT    NOT NULL,            -- PBKDF2-derived key, base64
  pw_salt    TEXT    NOT NULL,            -- random salt, base64
  pw_iter    INTEGER NOT NULL,            -- PBKDF2 iteration count (for forward-compat)
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,         -- SHA-256 of the opaque session token (token itself never stored)
  user_id    INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT    NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS app_state (
  user_id    INTEGER PRIMARY KEY,         -- one workspace blob per user
  json       TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
