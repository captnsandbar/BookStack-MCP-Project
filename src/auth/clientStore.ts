import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { db } from "../db.js";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function row2client(row: Record<string, unknown>): OAuthClientInformationFull {
  return JSON.parse(row.client_metadata as string) as OAuthClientInformationFull;
}

export const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId) {
    const row = db
      .prepare("SELECT client_metadata FROM oauth_clients WHERE client_id = ?")
      .get(clientId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return row2client(row);
  },

  registerClient(metadata) {
    const clientId = `mcp_${randomBytes(12).toString("base64url")}`;
    const authMethod = metadata.token_endpoint_auth_method ?? "none";

    let clientSecret: string | undefined;
    let secretHash: string | null = null;
    if (authMethod !== "none") {
      clientSecret = randomBytes(32).toString("base64url");
      secretHash = hashSecret(clientSecret);
    }

    const full: OAuthClientInformationFull = {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    };

    db.prepare(
      `INSERT INTO oauth_clients
       (client_id, client_secret_hash, client_name, redirect_uris, grant_types,
        response_types, scope, token_endpoint_auth_method, client_metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      clientId,
      secretHash,
      metadata.client_name ?? null,
      JSON.stringify(metadata.redirect_uris),
      JSON.stringify(metadata.grant_types ?? ["authorization_code", "refresh_token"]),
      JSON.stringify(metadata.response_types ?? ["code"]),
      metadata.scope ?? null,
      authMethod,
      JSON.stringify(full),
      Math.floor(Date.now() / 1000),
    );
    return full;
  },
};

/** Validate a client_secret against the stored hash in constant time. */
export function verifyClientSecret(clientId: string, presentedSecret: string): boolean {
  const row = db
    .prepare("SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?")
    .get(clientId) as { client_secret_hash: string | null } | undefined;
  if (!row || !row.client_secret_hash) return false;
  const a = Buffer.from(row.client_secret_hash, "hex");
  const b = Buffer.from(hashSecret(presentedSecret), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
