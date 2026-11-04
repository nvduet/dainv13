import { ADMIN_SESSION_HOURS } from "../public/shared/constants.mjs";
import { secureEqual } from "./auth.js";
import { ApiError } from "./http.js";
import { RATE_LIMITS, rateLimitStatements, refuseIfLimited } from "./rate-limit.js";

// One "operations password" (the secret HISTORY_RESTORE_PASSWORD) guards creating and deleting
// ledgers, Store and restore. Creating a ledger and Store ask for it once per Admin session: the
// authorization lives in the unprefixed admin_session_store_auth table (always reached through
// ctx.globalDB), so it covers every ledger. Deleting a ledger and restore always ask.
export function operationsAuthorizationQuery(globalDB, sessionId) {
  return globalDB.prepare(`
    SELECT session_id AS sessionId FROM admin_session_store_auth
    WHERE session_id = ? AND expires_at > CURRENT_TIMESTAMP
  `).bind(sessionId);
}

export function recordOperationsAuthorization(globalDB, sessionId) {
  return globalDB.prepare(`
    INSERT INTO admin_session_store_auth (session_id, expires_at)
    VALUES (?, datetime('now', '+${ADMIN_SESSION_HOURS} hours'))
    ON CONFLICT (session_id) DO UPDATE SET expires_at = excluded.expires_at
  `).bind(sessionId);
}

export async function requireOperationsPasswordConfigured(env) {
  if (!env.HISTORY_RESTORE_PASSWORD) {
    throw new ApiError("Chưa cấu hình mật khẩu thao tác phía máy chủ.", 503);
  }
  if (await secureEqual(env.HISTORY_RESTORE_PASSWORD, env.ADMIN_PASSWORD || "")) {
    throw new ApiError("Mật khẩu thao tác phải khác mật khẩu Admin. Hãy cấu hình lại secret.", 503);
  }
}

function requirePasswordSent(password, missingMessage) {
  if (typeof password !== "string" || password.length === 0) throw new ApiError(missingMessage, 400);
}

async function checkOperationsPassword(env, password) {
  if (!await secureEqual(password, env.HISTORY_RESTORE_PASSWORD)) {
    throw new ApiError("Mật khẩu thao tác không đúng.", 401);
  }
}

// Every password attempt spends the shared 'restore-password' limiter; a missing password does not.
// The limiter's statements go first in the caller's next batch, so the attempt costs no round trip of
// its own; verify(results) then refuses with 429, or with 401 for a wrong password.
export async function operationsPasswordAttempt(ctx, password, missingMessage) {
  requirePasswordSent(password, missingMessage);
  const { statements, rateLimit } = await rateLimitStatements(ctx, RATE_LIMITS.restorePassword);
  return {
    statements,
    async verify(results) {
      refuseIfLimited(RATE_LIMITS.restorePassword, rateLimit(results));
      await checkOperationsPassword(ctx.env, password);
    },
  };
}

// A password attempt in its own round trip. Restore spends the limiter in its route instead, before
// the configuration checks.
export async function requireOperationsPassword(ctx, password, missingMessage, { spendLimiter = true } = {}) {
  if (!spendLimiter) {
    requirePasswordSent(password, missingMessage);
    await checkOperationsPassword(ctx.env, password);
    return;
  }
  const attempt = await operationsPasswordAttempt(ctx, password, missingMessage);
  await attempt.verify(await ctx.globalDB.batch(attempt.statements));
}

// Store: without an authorization for this Admin session the password is required, and the returned
// statement records the authorization in the caller's own batch. (Ledger creation does the same with
// operationsPasswordAttempt, so its limiter rides along with the schema read.)
export async function authorizeOperations(ctx, authorized, password, missingMessage) {
  if (authorized) return [];
  await requireOperationsPasswordConfigured(ctx.env);
  await requireOperationsPassword(ctx, password, missingMessage);
  return [recordOperationsAuthorization(ctx.globalDB, ctx.adminSession.sessionId)];
}
