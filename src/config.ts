// Env vars are loaded by Node's built-in `--env-file=.env` flag (see package.json scripts).
// No dotenv dependency needed on Node 24+.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

const port = Number(optional("LOCAL_SERVER_PORT", "3000"));
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`LOCAL_SERVER_PORT must be a valid TCP port, got: ${port}`);
}

const publicUrl = required("PUBLIC_URL").replace(/\/$/, "");

export const config = {
  bookstack: {
    url: required("BOOKSTACK_URL").replace(/\/$/, ""),
    authId: required("BOOKSTACK_AUTH_ID"),
    authToken: required("BOOKSTACK_AUTH_TOKEN"),
  },
  oauth: {
    jwtSecret: required("JWT_SECRET"),
    masterPassword: required("OAUTH_PW"),
    accessTokenTtlSec: 60 * 60, // 1h
    refreshTokenTtlSec: 60 * 60 * 24 * 30, // 30d
    authCodeTtlSec: 60 * 5, // 5m
  },
  server: {
    /** Bind address for the HTTP listener. Loopback-only — terminate TLS at the reverse proxy. */
    bindHost: "127.0.0.1",
    port,
    publicUrl,
    /** Used as `aud` claim on issued tokens (RFC 8707 audience binding). */
    resourceUri: `${publicUrl}/mcp`,
  },
  paths: {
    dbFile: optional("DB_FILE", "./bookstack-mcp.sqlite"),
  },
} as const;

export type AppConfig = typeof config;
