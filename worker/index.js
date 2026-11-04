import { DEFAULT_LEDGER } from "../public/shared/constants.mjs";
import { ApiError, PAGE_SECURITY_HEADERS, error } from "./http.js";
import { LEDGER_SCHEMA_VERSION, ledgerDatabase, upgradeLedgerSchema } from "./ledger-schema.js";
import { findRoute, handleRoute } from "./router.js";

const SCOPED_API_PATH = /^\/api\/g\/([a-z0-9-]+)(\/.*)$/;
const LEDGER_PAGE_PATH = /^\/g\/[a-z0-9-]+\/?$/;

// /api/... serves the default ledger (unprefixed tables) and ledger management;
// /api/g/<slug>/... serves the ledger with that slug.
async function handleApi(request, env, url) {
  if (!env.DB) return error("Database chưa được cấu hình. Hãy chạy migrations D1 trước.", 503);
  const scoped = url.pathname.match(SCOPED_API_PATH);
  const match = findRoute(
    request.method.toUpperCase(),
    scoped ? `/api${scoped[2]}` : url.pathname,
    { scoped: Boolean(scoped) },
  );
  if (!match) return error("Không tìm thấy API.", 404);

  let ledger = { id: "default", ...DEFAULT_LEDGER };
  if (scoped) {
    // schema_version comes from migration 0013, which push_to_server.ps1 applies before deploying.
    ledger = await env.DB.prepare(
      "SELECT id, slug, name, schema_version AS schemaVersion FROM ledgers WHERE slug = ?",
    ).bind(scoped[1]).first();
    if (!ledger) return error("Không tìm thấy sổ chi tiêu.", 404);
    if (ledger.id !== "default" && Number(ledger.schemaVersion ?? 0) < LEDGER_SCHEMA_VERSION) {
      await upgradeLedgerSchema(env.DB, ledger.id);
    }
  }
  return handleRoute(match, {
    request,
    env,
    url,
    ledger,
    db: match.route.scope === "global" ? env.DB : ledgerDatabase(env.DB, ledger.id),
    globalDB: env.DB,
  });
}

// index.html for a ledger link; asset responses can be immutable, so the headers are copied.
async function serveLedgerPage(request, env) {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = "/";
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PAGE_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      if (LEDGER_PAGE_PATH.test(url.pathname)) return await serveLedgerPage(request, env);
      return await env.ASSETS.fetch(request);
    } catch (caught) {
      if (caught instanceof ApiError) return error(caught.message, caught.status, caught.headers);
      console.error("Request failed", caught);
      return error("Đã xảy ra lỗi máy chủ. Hãy thử lại; nếu vẫn tiếp diễn, liên hệ Admin.", 500);
    }
  },
};
