import { AUDIT_ACTOR, readDetailSnapshot, recordDetailSession } from "./audit.js";
import { getAdminSession } from "./auth.js";
import { error } from "./http.js";
import { RATE_LIMITS, enforceRateLimit } from "./rate-limit.js";
import { getAuditSession, listAuditSessions } from "./routes/audit.js";
import { createExpense, deleteExpense, updateExpense } from "./routes/expenses.js";
import { listHistoryPoints, restoreHistoryPoint, storeHistoryPoint } from "./routes/history.js";
import { createLedger, deleteLedger, listLedgers } from "./routes/ledgers.js";
import { createGroup, deleteGroup, updateGroup } from "./routes/member-groups.js";
import { createMember, deleteMember, renameMember } from "./routes/members.js";
import { reconcilePaymentTotal } from "./routes/payments.js";
import { getSession, login, logout } from "./routes/session.js";
import { settingHandler } from "./routes/settings.js";
import { state } from "./routes/state.js";

const ADMIN = Object.freeze({ message: "Chỉ Admin đã đăng nhập mới được thực hiện thao tác này." });
const LEDGER_ADMIN = Object.freeze({ message: "Chỉ Admin đã đăng nhập mới được quản lý sổ." });
const { login: LOGIN, createLedger: CREATE_LEDGER, restorePassword: RESTORE_PASSWORD,
  write: WRITE, member: MEMBER, memberGroup: MEMBER_GROUP } = RATE_LIMITS;

// scope "ledger": served for the default ledger (/api/...) and for /api/g/<slug>/...; scope "global":
// only at /api/... (ledger management). rateLimits run in order before the handler; trackDetail routes
// change Detail data and are recorded in audit_sessions. Ledger creation and deletion and Store spend
// the shared operations-password limiter in their handlers, only for an actual password attempt.
const ROUTE_DEFAULTS = { scope: "ledger", admin: false, rateLimits: [], trackDetail: false };
export const ROUTES = Object.freeze([
  { method: "GET", pattern: /^\/api\/state$/, handler: state },
  { method: "GET", pattern: /^\/api\/admin\/session$/, handler: getSession },
  { method: "POST", pattern: /^\/api\/admin\/login$/, rateLimits: [LOGIN], handler: login },
  { method: "POST", pattern: /^\/api\/admin\/logout$/, handler: logout },

  { method: "GET", pattern: /^\/api\/admin\/ledgers$/, scope: "global", admin: LEDGER_ADMIN, handler: listLedgers },
  { method: "POST", pattern: /^\/api\/admin\/ledgers$/, scope: "global", admin: LEDGER_ADMIN,
    rateLimits: [CREATE_LEDGER], handler: createLedger },
  { method: "DELETE", pattern: /^\/api\/admin\/ledgers\/([a-z0-9-]+)$/, scope: "global", admin: LEDGER_ADMIN,
    handler: deleteLedger },

  { method: "GET", pattern: /^\/api\/admin\/audit$/, admin: ADMIN, handler: listAuditSessions },
  { method: "GET", pattern: /^\/api\/admin\/audit\/([^/]+)$/, admin: ADMIN, handler: getAuditSession },

  { method: "POST", pattern: /^\/api\/admin\/member-groups$/, admin: ADMIN, rateLimits: [MEMBER_GROUP],
    trackDetail: true, handler: createGroup },
  { method: "PUT", pattern: /^\/api\/admin\/member-groups\/([^/]+)$/, admin: ADMIN, rateLimits: [MEMBER_GROUP],
    trackDetail: true, handler: updateGroup },
  { method: "DELETE", pattern: /^\/api\/admin\/member-groups\/([^/]+)$/, admin: ADMIN, rateLimits: [MEMBER_GROUP],
    trackDetail: true, handler: deleteGroup },

  { method: "GET", pattern: /^\/api\/admin\/history-points$/, admin: ADMIN, handler: listHistoryPoints },
  { method: "POST", pattern: /^\/api\/admin\/history-points$/, admin: ADMIN, rateLimits: [WRITE],
    handler: storeHistoryPoint },
  { method: "POST", pattern: /^\/api\/admin\/history-points\/([^/]+)\/restore$/, admin: ADMIN,
    rateLimits: [RESTORE_PASSWORD], trackDetail: true, handler: restoreHistoryPoint },

  { method: "PUT", pattern: /^\/api\/admin\/column-widths$/, admin: ADMIN, rateLimits: [WRITE],
    handler: settingHandler("column-widths") },
  { method: "PUT", pattern: /^\/api\/admin\/font-size$/, admin: ADMIN, rateLimits: [WRITE],
    handler: settingHandler("font-size") },
  { method: "PUT", pattern: /^\/api\/admin\/qr-size$/, admin: ADMIN, rateLimits: [WRITE],
    handler: settingHandler("qr-size") },
  { method: "PUT", pattern: /^\/api\/admin\/payments\/total$/, admin: ADMIN, rateLimits: [WRITE],
    handler: reconcilePaymentTotal },

  { method: "POST", pattern: /^\/api\/expenses$/, rateLimits: [WRITE], trackDetail: true, handler: createExpense },
  { method: "PUT", pattern: /^\/api\/expenses\/([^/]+)$/, rateLimits: [WRITE], trackDetail: true,
    handler: updateExpense },
  { method: "DELETE", pattern: /^\/api\/expenses\/([^/]+)$/, rateLimits: [WRITE], trackDetail: true,
    handler: deleteExpense },

  { method: "POST", pattern: /^\/api\/members$/, admin: ADMIN, rateLimits: [WRITE, MEMBER], trackDetail: true,
    handler: createMember },
  { method: "PATCH", pattern: /^\/api\/members\/([^/]+)$/, admin: ADMIN, rateLimits: [WRITE], trackDetail: true,
    handler: renameMember },
  { method: "DELETE", pattern: /^\/api\/members\/([^/]+)$/, admin: ADMIN, rateLimits: [WRITE], trackDetail: true,
    handler: deleteMember },
].map((route) => Object.freeze({ ...ROUTE_DEFAULTS, ...route })));

// Matching needs no database access, so unknown routes and methods (HEAD, OPTIONS, ...) cost nothing.
export function findRoute(method, path, { scoped }) {
  for (const route of ROUTES) {
    if (route.method !== method || (scoped && route.scope !== "ledger")) continue;
    const match = route.pattern.exec(path);
    if (match) return { route, params: match.slice(1) };
  }
  return null;
}

// Origin check, admin gate and rate limits run before any snapshot, so rejected requests stay cheap.
export async function handleRoute({ route, params }, base) {
  const { request, env, url } = base;
  if (route.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return error("Yêu cầu khác nguồn bị từ chối.", 403);
  }
  const adminSession = await getAdminSession(request, env);
  const ctx = {
    ...base,
    params,
    adminSession,
    isAdmin: Boolean(adminSession),
    auditActor: adminSession ? AUDIT_ACTOR.ADMIN : AUDIT_ACTOR.GUEST,
  };
  if (route.admin && !ctx.isAdmin) return error(route.admin.message, 401);
  for (const limiter of route.rateLimits) await enforceRateLimit(ctx, limiter);
  if (!route.trackDetail) return route.handler(ctx);

  const before = await readDetailSnapshot(ctx.db, { probeAnchor: true });
  const response = await route.handler(ctx);
  if (response.ok) {
    try {
      const after = await readDetailSnapshot(ctx.db);
      if (after.json !== before.json) await recordDetailSession(ctx.db, ctx.isAdmin, before, after);
    } catch (caught) {
      console.error("Detail audit session not recorded", caught);
    }
  }
  return response;
}
