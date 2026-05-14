import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, Router } from "express";
import express from "express";
import { db } from "../db.js";
import { config } from "../config.js";

interface PendingConsent {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  scope: string | null;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
}

export function createPendingConsent(input: {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope?: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
}): string {
  const requestId = randomBytes(24).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO oauth_consents
     (request_id, client_id, redirect_uri, state, scope, code_challenge,
      code_challenge_method, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requestId,
    input.clientId,
    input.redirectUri,
    input.state ?? null,
    input.scope ?? null,
    input.codeChallenge,
    input.codeChallengeMethod ?? "S256",
    now + config.oauth.authCodeTtlSec,
    now,
  );
  return requestId;
}

function getPending(requestId: string): PendingConsent | null {
  const row = db
    .prepare("SELECT * FROM oauth_consents WHERE request_id = ?")
    .get(requestId) as PendingConsent | undefined;
  if (!row) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row;
}

function consumePending(requestId: string): PendingConsent | null {
  const pending = getPending(requestId);
  if (!pending) return null;
  db.prepare("DELETE FROM oauth_consents WHERE request_id = ?").run(requestId);
  return pending;
}

function getClientName(clientId: string): string {
  const row = db
    .prepare("SELECT client_name FROM oauth_clients WHERE client_id = ?")
    .get(clientId) as { client_name: string | null } | undefined;
  return row?.client_name ?? clientId;
}

function passwordValid(submitted: string): boolean {
  const a = Buffer.from(submitted, "utf8");
  const b = Buffer.from(config.oauth.masterPassword, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Issues an authorization code for the now-consented request and redirects back to the client. */
export function approveAndIssueCode(pending: PendingConsent): {
  redirectUrl: string;
  code: string;
} {
  const code = randomBytes(32).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO oauth_auth_codes
     (code, client_id, redirect_uri, code_challenge, code_challenge_method,
      scope, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    code,
    pending.client_id,
    pending.redirect_uri,
    pending.code_challenge,
    pending.code_challenge_method,
    pending.scope,
    now + config.oauth.authCodeTtlSec,
    now,
  );
  const url = new URL(pending.redirect_uri);
  url.searchParams.set("code", code);
  if (pending.state) url.searchParams.set("state", pending.state);
  return { redirectUrl: url.toString(), code };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderConsentPage(opts: {
  requestId: string;
  clientName: string;
  scope: string | null;
  error?: string;
}): string {
  const errBlock = opts.error
    ? `<div class="err">${escapeHtml(opts.error)}</div>`
    : "";
  const scopeBlock = opts.scope
    ? `<div class="row"><span class="lbl">Scope</span><span class="val">${escapeHtml(opts.scope)}</span></div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize BookStack access</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #f4f5f7; color: #1a1a1a;
      display: grid; place-items: center; min-height: 100vh; margin: 0;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #161618; color: #e6e6e6; }
      .card { background: #1f1f23; border-color: #2c2c33; }
      input { background: #2a2a30; color: #e6e6e6; border-color: #3a3a42; }
      .lbl { color: #888; }
    }
    .card {
      background: white; border: 1px solid #e3e5e8; border-radius: 12px;
      padding: 28px 32px; width: min(440px, calc(100% - 32px));
      box-shadow: 0 4px 24px rgba(0,0,0,.06);
    }
    h1 { font-size: 18px; margin: 0 0 6px; }
    .sub { color: #666; font-size: 13px; margin-bottom: 22px; }
    .row { display: flex; justify-content: space-between; padding: 8px 0; font-size: 14px; border-bottom: 1px solid rgba(128,128,128,.15); }
    .row:last-of-type { border-bottom: none; margin-bottom: 18px; }
    .lbl { color: #6b6b6b; }
    .val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    label { display: block; font-size: 13px; margin-bottom: 6px; color: #444; }
    @media (prefers-color-scheme: dark) { label { color: #aaa; } }
    input[type=password] {
      width: 100%; padding: 10px 12px; font-size: 14px;
      border: 1px solid #d4d6da; border-radius: 8px; background: #fafafa;
    }
    .actions { display: flex; gap: 10px; margin-top: 18px; }
    button {
      flex: 1; padding: 10px 14px; font-size: 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid transparent; font-weight: 500;
    }
    .primary { background: #2563eb; color: white; }
    .primary:hover { background: #1d4ed8; }
    .cancel { background: transparent; border-color: #d4d6da; color: inherit; }
    .err { background: #fee; color: #b00020; padding: 10px 12px; border-radius: 8px;
      font-size: 13px; margin-bottom: 14px; }
    @media (prefers-color-scheme: dark) { .err { background: #3a1a1c; color: #ff8a92; } }
    .foot { margin-top: 16px; font-size: 11px; color: #888; text-align: center; }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/oauth/consent">
    <input type="hidden" name="request_id" value="${escapeHtml(opts.requestId)}">
    <h1>Authorize BookStack access</h1>
    <p class="sub"><strong>${escapeHtml(opts.clientName)}</strong> is requesting access to your BookStack via this MCP server.</p>
    ${errBlock}
    <div class="row"><span class="lbl">Client</span><span class="val">${escapeHtml(opts.clientName)}</span></div>
    ${scopeBlock}
    <label for="pw">Master password</label>
    <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
    <div class="actions">
      <button type="button" class="cancel" onclick="history.back()">Cancel</button>
      <button type="submit" class="primary">Authorize</button>
    </div>
    <div class="foot">This server proxies BookStack with its own API token. No BookStack credentials are exchanged.</div>
  </form>
</body>
</html>`;
}

export function consentRouter(): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get("/oauth/consent/:requestId", (req: Request, res: Response) => {
    const requestId = req.params.requestId ?? "";
    const pending = requestId ? getPending(requestId) : null;
    if (!pending) {
      res.status(400).type("html").send(
        renderConsentPage({
          requestId: "",
          clientName: "(expired)",
          scope: null,
          error: "This authorization request has expired or is invalid. Please retry from your AI client.",
        }),
      );
      return;
    }
    res.type("html").send(
      renderConsentPage({
        requestId,
        clientName: getClientName(pending.client_id),
        scope: pending.scope,
      }),
    );
  });

  router.post("/oauth/consent", (req: Request, res: Response) => {
    const requestId = String(req.body?.request_id ?? "");
    const password = String(req.body?.password ?? "");

    const pending = getPending(requestId);
    if (!pending) {
      res.status(400).type("html").send(
        renderConsentPage({
          requestId: "",
          clientName: "(expired)",
          scope: null,
          error: "This authorization request has expired or is invalid.",
        }),
      );
      return;
    }

    if (!passwordValid(password)) {
      res.status(401).type("html").send(
        renderConsentPage({
          requestId,
          clientName: getClientName(pending.client_id),
          scope: pending.scope,
          error: "Incorrect password.",
        }),
      );
      return;
    }

    const consumed = consumePending(requestId);
    if (!consumed) {
      res.status(409).type("html").send("Consent already processed.");
      return;
    }
    const { redirectUrl } = approveAndIssueCode(consumed);
    res.redirect(302, redirectUrl);
  });

  return router;
}
