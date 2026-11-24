import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../public/js/api.js";

// api() reads the page path and calls fetch only when invoked; both are stubbed per test.
// `reply` is an Error to reject with, a Response, or a function returning a fresh Response per call.
function stubBrowser(t, pathname, reply) {
  const requests = [];
  globalThis.window = { location: { pathname } };
  t.mock.method(globalThis, "fetch", async (path, init) => {
    requests.push({ path, init });
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  });
  return requests;
}

function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("api() errors carry the HTTP status (0 without a response) and Retry-After; messages are unchanged", async (t) => {
  for (const [reply, message, status, retryAfter] of [
    [jsonResponse({ error: "Đã vượt giới hạn thao tác. Hãy thử lại sau." }, 429, { "retry-after": "120" }),
      "Đã vượt giới hạn thao tác. Hãy thử lại sau.", 429, 120],
    [new Response("<html>Bad gateway</html>", { status: 502 }), "Máy chủ trả về dữ liệu không đọc được (HTTP 502).", 502, null],
    [new TypeError("Failed to fetch"), "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.", 0, null],
    [jsonResponse({ error: "Mật khẩu thao tác không đúng." }, 401), "Mật khẩu thao tác không đúng.", 401, null],
    [jsonResponse({}, 404, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), "Yêu cầu thất bại (404).", 404, null],
    [new Response("not json", { status: 200 }), "Máy chủ trả về dữ liệu không đọc được.", 200, null],
  ]) {
    stubBrowser(t, "/", reply);
    await assert.rejects(api("/api/expenses/e1", { method: "PUT", body: "{}" }), (caught) => {
      assert.deepEqual([caught.message, caught.status, caught.retryAfter], [message, status, retryAfter]);
      return true;
    });
  }
  stubBrowser(t, "/", jsonResponse({ expense: { id: "e1" } }, 200));
  assert.deepEqual(await api("/api/expenses/e1", { method: "PUT", body: "{}" }), { expense: { id: "e1" } });
});

test("api() errors carry the field the server names (a missing or wrong operations password); other errors have none", async (t) => {
  for (const [reply, field] of [
    [jsonResponse({ error: "Mật khẩu thao tác không đúng.", field: "password" }, 401), "password"],
    [jsonResponse({ error: "Nhập mật khẩu thao tác để tạo sổ trong phiên Admin này.", field: "password" }, 400), "password"],
    [jsonResponse({ error: "Tên sổ cần chứa ít nhất một ký tự chữ hoặc số." }, 400), undefined],
    [jsonResponse({ error: "Đã vượt số lần nhập mật khẩu thao tác. Hãy thử lại sau." }, 429, { "retry-after": "60" }), undefined],
    [jsonResponse({ error: "Lỗi", field: 7 }, 400), undefined],
    [new Response("<html>Bad gateway</html>", { status: 502 }), undefined],
    [new TypeError("Failed to fetch"), undefined],
  ]) {
    stubBrowser(t, "/", reply);
    await assert.rejects(api("/api/admin/ledgers", { method: "POST", body: "{}" }), (caught) => {
      assert.equal(caught.field, field);
      assert.equal(Object.hasOwn(caught, "field"), field !== undefined);
      return true;
    });
  }
});

test("on a ledger page, ledger APIs go to /api/g/<slug>/ but ledger management stays global", async (t) => {
  const requests = stubBrowser(t, "/g/da-lat-2026", () => jsonResponse({}, 200));
  await api("/api/expenses/e1", { method: "PUT", body: "{}" });
  await api("/api/admin/ledgers");
  await api("/api/admin/ledgers/so-cu", { method: "DELETE", body: "{}" });
  assert.deepEqual(requests.map(({ path }) => path), [
    "/api/g/da-lat-2026/expenses/e1",
    "/api/admin/ledgers",
    "/api/admin/ledgers/so-cu",
  ]);
  assert.equal(requests[0].init.headers["content-type"], "application/json");
  assert.equal(requests[1].init.credentials, "same-origin");
});
