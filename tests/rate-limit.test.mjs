import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { RATE_LIMITS, authenticationSubject } from "../worker/rate-limit.js";
import { createApp } from "./helpers/app.mjs";
import { sqliteUnavailable } from "./helpers/d1-sqlite.mjs";

const options = { skip: sqliteUnavailable };
const MINUTE = 60_000;
const WRONG_LOGIN = { username: "admin", password: "wrong" };
const LOGIN = { username: "admin", password: "admin-password" };

// Frozen: [name, label, limit, Admin limit, window, ledger-scoped, 429 message]
const LIMITERS = [
  ["login", "login", 10, undefined, 60 * MINUTE, false, "Quá nhiều lần đăng nhập. Hãy thử lại sau."],
  ["createLedger", "create-ledger", 20, undefined, 60 * MINUTE, false, "Đã vượt giới hạn tạo sổ. Hãy thử lại sau."],
  ["restorePassword", "restore-password", 10, undefined, 15 * MINUTE, false,
    "Đã vượt số lần nhập mật khẩu thao tác. Hãy thử lại sau."],
  ["write", "write", 300, 500, 15 * MINUTE, true, "Đã vượt giới hạn thao tác. Hãy thử lại sau."],
  ["member", "member", 50, undefined, 60 * MINUTE, true, "Đã vượt giới hạn."],
  ["memberGroup", "member-group", 100, undefined, 15 * MINUTE, true, "Đã vượt giới hạn quản lý nhóm. Hãy thử lại sau."],
];

function bucketHash(subject) {
  return createHash("sha256").update(subject).digest("base64url").slice(0, 24);
}

test("the limiter table matches the frozen contract", () => {
  assert.deepEqual(Object.keys(RATE_LIMITS), LIMITERS.map(([name]) => name));
  for (const [name, label, limit, adminLimit, windowMs, ledgerScoped, message] of LIMITERS) {
    assert.deepEqual(
      RATE_LIMITS[name],
      { label, limit, ...(adminLimit ? { adminLimit } : {}), windowMs, ledgerScoped, message },
      name,
    );
  }
});

test("authentication subjects group IPv6 clients by /64 and unwrap IPv4-mapped addresses", () => {
  assert.equal(authenticationSubject("203.0.113.7"), "203.0.113.7");
  assert.equal(authenticationSubject("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(authenticationSubject("::FFFF:203.0.113.7"), "203.0.113.7");
  assert.equal(authenticationSubject("2001:db8:1:2::1"), "2001:0db8:0001:0002::/64");
  assert.equal(authenticationSubject("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd"), "2001:0db8:0001:0002::/64");
  assert.equal(authenticationSubject("2001:db8::"), "2001:0db8:0000:0000::/64");
  assert.equal(authenticationSubject("::1"), "0000:0000:0000:0000::/64");
  assert.equal(authenticationSubject("local"), "local");
  assert.equal(authenticationSubject("not:an:address"), "not:an:address");
  assert.equal(authenticationSubject("1::2::3"), "1::2::3");
});

test("buckets live in the unprefixed table and each ledger keeps its own write budgets", options, async () => {
  const app = createApp();
  await app.login();
  const ledger = await app.createLedger("Sổ phụ");
  // 60 adds in one hour: one shared 'member' bucket (50/h) would refuse the 51st.
  for (const api of ["/api", ledger.api]) {
    for (let index = 0; index < 30; index += 1) await app.addMember(`Người ${index}`, api);
  }
  assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${ledger.prefix}rate_limits"`), 0);
  const local = bucketHash("local");
  const buckets = Object.fromEntries(app.db.rows("SELECT bucket_key AS key, hit_count AS hits FROM rate_limits")
    .map(({ key, hits }) => [key, hits]));
  assert.deepEqual(buckets, {
    [`login:${local}`]: 1,
    [`create-ledger:${local}`]: 1,
    [`restore-password:${local}`]: 1,
    [`member:chill-guys:${local}`]: 30,
    [`member:${ledger.slug}:${local}`]: 30,
    [`write:chill-guys:${local}`]: 30,
    [`write:${ledger.slug}:${local}`]: 30,
  });
});

test("a full bucket refuses the request without writing anything", options, async () => {
  const app = createApp();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await app.request("POST", "/api/admin/login", { body: WRONG_LOGIN })).status, 401);
  }
  const totalChanges = () => app.db.rows("SELECT total_changes() AS count")[0].count;
  const changes = totalChanges();
  const refused = await app.request("POST", "/api/admin/login", { body: LOGIN });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.data, { error: "Quá nhiều lần đăng nhập. Hãy thử lại sau." });
  assert.equal(totalChanges(), changes);
  assert.deepEqual(app.db.rows("SELECT hit_count AS hits FROM rate_limits"), [{ hits: 10 }]);
});

test("login is limited per client across ledger links, by /64 for IPv6", options, async () => {
  const app = createApp();
  await app.login();
  const ledger = await app.createLedger("Sổ phụ");
  const from = (address) => ({ "cf-connecting-ip": address });
  const sameNetwork = ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:ffff:ffff:ffff:ffff", "2001:0db8:0001:0002::9"];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const api = attempt % 2 ? ledger.api : "/api";
    const response = await app.request("POST", `${api}/admin/login`, {
      body: WRONG_LOGIN,
      headers: from(sameNetwork[attempt % sameNetwork.length]),
    });
    assert.equal(response.status, 401);
  }
  assert.equal((await app.request("POST", "/api/admin/login", { body: LOGIN, headers: from("2001:db8:1:2::abcd") })).status, 429);
  assert.equal((await app.request("POST", "/api/admin/login", { body: LOGIN, headers: from("2001:db8:1:3::1") })).status, 200);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await app.request("POST", "/api/admin/login", { body: WRONG_LOGIN, headers: from("198.51.100.7") });
  }
  assert.equal((await app.request("POST", "/api/admin/login", { body: LOGIN, headers: from("::ffff:198.51.100.7") })).status, 429);
});

test("guest write buckets keep the full IPv6 address", options, async () => {
  const app = createApp();
  for (const address of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2::2"]) {
    const response = await app.request("POST", "/api/expenses", { body: {}, headers: { "cf-connecting-ip": address } });
    assert.equal(response.status, 201);
  }
  assert.deepEqual(
    app.db.rows("SELECT bucket_key AS key, hit_count AS hits FROM rate_limits ORDER BY hit_count"),
    [
      { key: `write:chill-guys:${bucketHash("2001:db8:1:2::1")}`, hits: 1 },
      { key: `write:chill-guys:${bucketHash("2001:db8:1:2::2")}`, hits: 2 },
    ],
  );
});

test("ledger creation and deletion, Store and restore share one operations-password bucket", options, async () => {
  const app = createApp();
  await app.login();
  const passwordAttempts = () => app.count(
    "SELECT COALESCE(SUM(hit_count), 0) AS count FROM rate_limits WHERE bucket_key LIKE 'restore-password:%'",
  );
  const ledger = await app.createLedger("Sổ phụ");
  assert.equal(passwordAttempts(), 1, "the session's first creation checks the password");
  await app.createLedger("Sổ hai");
  assert.equal((await app.request("POST", `${ledger.api}/admin/history-points`, { body: { message: "Mốc" }, admin: true })).status, 201);
  assert.equal(passwordAttempts(), 1, "authorized creations and Stores need no password and spend nothing");

  await app.login();
  // Missing passwords are refused before the limiter, so they cannot use up attempts.
  for (const [method, path, body, error] of [
    ["POST", "/api/admin/history-points", { message: "Mốc", password: "" }, "Nhập mật khẩu thao tác để xác thực Store trong phiên Admin này."],
    ["POST", "/api/admin/ledgers", { name: "Sổ ba", deletePassword: "delete-me-123" }, "Nhập mật khẩu thao tác để tạo sổ trong phiên Admin này."],
    ["DELETE", `/api/admin/ledgers/${ledger.slug}`, {}, "Nhập mật khẩu thao tác."],
  ]) {
    const response = await app.request(method, path, { body, admin: true });
    assert.equal(response.status, 400, path);
    assert.deepEqual(response.data, { error });
  }
  assert.equal(passwordAttempts(), 1);

  for (const [method, path, body] of [
    ["POST", "/api/admin/ledgers", { name: "Sổ ba", password: "wrong" }],
    ["DELETE", `/api/admin/ledgers/${ledger.slug}`, { password: "wrong" }],
    ["POST", `${ledger.api}/admin/history-points`, { message: "Mốc", password: "wrong" }],
    ...["/api", "/api", "/api", ledger.api, ledger.api, ledger.api].map((api) =>
      ["POST", `${api}/admin/history-points/any/restore`, { password: "wrong" }]),
  ]) {
    const response = await app.request(method, path, { body, admin: true });
    assert.equal(response.status, 401, path);
    assert.deepEqual(response.data, { error: "Mật khẩu thao tác không đúng." });
  }
  assert.equal(passwordAttempts(), 10);

  for (const [method, path, body] of [
    ["POST", "/api/admin/ledgers", { name: "Sổ ba", password: "restore-password" }],
    ["DELETE", `/api/admin/ledgers/${ledger.slug}`, { password: "restore-password" }],
    ["POST", "/api/admin/history-points", { message: "Mốc", password: "restore-password" }],
    ["POST", `${ledger.api}/admin/history-points/any/restore`, { password: "restore-password" }],
  ]) {
    const response = await app.request(method, path, { body, admin: true });
    assert.equal(response.status, 429, path);
    assert.deepEqual(response.data, { error: "Đã vượt số lần nhập mật khẩu thao tác. Hãy thử lại sau." });
    const retryAfter = Number(response.headers.get("retry-after"));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 15 * 60, path);
  }
  assert.deepEqual(app.db.rows("SELECT slug FROM ledgers ORDER BY slug").map(({ slug }) => slug),
    ["chill-guys", "so-hai", ledger.slug]);
});

// The clock starts 16 min 40.5 s into an hour, i.e. 1 min 40.5 s into a 15-minute window.
test("a 429 carries Retry-After: the seconds left in the limiter's fixed window", options, async (t) => {
  const hourStart = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: hourStart + 1_000_500 });
  const app = createApp();
  await app.login();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await app.request("POST", "/api/admin/login", { body: WRONG_LOGIN });
  }
  const login = await app.request("POST", "/api/admin/login", { body: LOGIN });
  assert.equal(login.status, 429);
  assert.equal(login.headers.get("retry-after"), "2600");

  // Guests get 300 writes per 15 minutes per client and ledger; Admin keeps 500.
  const windowStart = Math.floor((hourStart + 1_000_500) / (15 * MINUTE)) * 15 * 60;
  app.db.run("INSERT INTO rate_limits (bucket_key, window_start, hit_count) VALUES (?, ?, 299)",
    `write:chill-guys:${bucketHash("local")}`, windowStart);
  assert.equal((await app.request("POST", "/api/expenses", { body: {} })).status, 201);
  const refused = await app.request("POST", "/api/expenses", { body: {} });
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.data, { error: "Đã vượt giới hạn thao tác. Hãy thử lại sau." });
  assert.equal(refused.headers.get("retry-after"), "800");
  assert.equal((await app.request("POST", "/api/expenses", { body: {}, admin: true })).status, 201);
});

// The cleanup shares the limiter's round trip: a wrong login is one D1 query, first hit or not.
test("a bucket's first hit in a new window deletes its older windows, later hits do not", options, async () => {
  const app = createApp();
  const key = `login:${bucketHash("local")}`;
  app.db.run("INSERT INTO rate_limits (bucket_key, window_start, hit_count) VALUES (?, 1, 7), ('other', 1, 7)", key);
  const rows = () => app.db.rows(
    "SELECT bucket_key AS key, window_start > 2 AS current, hit_count AS hits FROM rate_limits ORDER BY bucket_key, window_start",
  );
  const wrongLogin = async () => {
    const queries = app.db.queryCount;
    assert.equal((await app.request("POST", "/api/admin/login", { body: WRONG_LOGIN })).status, 401);
    assert.equal(app.db.queryCount - queries, 1);
  };
  await wrongLogin();
  assert.deepEqual(rows(), [{ key, current: 1, hits: 1 }, { key: "other", current: 0, hits: 7 }]);

  app.db.run("INSERT INTO rate_limits (bucket_key, window_start, hit_count) VALUES (?, 2, 3)", key);
  await wrongLogin();
  assert.deepEqual(rows(), [
    { key, current: 0, hits: 3 },
    { key, current: 1, hits: 2 },
    { key: "other", current: 0, hits: 7 },
  ]);
});
