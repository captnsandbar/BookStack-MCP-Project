import { config } from "./config.js";

const AUTH_HEADER = `Token ${config.bookstack.authId}:${config.bookstack.authToken}`;

export interface BookstackRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path beneath the BookStack base URL, e.g. "api/pages/12". MUST start with "api/". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body. Omit for GET/DELETE. */
  json?: unknown;
  /** Form-data body (for file uploads — image_gallery, attachments, imports). */
  form?: FormData;
}

export interface BookstackResponse {
  status: number;
  ok: boolean;
  contentType: string;
  /** Parsed JSON body, or string/Buffer for non-JSON responses. */
  body: unknown;
}

/**
 * Low-level call against the BookStack REST API. Caller decides which endpoint to hit;
 * this just attaches credentials, serializes query/body, and parses the response.
 */
export async function bookstackRequest(req: BookstackRequest): Promise<BookstackResponse> {
  if (!req.path.startsWith("api/")) {
    throw new Error(`BookStack path must start with "api/", got: ${req.path}`);
  }
  const url = new URL(`${config.bookstack.url}/${req.path}`);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: AUTH_HEADER,
    Accept: "application/json",
  };
  const init: { method: string; headers: Record<string, string>; body?: FormData | string } = {
    method: req.method,
    headers,
  };
  if (req.form) {
    init.body = req.form;
  } else if (req.json !== undefined) {
    init.body = JSON.stringify(req.json);
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") ?? "";
  let parsed: unknown;
  if (ct.includes("application/json")) {
    parsed = await res.json();
  } else if (ct.startsWith("text/")) {
    parsed = await res.text();
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    parsed = buf;
  }
  return { status: res.status, ok: res.ok, contentType: ct, body: parsed };
}

/** Render a BookStack response as a single text payload suitable for an MCP tool result. */
export function renderResponse(r: BookstackResponse): string {
  if (Buffer.isBuffer(r.body)) {
    return `[binary ${r.contentType || "application/octet-stream"}, ${r.body.byteLength} bytes — use a dedicated export tool to retrieve]`;
  }
  if (typeof r.body === "string") return r.body;
  return JSON.stringify(r.body, null, 2);
}
