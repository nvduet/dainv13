import { LOGOUT_COOKIE, secureEqual, sessionCookie } from "../auth.js";
import { error, json, readJson } from "../http.js";

export function getSession({ isAdmin }) {
  return json({ isAdmin });
}

export async function login({ request, env }) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
    return error("Thiếu cấu hình đăng nhập Admin phía server.", 503);
  }
  const body = await readJson(request);
  const usernameMatches = await secureEqual(String(body.username || ""), env.ADMIN_USERNAME);
  const passwordMatches = await secureEqual(String(body.password || ""), env.ADMIN_PASSWORD);
  if (!usernameMatches || !passwordMatches) return error("Tên đăng nhập hoặc mật khẩu không đúng.", 401);
  return json({ isAdmin: true }, 200, {
    "set-cookie": await sessionCookie(env.ADMIN_USERNAME, env, request),
  });
}

export function logout() {
  return json({ isAdmin: false }, 200, { "set-cookie": LOGOUT_COOKIE });
}
