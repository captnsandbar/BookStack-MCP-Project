import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, "../Docs/BookStack_API.json");

export interface CatalogEntry {
  id: string;                 // e.g. "pages-list"
  group: string;              // e.g. "pages"
  method: "GET" | "POST" | "PUT" | "DELETE";
  uri: string;                // e.g. "api/pages/{id}"
  description: string;
  bodyParams: Record<string, string[]> | null;
  /** Path parameter names parsed from the URI template ("{id}", "{contentType}"). */
  pathParams: string[];
  exampleRequest: string | null;
  exampleResponse: string | null;
}

interface SpecEntry {
  name: string;
  uri: string;
  method: string;
  description: string;
  body_params: Record<string, string[]> | null;
  example_request: string | null;
  example_response: string | null;
}

function loadCatalog(): CatalogEntry[] {
  const raw = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as Record<string, SpecEntry[]>;
  const out: CatalogEntry[] = [];
  for (const [group, entries] of Object.entries(raw)) {
    for (const e of entries) {
      const pathParams: string[] = [];
      const re = /\{([^}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(e.uri)) !== null) pathParams.push(m[1]!);
      out.push({
        id: e.name,
        group,
        method: e.method as CatalogEntry["method"],
        uri: e.uri,
        description: e.description ?? "",
        bodyParams: e.body_params,
        pathParams,
        exampleRequest: e.example_request,
        exampleResponse: e.example_response,
      });
    }
  }
  return out;
}

export const CATALOG: readonly CatalogEntry[] = Object.freeze(loadCatalog());
const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

export function getAction(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/**
 * Simple keyword ranking over name + group + description. Fast, deterministic,
 * no embedding dependency. Good enough as a discovery tool when paired with
 * Claude's own re-ranking by reading the descriptions.
 */
export function rankActions(intent: string, limit = 10): CatalogEntry[] {
  const tokens = intent
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return CATALOG.slice(0, limit);

  const scored = CATALOG.map((e) => {
    const hay = `${e.id} ${e.group} ${e.description}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (e.id.toLowerCase().includes(t)) score += 4;
      if (e.group.toLowerCase() === t) score += 3;
      if (hay.includes(t)) score += 1;
    }
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.e);
}

/**
 * Substitute {placeholders} in the URI with values from params, removing them from
 * the remaining param set. Returns the resolved path + leftover params (used for
 * query strings on GET/DELETE, body on POST/PUT).
 */
export function resolvePath(
  entry: CatalogEntry,
  params: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const rest = { ...params };
  let path = entry.uri;
  for (const p of entry.pathParams) {
    if (rest[p] === undefined || rest[p] === null || rest[p] === "") {
      throw new Error(`Missing required path parameter "${p}" for action ${entry.id}`);
    }
    path = path.replace(`{${p}}`, encodeURIComponent(String(rest[p])));
    delete rest[p];
  }
  return { path, rest };
}
