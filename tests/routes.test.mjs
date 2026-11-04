import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PAGE_SECURITY_HEADERS } from "../worker/http.js";
import worker from "../worker/index.js";
import { ROUTES } from "../worker/router.js";
import { createApp, ORIGIN, signedCookie } from "./helpers/app.mjs";
import { sqliteUnavailable } from "./helpers/d1-sqlite.mjs";

const options = { skip: sqliteUnavailable };
const ADMIN_ONLY = "Chỉ Admin đã đăng nhập mới được thực hiện thao tác này.";
const LEDGER_ADMIN_ONLY = "Chỉ Admin đã đăng nhập mới được quản lý sổ.";
const NOT_FOUND_API = { error: "Không tìm thấy API." };
const FOREIGN_ORIGIN = { error: "Yêu cầu khác nguồn bị từ chối." };

// Frozen on purpose: a route's gate, limiters and Detail tracking change only by editing this table.
// [method, sample path under the API root, scope, admin message, limiter labels, trackDetail]
const ROUTE_TABLE = [
  ["GET", "/state", "ledger", null, [], false],
  ["GET", "/admin/session", "ledger", null, [], false],
  ["POST", "/admin/login", "ledger", null, ["login"], false],
  ["POST", "/admin/logout", "ledger", null, [], false],
  ["GET", "/admin/ledgers", "global", LEDGER_ADMIN_ONLY, [], false],
  ["POST", "/admin/ledgers", "global", LEDGER_ADMIN_ONLY, ["create-ledger"], false],
  ["DELETE", "/admin/ledgers/some-ledger", "global", LEDGER_ADMIN_ONLY, [], false],
  ["GET", "/admin/audit", "ledger", ADMIN_ONLY, [], false],
  ["GET", "/admin/audit/some-session", "ledger", ADMIN_ONLY, [], false],
  ["POST", "/admin/member-groups", "ledger", ADMIN_ONLY, ["member-group"], true],
  ["PUT", "/admin/member-groups/some-group", "ledger", ADMIN_ONLY, ["member-group"], true],
  ["DELETE", "/admin/member-groups/some-group", "ledger", ADMIN_ONLY, ["member-group"], true],
  ["GET", "/admin/history-points", "ledger", ADMIN_ONLY, [], false],
  ["POST", "/admin/history-points", "ledger", ADMIN_ONLY, ["write"], false],
  ["POST", "/admin/history-points/some-point/restore", "ledger", ADMIN_ONLY, ["restore-password"], true],
  ["PUT", "/admin/column-widths", "ledger", ADMIN_ONLY, ["write"], false],
  ["PUT", "/admin/font-size", "ledger", ADMIN_ONLY, ["write"], false],
  ["PUT", "/admin/qr-size", "ledger", ADMIN_ONLY, ["write"], false],
  ["PUT", "/admin/payments/total", "ledger", ADMIN_ONLY, ["write"], false],
  ["POST", "/expenses", "ledger", null, ["write"], true],
  ["PUT", "/expenses/some-expense", "ledger", null, ["write"], true],
  ["DELETE", "/expenses/some-expense", "ledger", null, ["write"], true],
  ["POST", "/members", "ledger", ADMIN_ONLY, ["write", "member"], true],
  ["PATCH", "/members/some-member", "ledger", ADMIN_ONLY, ["write"], true],
  ["DELETE", "/members/some-member", "ledger", ADMIN_ONLY, ["write"], true],
];

function apis(scope, ledger) {
  return scope === "global" ? ["/api"] : ["/api", ledger.api];
}

function rateLimitTotals(app) {
  return app.db.rows("SELECT COUNT(*) AS count, COALESCE(SUM(hit_count), 0) AS hits FROM rate_limits")[0];
}

async function setUp() {
  const app = createApp();
  await app.login();
  const ledger = await app.createLedger("Sổ phụ");
  return { app, ledger };
}

test("the route table matches the frozen contract", () => {
  assert.equal(ROUTES.length, ROUTE_TABLE.length);
  for (const [method, path, scope, adminMessage, limiters, trackDetail] of ROUTE_TABLE) {
    const matches = ROUTES.filter((route) => route.method === method && route.pattern.test(`/api${path}`));
    assert.equal(matches.length, 1, `${method} ${path}`);
    const [route] = matches;
    assert.deepEqual(
      [route.scope, route.admin ? route.admin.message : null, route.rateLimits.map(({ label }) => label), route.trackDetail],
      [scope, adminMessage, limiters, trackDetail],
      `${method} ${path}`,
    );
    assert.equal(typeof route.handler, "function");
  }
});

test("guests get 401 from every admin route before any database work", options, async () => {
  const { app, ledger } = await setUp();
  const limitsBefore = rateLimitTotals(app);
  for (const [method, path, scope, message] of ROUTE_TABLE.filter((route) => route[3])) {
    for (const api of apis(scope, ledger)) {
      const queries = app.db.queryCount;
      const response = await app.request(method, `${api}${path}`, method === "GET" ? {} : { body: {} });
      assert.equal(response.status, 401, `${method} ${api}${path}`);
      assert.deepEqual(response.data, { error: message });
      // Only the ledger lookup of /api/g/<slug>: no rate-limit write, no Detail snapshot.
      assert.equal(app.db.queryCount - queries, api === "/api" ? 0 : 1, `${method} ${api}${path}`);
    }
  }
  assert.deepEqual(rateLimitTotals(app), limitsBefore);
});

test("a foreign Origin is rejected on every non-GET route before any database work", options, async () => {
  const { app, ledger } = await setUp();
  const limitsBefore = rateLimitTotals(app);
  for (const [method, path, scope] of ROUTE_TABLE.filter(([method]) => method !== "GET")) {
    for (const api of apis(scope, ledger)) {
      for (const admin of [false, true]) {
        const queries = app.db.queryCount;
        const response = await app.request(method, `${api}${path}`, {
          body: {},
          admin,
          headers: { origin: "https://evil.example" },
        });
        assert.equal(response.status, 403, `${method} ${api}${path}`);
        assert.deepEqual(response.data, FOREIGN_ORIGIN);
        assert.equal(app.db.queryCount - queries, api === "/api" ? 0 : 1, `${method} ${api}${path}`);
      }
    }
  }
  // A missing Origin stays allowed (non-browser clients), as before.
  const created = await worker.fetch(new Request(`${ORIGIN}/api/expenses`, { method: "POST", body: "{}" }), app.env);
  assert.equal(created.status, 201);
  assert.equal(rateLimitTotals(app).hits, limitsBefore.hits + 1);
});

test("unknown routes and methods are 404 without database access or rate-limit writes", options, async () => {
  const { app, ledger } = await setUp();
  const limitsBefore = rateLimitTotals(app);
  for (const api of ["/api", ledger.api]) {
    for (const [method, path] of [
      ["HEAD", "/state"],
      ["OPTIONS", "/state"],
      ["HEAD", "/expenses"],
      ["OPTIONS", "/members"],
      ["GET", "/members"],
      ["PATCH", "/expenses/x"],
      ["PUT", "/admin/history-points"],
      ["POST", "/admin/audit"],
      ["GET", "/admin/member-groups"],
      ["POST", "/unknown"],
      ["DELETE", "/admin/ledgers/UPPER"],
    ]) {
      const queries = app.db.queryCount;
      const response = await app.request(method, `${api}${path}`, { admin: true });
      assert.equal(response.status, 404, `${method} ${api}${path}`);
      if (method !== "HEAD") assert.deepEqual(response.data, NOT_FOUND_API);
      assert.equal(app.db.queryCount - queries, 0, `${method} ${api}${path}`);
    }
  }
  assert.deepEqual(rateLimitTotals(app), limitsBefore);
});

test("ledger management is not served under a ledger link", options, async () => {
  const { app, ledger } = await setUp();
  const other = await app.createLedger("Sổ khác");
  const objects = () => app.db.rows("SELECT type, name, sql FROM sqlite_master ORDER BY name");
  const ledgers = () => app.db.rows("SELECT id, slug FROM ledgers ORDER BY slug");
  const [objectsBefore, ledgersBefore] = [objects(), ledgers()];
  for (const [method, path, body] of [
    ["GET", "/admin/ledgers"],
    ["POST", "/admin/ledgers", { name: "Sổ lồng", password: "restore-password" }],
    ["DELETE", `/admin/ledgers/${other.slug}`, { password: "restore-password" }],
  ]) {
    const response = await app.request(method, `${ledger.api}${path}`, { body, admin: true });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(response.data, NOT_FOUND_API);
  }
  assert.deepEqual(objects(), objectsBefore);
  assert.deepEqual(ledgers(), ledgersBefore);
});

test("audit session details are Admin-only", options, async () => {
  const { app, ledger } = await setUp();
  for (const api of ["/api", ledger.api]) {
    await app.addMember("An", api);
    const [{ id }] = (await app.request("GET", `${api}/admin/audit`, { admin: true })).data.sessions;
    const guest = await app.request("GET", `${api}/admin/audit/${id}`);
    assert.equal(guest.status, 401);
    assert.deepEqual(guest.data, { error: ADMIN_ONLY });
    assert.equal((await app.request("GET", `${api}/admin/audit/${id}`, { admin: true })).status, 200);
  }
});

test("Detail-changing routes record exactly one session on success and none on a 4xx", options, async () => {
  const { app, ledger } = await setUp();
  for (const { api, prefix } of [{ api: "/api", prefix: "" }, ledger]) {
    const sessions = () => app.count(`SELECT COUNT(*) AS count FROM "${prefix}audit_sessions"`);
    const expect = async (label, status, recorded, method, path, request = {}) => {
      app.db.run(`DELETE FROM "${prefix}audit_sessions"`);
      const response = await app.request(method, `${api}${path}`, request);
      assert.equal(response.status, status, `${label}: ${JSON.stringify(response.data)}`);
      assert.equal(sessions(), recorded, label);
      return response;
    };
    const an = await app.addMember("An", api);
    const binh = await app.addMember("Bình", api);
    const chi = await app.addMember("Chi", api);

    const expense = (await expect("create expense", 201, 1, "POST", "/expenses", { body: {} })).data.expense.id;
    await expect("create expense, foreign origin", 403, 0, "POST", "/expenses", {
      body: {}, headers: { origin: "https://evil.example" },
    });
    await expect("edit expense", 200, 1, "PUT", `/expenses/${expense}`, { body: { description: "Mới" } });
    await expect("edit expense, invalid date", 400, 0, "PUT", `/expenses/${expense}`, { body: { date: "2026-02-30" } });
    await expect("edit missing expense", 404, 0, "PUT", "/expenses/missing", { body: { amountVnd: 1 } });
    await expect("delete missing expense", 404, 0, "DELETE", "/expenses/missing");
    await expect("delete expense", 200, 1, "DELETE", `/expenses/${expense}`);

    await expect("add member", 201, 1, "POST", "/members", { body: { name: "Dũng" }, admin: true });
    await expect("add duplicate member", 409, 0, "POST", "/members", { body: { name: "dũng" }, admin: true });
    await expect("rename member", 200, 1, "PATCH", `/members/${chi}`, { body: { name: "Chi Mới" }, admin: true });
    await expect("rename member, blank", 400, 0, "PATCH", `/members/${chi}`, { body: { name: " " }, admin: true });
    await expect("delete missing member", 404, 0, "DELETE", "/members/missing", { admin: true });

    const group = (await expect("create group", 201, 1, "POST", "/admin/member-groups", {
      body: { name: "Nhóm", memberIds: [an, binh] }, admin: true,
    })).data.group.id;
    await expect("create group, one member", 400, 0, "POST", "/admin/member-groups", {
      body: { name: "Solo", memberIds: [chi] }, admin: true,
    });
    await expect("update group", 200, 1, "PUT", `/admin/member-groups/${group}`, {
      body: { name: "Nhóm 2", memberIds: [an, binh, chi] }, admin: true,
    });
    await expect("update missing group", 404, 0, "PUT", "/admin/member-groups/missing", {
      body: { name: "X", memberIds: [an, binh] }, admin: true,
    });
    await expect("delete missing group", 404, 0, "DELETE", "/admin/member-groups/missing", { admin: true });
    await expect("delete group", 200, 1, "DELETE", `/admin/member-groups/${group}`, { admin: true });

    const point = (await app.request("POST", `${api}/admin/history-points`, {
      body: { message: "Mốc", password: "restore-password" }, admin: true,
    })).data.point.id;
    await expect("delete member", 200, 1, "DELETE", `/members/${chi}`, { admin: true });
    await expect("restore, wrong password", 401, 0, "POST", `/admin/history-points/${point}/restore`, {
      body: { password: "wrong" }, admin: true,
    });
    await expect("restore", 200, 1, "POST", `/admin/history-points/${point}/restore`, {
      body: { password: "restore-password" }, admin: true,
    });
  }
});

test("the baseline snapshot is sent only while a ledger has none", options, async () => {
  const { app, ledger } = await setUp();
  const prepare = app.db.prepare.bind(app.db);
  const anchorWrites = [];
  app.db.prepare = (sql) => {
    if (/INSERT OR IGNORE INTO \S*audit_session_anchor/.test(sql)) anchorWrites.push(sql);
    return prepare(sql);
  };
  for (const { api, prefix } of [{ api: "/api", prefix: "" }, ledger]) {
    anchorWrites.length = 0;
    const id = await app.addExpense({}, api);
    assert.equal(anchorWrites.length, 1, api);
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}audit_session_anchor"`), 1);
    assert.equal((await app.request("PUT", `${api}/expenses/${id}`, { body: { description: "Sau" } })).status, 200);
    assert.equal(anchorWrites.length, 1, `${api}: later changes find the anchor`);
  }
});

test("a failed audit-session write keeps the successful response", options, async (t) => {
  const { app, ledger } = await setUp();
  const errors = t.mock.method(console, "error", () => {});
  for (const { api, prefix } of [{ api: "/api", prefix: "" }, ledger]) {
    const id = await app.addExpense({ description: "Trước" }, api);
    app.db.run(`DELETE FROM "${prefix}audit_sessions"`);
    app.db.run(`
      CREATE TRIGGER "${prefix}fail_audit_sessions" BEFORE INSERT ON "${prefix}audit_sessions"
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END
    `);
    const calls = errors.mock.callCount();
    const response = await app.request("PUT", `${api}/expenses/${id}`, { body: { description: "Đã lưu" } });
    assert.equal(response.status, 200);
    assert.equal(response.data.expense.description, "Đã lưu");
    assert.equal(app.db.rows(`SELECT description FROM "${prefix}expenses" WHERE id = ?`, id)[0].description, "Đã lưu");
    assert.equal(errors.mock.callCount(), calls + 1);
    assert.equal(errors.mock.calls.at(-1).arguments[0], "Detail audit session not recorded");
  }
});

function streamedPut(path, text, chunkSize = 1000) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  });
  return new Request(`${ORIGIN}${path}`, {
    method: "PUT",
    body,
    duplex: "half",
    headers: { origin: ORIGIN, "content-type": "application/json" },
  });
}

test("request bodies over 100 KB are refused even when streamed without Content-Length", options, async () => {
  const app = createApp();
  const id = await app.addExpense();
  const path = `/api/expenses/${id}`;
  const padded = (size) => {
    const text = JSON.stringify({ description: "" });
    return `${text.slice(0, -1)}${" ".repeat(size - text.length)}}`;
  };

  const oversized = streamedPut(path, padded(100_001));
  assert.equal(oversized.headers.get("content-length"), null);
  const refused = await worker.fetch(oversized, app.env);
  assert.equal(refused.status, 413);
  assert.deepEqual(await refused.json(), { error: "Dữ liệu gửi lên quá lớn." });

  const atLimit = await worker.fetch(streamedPut(path, padded(100_000)), app.env);
  assert.equal(atLimit.status, 200);
  const small = await worker.fetch(streamedPut(path, JSON.stringify({ description: "Luồng" }), 3), app.env);
  assert.equal(small.status, 200);
  assert.equal((await small.json()).expense.description, "Luồng");
  const invalid = await worker.fetch(streamedPut(path, "{oops"), app.env);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Dữ liệu JSON không hợp lệ." });
});

test("a body stream that fails mid-read is invalid JSON, as with request.json()", options, async (t) => {
  const app = createApp();
  const errors = t.mock.method(console, "error", () => {});
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("{\"username\":\"ad"));
      else controller.error(new Error("client aborted"));
    },
  });
  const response = await worker.fetch(new Request(`${ORIGIN}/api/admin/login`, {
    method: "POST",
    body,
    duplex: "half",
    headers: { origin: ORIGIN, "content-type": "application/json" },
  }), app.env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Dữ liệu JSON không hợp lệ." });
  assert.equal(errors.mock.callCount(), 0);
});

// Before the body is read, as before: the limiter (route pipeline), then both configuration checks.
test("restore reports a missing or unsafe configuration before reading the body", options, async () => {
  const app = createApp();
  await app.login();
  for (const [restorePassword, message] of [
    [undefined, "Chưa cấu hình mật khẩu thao tác phía máy chủ."],
    [app.env.ADMIN_PASSWORD, "Mật khẩu thao tác phải khác mật khẩu Admin. Hãy cấu hình lại secret."],
  ]) {
    app.env.HISTORY_RESTORE_PASSWORD = restorePassword;
    const response = await app.request("POST", "/api/admin/history-points/any/restore", { body: "{oops", admin: true });
    assert.equal(response.status, 503);
    assert.deepEqual(response.data, { error: message });
  }
});

test("malformed percent-escapes in path parameters are that route's 404", options, async () => {
  const { app, ledger } = await setUp();
  const bad = "%E0%A4%A";
  for (const api of ["/api", ledger.api]) {
    for (const [method, path, request, message] of [
      ["PUT", `/expenses/${bad}`, { body: { amountVnd: 1 } }, "Không tìm thấy khoản chi."],
      ["DELETE", `/expenses/${bad}`, {}, "Không tìm thấy khoản chi."],
      ["PATCH", `/members/${bad}`, { body: { name: "X" }, admin: true }, "Không tìm thấy thành viên."],
      ["DELETE", `/members/${bad}`, { admin: true }, "Không tìm thấy thành viên."],
      ["PUT", `/admin/member-groups/${bad}`, { body: { name: "X", memberIds: ["a", "b"] }, admin: true }, "Không tìm thấy nhóm."],
      ["DELETE", `/admin/member-groups/${bad}`, { admin: true }, "Không tìm thấy nhóm."],
      ["GET", `/admin/audit/${bad}`, { admin: true }, "Không tìm thấy phiên nhật ký."],
      ["POST", `/admin/history-points/${bad}/restore`, { body: { password: "restore-password" }, admin: true },
        "Không tìm thấy điểm khôi phục."],
    ]) {
      const response = await app.request(method, `${api}${path}`, request);
      assert.equal(response.status, 404, `${method} ${api}${path}`);
      assert.deepEqual(response.data, { error: message });
    }
  }
  const ledgerDelete = await app.request("DELETE", `/api/admin/ledgers/${bad}`, { body: { password: "x" }, admin: true });
  assert.equal(ledgerDelete.status, 404);
  assert.deepEqual(ledgerDelete.data, NOT_FOUND_API);
});

test("API responses and ledger pages carry security headers", options, async () => {
  const { app, ledger } = await setUp();
  for (const [method, path, status] of [
    ["GET", "/api/state", 200],
    ["GET", `${ledger.api}/state`, 200],
    ["GET", "/api/unknown", 404],
    ["PUT", "/api/admin/font-size", 401],
  ]) {
    const response = await app.request(method, path, method === "GET" ? {} : { body: {} });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  }

  const pageHeaders = {
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "x-robots-tag": "noindex, nofollow",
  };
  const page = await app.request("GET", `/g/${ledger.slug}`);
  assert.equal(page.status, 200);
  assert.equal(page.data, "<!doctype html><title>Expense</title>");
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(pageHeaders)) assert.equal(page.headers.get(name), value, name);

  // Asset responses can have immutable headers; the page is re-wrapped instead of mutated.
  app.env.ASSETS.fetch = async () => Response.redirect(`${ORIGIN}/`, 302);
  const redirected = await app.request("GET", `/g/${ledger.slug}/`);
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get("location"), `${ORIGIN}/`);
  for (const [name, value] of Object.entries(pageHeaders)) assert.equal(redirected.headers.get(name), value, name);
  // API responses are not pages: robots.txt keeps crawlers out of /api/ instead.
  assert.equal((await app.request("GET", "/api/state")).headers.get("x-robots-tag"), null);
});

// "/" and the static files get their headers from public/_headers (Workers Static Assets); /g/<slug> from the Worker.
test("public/_headers sends exactly the Worker's page headers to every static asset", () => {
  const lines = readFileSync(new URL("../public/_headers", import.meta.url), "utf8").split(/\r?\n/).filter((line) => line.trim());
  assert.equal(lines[0], "/*");
  const fileHeaders = Object.fromEntries(lines.slice(1).map((line) => {
    assert.match(line, /^\s+[\w-]+: \S/);
    const index = line.indexOf(":");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  assert.deepEqual(fileHeaders, PAGE_SECURITY_HEADERS);
});

test("admin sessions need a finite expiry", options, async () => {
  const app = createApp();
  const isAdminWith = async (details) =>
    (await app.request("GET", "/api/admin/session", { headers: { cookie: signedCookie(details) } })).data.isAdmin;
  assert.equal(await isAdminWith({ username: "admin", sessionId: "s1", expires: Date.now() + 60_000 }), true);
  assert.equal(await isAdminWith({ username: "admin", sessionId: "s1" }), false);
  assert.equal(await isAdminWith({ username: "admin", sessionId: "s1", expires: "Infinity" }), false);
  assert.equal(await isAdminWith({ username: "admin", sessionId: "s1", expires: "later" }), false);
  assert.equal(await isAdminWith(null), false);
  const login = await app.request("POST", "/api/admin/login", {
    body: { username: "admin", password: "admin-password" },
  });
  assert.match(login.headers.get("set-cookie"), /; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
});
