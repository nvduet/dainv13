import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AUDIT_SESSION_IDLE_MINUTES,
  COLUMN_WIDTH,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_LEDGER,
  FONT_SIZE,
  MAX_AUDIT_SESSIONS,
  MAX_HISTORY_POINTS,
  QR_SIZE,
} from "../public/shared/constants.mjs";
import { createApp } from "./helpers/app.mjs";
import { sqliteUnavailable } from "./helpers/d1-sqlite.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("../public/index.html");

function inputLimits(id) {
  const tag = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  assert.ok(tag, `missing input #${id}`);
  return Object.fromEntries([...tag.matchAll(/\b(min|max|value)="([^"]*)"/g)]
    .map(([, name, value]) => [name, Number(value)]));
}

test("index.html limits, defaults and texts match the shared constants", () => {
  assert.deepEqual(inputLimits("font-size-percent"), { min: FONT_SIZE.min, max: FONT_SIZE.max, value: FONT_SIZE.default });
  assert.deepEqual(inputLimits("qr-size-pixels"), { min: QR_SIZE.min, max: QR_SIZE.max, value: QR_SIZE.default });
  for (const [group, prefix] of [["expense", "col-width-"], ["summary", "col-width-summary-"]]) {
    for (const [key, width] of Object.entries(DEFAULT_COLUMN_WIDTHS[group])) {
      assert.deepEqual(inputLimits(`${prefix}${key}`), { min: COLUMN_WIDTH.min, max: COLUMN_WIDTH.max, value: width }, key);
    }
  }
  assert.ok(html.includes(`Tối đa ${MAX_HISTORY_POINTS} điểm`));
  assert.ok(html.includes(`Tối đa ${MAX_AUDIT_SESSIONS} phiên, gom thay đổi trong vòng ${AUDIT_SESSION_IDLE_MINUTES} phút`));
  assert.ok(html.includes(`<span id="ledger-name">${DEFAULT_LEDGER.name}</span>`));
});

// Trang sổ không được lập chỉ mục (X-Robots-Tag ở public/_headers và Worker được kiểm ở routes.test.mjs).
test("search engines do not index the ledger pages or crawl the API", () => {
  assert.equal(read("../public/robots.txt").replace(/\r\n/g, "\n"), "User-agent: *\nDisallow: /api/\n");
  assert.ok(html.includes(`<meta name="robots" content="noindex, nofollow">`));
});

test("migrations seed the shared defaults", () => {
  const settings = read("../migrations/0012_global_app_settings.sql");
  assert.deepEqual(JSON.parse(settings.match(/\('column-widths', '([^']+)'\)/)[1]), DEFAULT_COLUMN_WIDTHS);
  assert.ok(settings.includes(`('font-size', '${FONT_SIZE.default}')`));
  assert.ok(settings.includes(`('qr-size', '${QR_SIZE.default}')`));
  assert.ok(read("../migrations/0010_multi_ledgers.sql")
    .includes(`VALUES ('default', '${DEFAULT_LEDGER.slug}', '${DEFAULT_LEDGER.name}')`));
});

// Messages that embed a shared constant keep today's exact text.
test("validation messages built from constants are unchanged", { skip: sqliteUnavailable }, async () => {
  const app = createApp();
  await app.login();
  const expense = await app.addExpense();
  assert.deepEqual((await app.state()).ledger, DEFAULT_LEDGER);
  for (const [method, path, body, message] of [
    ["PUT", "/api/admin/font-size", { fontSize: 74 }, "Cỡ chữ phải nằm trong khoảng 75% đến 200%."],
    ["PUT", "/api/admin/qr-size", { qrSize: 1601 }, "Kích thước ảnh QR phải nằm trong khoảng 80px đến 1600px."],
    ["POST", "/api/members", { name: "x".repeat(81) }, "Tên thành viên cần có từ 1 đến 80 ký tự."],
    ["POST", "/api/admin/ledgers", { name: "", password: "restore-password" }, "Tên sổ cần có từ 1 đến 80 ký tự."],
    ["PUT", `/api/expenses/${expense}`, { description: "x".repeat(201) }, "Nội dung không được dài quá 200 ký tự."],
    ["POST", "/api/admin/history-points", { message: "x".repeat(201) }, "Nhập message từ 1 đến 200 ký tự cho điểm lưu."],
  ]) {
    const response = await app.request(method, path, { body, admin: true });
    assert.equal(response.status, 400, path);
    assert.deepEqual(response.data, { error: message });
  }
  const protectedLedger = await app.request("DELETE", `/api/admin/ledgers/${DEFAULT_LEDGER.slug}`, { admin: true });
  assert.equal(protectedLedger.status, 403);
  assert.deepEqual(protectedLedger.data, { error: "Sổ Chill guys hiện tại được bảo vệ và không thể xóa." });
});

test("state falls back to the shared defaults when settings rows are missing", { skip: sqliteUnavailable }, async () => {
  const app = createApp();
  app.db.run("DELETE FROM global_app_settings");
  const { columnWidths, fontSize, qrSize } = await app.state();
  assert.deepEqual(
    { columnWidths, fontSize, qrSize },
    { columnWidths: DEFAULT_COLUMN_WIDTHS, fontSize: FONT_SIZE.default, qrSize: QR_SIZE.default },
  );
});
