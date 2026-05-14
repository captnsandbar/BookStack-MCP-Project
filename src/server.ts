import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { config } from "./config.js";
import { purgeExpired } from "./db.js";
import { oauthProvider } from "./auth/provider.js";
import { consentRouter } from "./auth/consent.js";
import { registerTools } from "./tools.js";
import { CATALOG } from "./catalog.js";

// ─────────────────────────── MCP server ───────────────────────────
const mcp = new McpServer(
  { name: "bookstack-mcp", version: "0.1.0" },
  {
    instructions:
      "BookStack wiki access. Start with `bookstack_search` to locate content by keyword. " +
      "For known IDs use `pages_read` / `books_read` / `chapters_read`. " +
      "Use `pages_create` / `pages_update` for authoring. " +
      "For anything not covered by dedicated tools (users, roles, shelves, attachments, " +
      "comments, permissions, recycle-bin, audit-log, imports) call `search_actions` first, " +
      "then `execute_action`.",
  },
);
registerTools(mcp);

// ─────────────────────────── Express app ───────────────────────────
const app = express();
app.disable("x-powered-by");

// Trust the reverse proxy so req.protocol/host reflect public-facing values.
app.set("trust proxy", true);

// Health check (no auth) — useful for proxy/uptime monitors.
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    catalog_size: CATALOG.length,
    public_url: config.server.publicUrl,
  });
});

// OAuth: /authorize, /token, /register, /revoke, and well-known metadata docs.
// Advertises CIMD support automatically and provides DCR via /register.
const publicUrlObj = new URL(config.server.publicUrl);
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: publicUrlObj,
    baseUrl: publicUrlObj,
    scopesSupported: ["bookstack:read", "bookstack:write"],
    resourceName: "BookStack MCP",
    resourceServerUrl: new URL(config.server.resourceUri),
  }),
);

// Consent screen — bridges /authorize -> /token by collecting OAUTH_PW.
app.use(consentRouter());

// ─────────────────────────── /mcp endpoint (bearer-auth protected) ───────────────────────────
const bearer = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: `${config.server.publicUrl}/.well-known/oauth-protected-resource`,
});

app.post("/mcp", express.json(), bearer, async (req: Request, res: Response) => {
  // Stateless: fresh transport per request — fine for an API-wrapper server.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => { /* ignore */ });
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] request failed:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message: (e as Error).message });
    }
  }
});

// Reject GET/DELETE on /mcp explicitly so clients get a clear error rather than 404.
app.all("/mcp", (req: Request, res: Response) => {
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  }
});

// ─────────────────────────── Boot ───────────────────────────
const sweeper = setInterval(purgeExpired, 60_000);
sweeper.unref();

app.listen(config.server.port, config.server.bindHost, () => {
  console.log(
    `[bookstack-mcp] listening on http://${config.server.bindHost}:${config.server.port}`,
  );
  console.log(`[bookstack-mcp] public URL: ${config.server.publicUrl}`);
  console.log(`[bookstack-mcp] MCP endpoint: ${config.server.resourceUri}`);
  console.log(`[bookstack-mcp] catalog: ${CATALOG.length} BookStack actions loaded`);
});

function shutdown(sig: string): void {
  console.log(`[bookstack-mcp] received ${sig}, shutting down`);
  clearInterval(sweeper);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
