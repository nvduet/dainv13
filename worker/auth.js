import { ADMIN_SESSION_HOURS } from "../public/shared/constants.mjs";

const encoder = new TextEncoder();
const ADMIN_SESSION_SECONDS = ADMIN_SESSION_HOURS * 60 * 60;
export const LOGOUT_COOKIE = "admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";

export function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

export function encodeBase64Url(value) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const hmacKeys = new Map();

async function hmacKey(secret) {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    if (hmacKeys.size >= 8) hmacKeys.clear();
    hmacKeys.set(secret, key);
  }
  return key;
}

async function sign(payload, secret) {
  return encodeBase64Url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
}

export async function secureEqual(left, right) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const bytesA = new Uint8Array(a);
  const bytesB = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < bytesA.length; index += 1) difference |= bytesA[index] ^ bytesB[index];
  return difference === 0;
}

export async function sessionCookie(username, env, request) {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    username,
    sessionId: crypto.randomUUID(),
    expires: Date.now() + ADMIN_SESSION_SECONDS * 1000,
  })));
  const signature = await sign(payload, env.ADMIN_SESSION_SECRET);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `admin_session=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_SECONDS}${secure}`;
}

export async function getAdminSession(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return null;
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("admin_session="));
  if (!token) return null;
  const value = token.slice("admin_session=".length);
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!(await secureEqual(signature, await sign(payload, env.ADMIN_SESSION_SECRET)))) return null;
  try {
    const details = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    const expires = Number(details.expires);
    if (details.username !== env.ADMIN_USERNAME || !Number.isFinite(expires) || expires <= Date.now()) return null;
    return {
      ...details,
      sessionId: typeof details.sessionId === "string" ? details.sessionId : `legacy-${payload}`,
    };
  } catch {
    return null;
  }
}
