import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";

export interface AccessTokenClaims {
  /** subject: the client ID this token was issued to. */
  sub: string;
  /** issuer: this server's public URL. */
  iss: string;
  /** audience: resource URI (the /mcp endpoint). */
  aud: string;
  /** scope string (space-separated). */
  scope?: string;
  /** unique token ID, used for revocation lookups. */
  jti: string;
  /** token type — "access" or "refresh". */
  typ: "access" | "refresh";
  exp: number;
  iat: number;
}

export function newJti(): string {
  return randomBytes(16).toString("base64url");
}

export function signAccessToken(opts: {
  clientId: string;
  scope?: string;
  ttlSec?: number;
}): { token: string; jti: string; expiresAt: number } {
  const jti = newJti();
  const ttl = opts.ttlSec ?? config.oauth.accessTokenTtlSec;
  const claims: AccessTokenClaims = {
    sub: opts.clientId,
    iss: config.server.publicUrl,
    aud: config.server.resourceUri,
    scope: opts.scope,
    jti,
    typ: "access",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const token = jwt.sign(claims, config.oauth.jwtSecret, { algorithm: "HS256" });
  return { token, jti, expiresAt: claims.exp };
}

export function signRefreshToken(opts: {
  clientId: string;
  scope?: string;
  ttlSec?: number;
}): { token: string; jti: string; expiresAt: number } {
  const jti = newJti();
  const ttl = opts.ttlSec ?? config.oauth.refreshTokenTtlSec;
  const claims: AccessTokenClaims = {
    sub: opts.clientId,
    iss: config.server.publicUrl,
    aud: config.server.resourceUri,
    scope: opts.scope,
    jti,
    typ: "refresh",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const token = jwt.sign(claims, config.oauth.jwtSecret, { algorithm: "HS256" });
  return { token, jti, expiresAt: claims.exp };
}

export function verifyToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, config.oauth.jwtSecret, {
    algorithms: ["HS256"],
    audience: config.server.resourceUri,
    issuer: config.server.publicUrl,
  });
  if (typeof decoded === "string") {
    throw new Error("Invalid token payload");
  }
  return decoded as AccessTokenClaims;
}
