import type { Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { clientsStore } from "./clientStore.js";
import { createPendingConsent } from "./consent.js";
import { signAccessToken, signRefreshToken, verifyToken } from "./jwt.js";
import { config } from "../config.js";
import { db } from "../db.js";

interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  expires_at: number;
}

interface RefreshTokenRow {
  token_id: string;
  client_id: string;
  scope: string | null;
  expires_at: number;
  revoked: 0 | 1;
}

function issueTokenPair(clientId: string, scope: string | undefined): OAuthTokens {
  const access = signAccessToken({ clientId, scope });
  const refresh = signRefreshToken({ clientId, scope });
  db.prepare(
    `INSERT INTO oauth_refresh_tokens (token_id, client_id, scope, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(refresh.jti, clientId, scope ?? null, refresh.expiresAt, Math.floor(Date.now() / 1000));

  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: access.expiresAt - Math.floor(Date.now() / 1000),
    refresh_token: refresh.token,
    ...(scope ? { scope } : {}),
  };
}

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Stash the pending request and bounce the user to our consent page.
    // After password approval, /oauth/consent handler redirects back to
    // params.redirectUri with the issued code + state.
    const requestId = createPendingConsent({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      scope: params.scopes?.join(" "),
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
    });
    res.redirect(302, `${config.server.publicUrl}/oauth/consent/${requestId}`);
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const row = db
      .prepare("SELECT code_challenge FROM oauth_auth_codes WHERE code = ?")
      .get(authorizationCode) as { code_challenge: string } | undefined;
    if (!row) throw new Error("invalid_grant: unknown authorization code");
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const row = db
      .prepare("SELECT * FROM oauth_auth_codes WHERE code = ?")
      .get(authorizationCode) as AuthCodeRow | undefined;
    if (!row) throw new Error("invalid_grant: unknown authorization code");

    // One-shot: delete immediately to prevent replay.
    db.prepare("DELETE FROM oauth_auth_codes WHERE code = ?").run(authorizationCode);

    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      throw new Error("invalid_grant: authorization code expired");
    }
    if (row.client_id !== client.client_id) {
      throw new Error("invalid_grant: code/client mismatch");
    }
    if (redirectUri && redirectUri !== row.redirect_uri) {
      throw new Error("invalid_grant: redirect_uri mismatch");
    }
    return issueTokenPair(row.client_id, row.scope ?? undefined);
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    let claims;
    try {
      claims = verifyToken(refreshToken);
    } catch {
      throw new Error("invalid_grant: refresh token invalid or expired");
    }
    if (claims.typ !== "refresh") throw new Error("invalid_grant: not a refresh token");
    if (claims.sub !== client.client_id) throw new Error("invalid_grant: client mismatch");

    const row = db
      .prepare("SELECT * FROM oauth_refresh_tokens WHERE token_id = ?")
      .get(claims.jti) as RefreshTokenRow | undefined;
    if (!row) throw new Error("invalid_grant: refresh token unknown");
    if (row.revoked) throw new Error("invalid_grant: refresh token revoked");

    // Rotate the refresh token (revoke the old jti).
    db.prepare("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_id = ?").run(claims.jti);

    const scope = scopes?.length ? scopes.join(" ") : (row.scope ?? undefined);
    return issueTokenPair(row.client_id, scope);
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims;
    try {
      claims = verifyToken(token);
    } catch (err) {
      throw new Error(`invalid_token: ${(err as Error).message}`);
    }
    if (claims.typ !== "access") throw new Error("invalid_token: wrong token type");

    // Check revocation list.
    const revoked = db
      .prepare("SELECT 1 FROM oauth_access_revocations WHERE token_id = ?")
      .get(claims.jti);
    if (revoked) throw new Error("invalid_token: revoked");

    return {
      token,
      clientId: claims.sub,
      scopes: claims.scope ? claims.scope.split(/\s+/) : [],
      expiresAt: claims.exp,
      resource: new URL(config.server.resourceUri),
    };
  },

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    let claims;
    try {
      claims = verifyToken(request.token);
    } catch {
      return; // RFC 7009: invalid tokens silently succeed
    }
    if (claims.sub !== client.client_id) return;

    if (claims.typ === "refresh") {
      db.prepare("UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_id = ?").run(claims.jti);
    } else {
      db.prepare(
        "INSERT OR REPLACE INTO oauth_access_revocations (token_id, expires_at) VALUES (?, ?)",
      ).run(claims.jti, claims.exp);
    }
  },
};
