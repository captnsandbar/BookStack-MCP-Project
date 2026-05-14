import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

const db = new DatabaseSync(config.paths.dbFile);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id            TEXT PRIMARY KEY,
    client_secret_hash   TEXT,                  -- NULL for public clients (PKCE only)
    client_name          TEXT,
    redirect_uris        TEXT NOT NULL,         -- JSON array
    grant_types          TEXT NOT NULL,         -- JSON array
    response_types       TEXT NOT NULL,         -- JSON array
    scope                TEXT,
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
    client_metadata      TEXT NOT NULL,         -- full registration JSON
    created_at           INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code                 TEXT PRIMARY KEY,
    client_id            TEXT NOT NULL,
    redirect_uri         TEXT NOT NULL,
    code_challenge       TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL DEFAULT 'S256',
    scope                TEXT,
    expires_at           INTEGER NOT NULL,
    created_at           INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires
    ON oauth_auth_codes(expires_at);

  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_id             TEXT PRIMARY KEY,      -- jti claim of the refresh JWT
    client_id            TEXT NOT NULL,
    scope                TEXT,
    expires_at           INTEGER NOT NULL,
    revoked              INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client
    ON oauth_refresh_tokens(client_id);

  CREATE TABLE IF NOT EXISTS oauth_consents (
    /** Pending authorization request awaiting password approval. */
    request_id           TEXT PRIMARY KEY,
    client_id            TEXT NOT NULL,
    redirect_uri         TEXT NOT NULL,
    state                TEXT,
    scope                TEXT,
    code_challenge       TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL DEFAULT 'S256',
    expires_at           INTEGER NOT NULL,
    created_at           INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS oauth_consents_expires
    ON oauth_consents(expires_at);

  CREATE TABLE IF NOT EXISTS oauth_access_revocations (
    /** Holds revoked access-token jti's until their natural expiry. */
    token_id             TEXT PRIMARY KEY,
    expires_at           INTEGER NOT NULL
  );
`);

/** Sweep expired rows. Called on a timer from server.ts. */
export function purgeExpired(): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM oauth_auth_codes WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM oauth_consents WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM oauth_access_revocations WHERE expires_at < ?").run(now);
  db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at < ? OR revoked = 1").run(now);
}

export { db };
