import { encodeBase64Url } from "./auth.js";
import { ApiError } from "./http.js";

const encoder = new TextEncoder();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Every bucket lives in the unprefixed rate_limits table.
// ledgerScoped buckets keep one budget per ledger and per full client address (a shared home IPv6 /64
// must not throttle several devices); the others guard authentication and are global per client.
export const RATE_LIMITS = Object.freeze({
  login: Object.freeze({
    label: "login", limit: 10, windowMs: HOUR, ledgerScoped: false,
    message: "Quá nhiều lần đăng nhập. Hãy thử lại sau.",
  }),
  createLedger: Object.freeze({
    label: "create-ledger", limit: 20, windowMs: HOUR, ledgerScoped: false,
    message: "Đã vượt giới hạn tạo sổ. Hãy thử lại sau.",
  }),
  // Creating and deleting ledgers, Store and restore check the same operations password, so their
  // password attempts share one bucket.
  restorePassword: Object.freeze({
    label: "restore-password", limit: 10, windowMs: 15 * MINUTE, ledgerScoped: false,
    message: "Đã vượt số lần nhập mật khẩu thao tác. Hãy thử lại sau.",
  }),
  // Friends entering lines together often share one NAT IPv4, and one line costs about 6-9 autosaves.
  write: Object.freeze({
    label: "write", limit: 300, adminLimit: 500, windowMs: 15 * MINUTE, ledgerScoped: true,
    message: "Đã vượt giới hạn thao tác. Hãy thử lại sau.",
  }),
  member: Object.freeze({
    label: "member", limit: 50, windowMs: HOUR, ledgerScoped: true,
    message: "Đã vượt giới hạn.",
  }),
  memberGroup: Object.freeze({
    label: "member-group", limit: 100, windowMs: 15 * MINUTE, ledgerScoped: true,
    message: "Đã vượt giới hạn quản lý nhóm. Hãy thử lại sau.",
  }),
});

function expandIpv6(address) {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (!groups.every((group) => /^[\da-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.padStart(4, "0"));
}

// Authentication buckets count an IPv6 client by its /64 (one home network), which stops address rotation.
export function authenticationSubject(address) {
  if (!address.includes(":")) return address;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];
  const groups = expandIpv6(address);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : address;
}

// Takes one token with two statements that run in one round trip: alone (enforceRateLimit) or first in
// a caller's own batch. rateLimit(results) reads their results and also returns the seconds left in
// the fixed window (for Retry-After), so a refusal costs no extra query.
export async function rateLimitStatements({ request, globalDB, ledger, isAdmin }, limiter) {
  const address = request.headers.get("cf-connecting-ip") || "local";
  const subject = limiter.ledgerScoped ? address : authenticationSubject(address);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(subject));
  const scope = limiter.ledgerScoped ? `${ledger.slug}:` : "";
  const key = `${limiter.label}:${scope}${encodeBase64Url(digest).slice(0, 24)}`;
  const limit = isAdmin && limiter.adminLimit ? limiter.adminLimit : limiter.limit;
  const now = Date.now();
  const windowIndex = Math.floor(now / limiter.windowMs);
  const windowStart = windowIndex * Math.ceil(limiter.windowMs / 1000);
  // A full bucket matches no row, so rejected requests write nothing. Right after a window's first hit
  // the bucket's older windows are deleted; the guard is evaluated only for older rows that exist, so
  // later hits pay just an empty index range.
  return {
    statements: [
      globalDB.prepare(`
        INSERT INTO rate_limits (bucket_key, window_start, hit_count)
        VALUES (?, ?, 1)
        ON CONFLICT (bucket_key, window_start)
        DO UPDATE SET hit_count = hit_count + 1 WHERE hit_count < ?
        RETURNING hit_count
      `).bind(key, windowStart, limit),
      globalDB.prepare(`
        DELETE FROM rate_limits
        WHERE bucket_key = ?1 AND window_start < ?2
          AND (SELECT latest.hit_count FROM rate_limits AS latest
               WHERE latest.bucket_key = rate_limits.bucket_key AND latest.window_start = ?2) = 1
      `).bind(key, windowStart),
    ],
    rateLimit([upserted]) {
      const [row] = upserted.results;
      return {
        allowed: row != null && Number(row.hit_count) <= limit,
        retryAfterSeconds: Math.ceil(((windowIndex + 1) * limiter.windowMs - now) / 1000),
      };
    },
  };
}

export function refuseIfLimited(limiter, { allowed, retryAfterSeconds }) {
  if (!allowed) throw new ApiError(limiter.message, 429, { "retry-after": String(retryAfterSeconds) });
}

export async function enforceRateLimit(ctx, limiter) {
  const { statements, rateLimit } = await rateLimitStatements(ctx, limiter);
  refuseIfLimited(limiter, rateLimit(await ctx.globalDB.batch(statements)));
}
