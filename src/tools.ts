import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bookstackRequest, renderResponse } from "./bookstack.js";
import { CATALOG, getAction, rankActions, resolvePath } from "./catalog.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a BookStack call so HTTP errors come back as MCP tool errors, not exceptions. */
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; json?: unknown } = {},
): Promise<ToolResult> {
  try {
    const res = await bookstackRequest({ method, path, ...opts });
    if (!res.ok) {
      return err(
        `BookStack ${method} ${path} -> HTTP ${res.status}\n${renderResponse(res)}`,
      );
    }
    return ok(renderResponse(res));
  } catch (e) {
    return err(`BookStack ${method} ${path} failed: ${(e as Error).message}`);
  }
}

export function registerTools(server: McpServer): void {
  // ───────────────────────── Search ─────────────────────────
  server.registerTool(
    "bookstack_search",
    {
      description:
        "Search across the entire BookStack instance (pages, chapters, books, shelves). " +
        "Use BookStack's filter syntax for advanced queries (e.g. `{type:page} {tag:api}`). " +
        "Returns matches with id, type, name, url, and a preview snippet. Start here when you don't know an entity ID.",
      inputSchema: {
        query: z.string().min(1).describe(
          "Search keywords. Supports filters like `{type:page}`, `{tag:Name}`, `{name:fragment}`.",
        ),
        page: z.number().int().min(1).max(100).default(1).describe("1-indexed page number."),
        count: z.number().int().min(1).max(100).default(20).describe("Results per page (max 100)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, page, count }) =>
      call("GET", "api/search", { query: { query, page, count } }),
  );

  // ───────────────────────── Pages ─────────────────────────
  server.registerTool(
    "pages_list",
    {
      description:
        "List pages visible to the API user. Returns metadata only (no body). " +
        "Use `bookstack_search` instead if you need full-text matching.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        count: z.number().int().min(1).max(500).default(50),
        filter_book_id: z.number().int().optional().describe("Limit to pages in this book."),
        filter_chapter_id: z.number().int().optional().describe("Limit to pages in this chapter."),
        sort: z.enum([
          "name", "-name", "priority", "-priority", "created_at", "-created_at",
          "updated_at", "-updated_at",
        ]).default("-updated_at"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ offset, count, filter_book_id, filter_chapter_id, sort }) => {
      const query: Record<string, string | number | boolean | undefined> = {
        offset, count, sort,
      };
      if (filter_book_id !== undefined) query["filter[book_id]"] = filter_book_id;
      if (filter_chapter_id !== undefined) query["filter[chapter_id]"] = filter_chapter_id;
      return call("GET", "api/pages", { query });
    },
  );

  server.registerTool(
    "pages_read",
    {
      description:
        "Fetch a single page including its rendered HTML, raw HTML, markdown (if applicable), " +
        "tags, and comment tree. Use `pages_export` instead if you only want one format.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => call("GET", `api/pages/${id}`),
  );

  server.registerTool(
    "pages_create",
    {
      description:
        "Create a new page. Must provide either `book_id` or `chapter_id` (target). " +
        "Provide content as either `html` or `markdown` — not both.",
      inputSchema: {
        name: z.string().min(1).max(255),
        book_id: z.number().int().optional().describe("Required if chapter_id is not set."),
        chapter_id: z.number().int().optional().describe("Required if book_id is not set."),
        html: z.string().optional().describe("Page body as HTML. Mutually exclusive with markdown."),
        markdown: z.string().optional().describe("Page body as Markdown. Mutually exclusive with html."),
        tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        priority: z.number().int().optional(),
      },
      annotations: { openWorldHint: true },
    },
    async (input) => {
      if (!input.book_id && !input.chapter_id) {
        return err("pages_create requires either book_id or chapter_id.");
      }
      if (!input.html && !input.markdown) {
        return err("pages_create requires either html or markdown content.");
      }
      return call("POST", "api/pages", { json: input });
    },
  );

  server.registerTool(
    "pages_update",
    {
      description:
        "Update a page's name, content, parent, tags, or priority. Only include fields you want " +
        "to change. Setting `book_id`/`chapter_id` moves the page to a new parent.",
      inputSchema: {
        id: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        book_id: z.number().int().optional(),
        chapter_id: z.number().int().optional(),
        html: z.string().optional(),
        markdown: z.string().optional(),
        tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        priority: z.number().int().optional(),
      },
      annotations: { openWorldHint: true, idempotentHint: true },
    },
    async ({ id, ...body }) => call("PUT", `api/pages/${id}`, { json: body }),
  );

  server.registerTool(
    "pages_delete",
    {
      description:
        "Send a page to the recycle bin. Recoverable via the recycle-bin actions until purged.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ id }) => call("DELETE", `api/pages/${id}`),
  );

  server.registerTool(
    "pages_export",
    {
      description:
        "Export a page in a text format. Use `pages_read` if you need both HTML and Markdown, " +
        "metadata, and comments — this tool just returns the raw export bytes.",
      inputSchema: {
        id: z.number().int().positive(),
        format: z.enum(["html", "markdown", "plaintext"]).describe(
          "Output format. PDF and ZIP exports are intentionally omitted — they're binary blobs.",
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id, format }) => call("GET", `api/pages/${id}/export/${format}`),
  );

  // ───────────────────────── Books / Chapters ─────────────────────────
  server.registerTool(
    "books_list",
    {
      description: "List all books visible to the API user. Metadata only.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        count: z.number().int().min(1).max(500).default(50),
        sort: z.enum([
          "name", "-name", "created_at", "-created_at", "updated_at", "-updated_at",
        ]).default("-updated_at"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ offset, count, sort }) =>
      call("GET", "api/books", { query: { offset, count, sort } }),
  );

  server.registerTool(
    "books_read",
    {
      description:
        "Fetch a book including its full chapter+page tree. Use this to discover what " +
        "lives inside a book without separate pages_list / chapters_list calls.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => call("GET", `api/books/${id}`),
  );

  server.registerTool(
    "chapters_list",
    {
      description: "List chapters, optionally filtered by parent book.",
      inputSchema: {
        offset: z.number().int().min(0).default(0),
        count: z.number().int().min(1).max(500).default(50),
        filter_book_id: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ offset, count, filter_book_id }) => {
      const query: Record<string, string | number | boolean | undefined> = { offset, count };
      if (filter_book_id !== undefined) query["filter[book_id]"] = filter_book_id;
      return call("GET", "api/chapters", { query });
    },
  );

  server.registerTool(
    "chapters_read",
    {
      description: "Fetch a chapter with its child page list.",
      inputSchema: { id: z.number().int().positive() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => call("GET", `api/chapters/${id}`),
  );

  // ───────────────────────── Image upload ─────────────────────────
  server.registerTool(
    "image_gallery_upload",
    {
      description:
        "Upload an image to the BookStack gallery. Provide the image as base64. " +
        "Returns the image record (including `url`) which you can then reference in page HTML.",
      inputSchema: {
        name: z.string().min(1).describe("Filename, e.g. 'diagram.png'."),
        type: z.enum(["gallery", "drawio"]).default("gallery"),
        uploaded_to: z.number().int().positive().describe(
          "ID of the page this image belongs to.",
        ),
        data_base64: z.string().min(1).describe("Image bytes encoded as base64."),
        mime_type: z.string().default("image/png").describe(
          "MIME type, e.g. image/png, image/jpeg, image/webp.",
        ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ name, type, uploaded_to, data_base64, mime_type }) => {
      const form = new FormData();
      form.append("type", type);
      form.append("uploaded_to", String(uploaded_to));
      form.append("name", name);
      const bytes = Buffer.from(data_base64, "base64");
      form.append("image", new Blob([bytes], { type: mime_type }), name);
      try {
        const res = await bookstackRequest({ method: "POST", path: "api/image-gallery", form });
        return res.ok ? ok(renderResponse(res))
                      : err(`Image upload failed: HTTP ${res.status}\n${renderResponse(res)}`);
      } catch (e) {
        return err(`Image upload failed: ${(e as Error).message}`);
      }
    },
  );

  // ───────────────────────── Long-tail: search_actions / execute_action ─────────────────────────
  server.registerTool(
    "search_actions",
    {
      description:
        "Discover BookStack API actions not exposed as dedicated tools (users, roles, " +
        "shelves, attachments, comments, content-permissions, audit-log, recycle-bin, imports, " +
        "image gallery beyond upload). Returns a ranked list of action IDs plus their schemas. " +
        "Use `execute_action` to invoke one.",
      inputSchema: {
        intent: z.string().min(1).describe("Plain-English description of what you want to do."),
        limit: z.number().int().min(1).max(25).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ intent, limit }) => {
      const matches = rankActions(intent, limit).map((a) => ({
        id: a.id,
        group: a.group,
        method: a.method,
        uri: a.uri,
        description: a.description,
        path_params: a.pathParams,
        body_params: a.bodyParams,
      }));
      if (matches.length === 0) {
        return ok(
          `No actions matched "${intent}". The full catalog has ${CATALOG.length} actions across ${
            new Set(CATALOG.map((c) => c.group)).size
          } groups: ${[...new Set(CATALOG.map((c) => c.group))].join(", ")}.`,
        );
      }
      return ok(JSON.stringify(matches, null, 2));
    },
  );

  server.registerTool(
    "execute_action",
    {
      description:
        "Invoke a BookStack API action by ID (use `search_actions` to find one first). " +
        "Pass path parameters and body parameters under `params`; the tool routes them correctly " +
        "based on the action's HTTP method.",
      inputSchema: {
        action_id: z.string().min(1).describe("Action ID returned by search_actions, e.g. 'users-list'."),
        params: z.record(z.unknown()).default({}).describe(
          "Params object. Path params ({id} etc.) go alongside body fields; the tool sorts them out.",
        ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ action_id, params }) => {
      const action = getAction(action_id);
      if (!action) {
        return err(
          `Unknown action_id "${action_id}". Use search_actions to discover valid IDs.`,
        );
      }
      let resolved;
      try {
        resolved = resolvePath(action, params as Record<string, unknown>);
      } catch (e) {
        return err((e as Error).message);
      }
      if (action.method === "GET" || action.method === "DELETE") {
        const query = Object.fromEntries(
          Object.entries(resolved.rest).map(([k, v]) => [k, v as string | number | boolean]),
        );
        return call(action.method, resolved.path, { query });
      }
      return call(action.method, resolved.path, { json: resolved.rest });
    },
  );
}
