import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import test from "node:test";
import { createApp, SECRETS, signedCookie } from "./helpers/app.mjs";
import { createTestDatabase, sqliteUnavailable } from "./helpers/d1-sqlite.mjs";

const LEDGER_SCHEMA_TABLES = [
  "members",
  "expenses",
  "expense_participants",
  "payments",
  "audit_log",
  "rate_limits",
  "app_settings",
  "payment_adjustments",
  "history_points",
  "member_groups",
  "member_group_members",
  "audit_sessions",
  "audit_session_anchor",
  "admin_session_store_auth",
];
const options = { skip: sqliteUnavailable };

test("migrations create every table the worker uses, plus seeded global settings", options, () => {
  const db = createTestDatabase();
  const tables = new Set(db.rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
  for (const table of [...LEDGER_SCHEMA_TABLES, "ledgers", "global_app_settings"]) {
    assert.ok(tables.has(table), `missing table ${table}`);
  }
  assert.deepEqual(db.rows("SELECT id, slug, name FROM ledgers"), [{ id: "default", slug: "chill-guys", name: "Chill guys" }]);
  const settings = Object.fromEntries(db.rows("SELECT key, value_json FROM global_app_settings").map((row) => [row.key, row.value_json]));
  assert.equal(settings["font-size"], "90");
  assert.equal(settings["qr-size"], "250");
  assert.equal(JSON.parse(settings["column-widths"]).expense.date, 110);
});

test("guests save expense drafts field by field with server-side validation", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const binh = await app.addMember("Bình");
  const chi = await app.addMember("Chi");

  const created = await app.request("POST", "/api/expenses", { body: {} });
  assert.equal(created.status, 201);
  const { id } = created.data.expense;
  assert.deepEqual(created.data.expense, {
    id,
    payerId: null,
    date: null,
    description: "",
    amountVnd: 0,
    participantIds: [],
    createdAt: null,
    updatedAt: null,
  });

  const put = (body) => app.request("PUT", `/api/expenses/${id}`, { body });
  assert.equal((await put({ payerId: an })).data.expense.payerId, an);
  assert.equal((await put({ date: "2026-10-20" })).data.expense.date, "2026-10-20");
  assert.equal((await put({ description: "  Ăn trưa  " })).data.expense.description, "Ăn trưa");
  assert.equal((await put({ amountVnd: -360_000 })).data.expense.amountVnd, -360_000);
  const withParticipants = await put({ participantChanges: { add: [chi, an, binh] } });
  assert.deepEqual(new Set(withParticipants.data.expense.participantIds), new Set([an, binh, chi]));

  for (const [body, message] of [
    [{ date: "2026-02-30" }, "Ngày phải có định dạng YYYY-MM-DD hợp lệ."],
    [{ foo: 1 }, "Không có trường khoản chi hợp lệ để lưu."],
    [{}, "Không có trường khoản chi hợp lệ để lưu."],
    [{ payerId: "nobody" }, "Một hoặc nhiều thành viên không còn tồn tại."],
    [{ participantChanges: { add: [an, "nobody"] } }, "Một hoặc nhiều thành viên không còn tồn tại."],
    [{ description: "x".repeat(201) }, "Nội dung không được dài quá 200 ký tự."],
    [{ amountVnd: 1.5 }, "Số tiền phải là số đồng nguyên trong giới hạn cho phép."],
    [{ amountVnd: 1_000_000_000_001 }, "Số tiền phải là số đồng nguyên trong giới hạn cho phép."],
    [{ participantChanges: { add: [an, an] } }, "Danh sách người tham gia không hợp lệ."],
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.data.error, message);
  }

  assert.equal((await put({ payerId: "" })).data.expense.payerId, null);
  assert.equal((await put({ date: "" })).data.expense.date, null);
  assert.deepEqual((await put({ participantChanges: { remove: [an, binh, chi] } })).data.expense.participantIds, []);

  const state = await app.state();
  const saved = state.expenses.find((expense) => expense.id === id);
  assert.equal(saved.payerId, null);
  assert.equal(saved.description, "Ăn trưa");
  assert.equal(saved.amountVnd, -360_000);
  assert.deepEqual(saved.participantIds, []);

  assert.equal((await app.request("DELETE", `/api/expenses/${id}`)).status, 200);
  assert.equal((await app.request("DELETE", `/api/expenses/${id}`)).status, 404);
  assert.equal((await app.request("PUT", `/api/expenses/${id}`, { body: { amountVnd: 1 } })).status, 404);
});

test("participant ticks from several devices merge through participantChanges", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const binh = await app.addMember("Bình");
  const chi = await app.addMember("Chi");
  const id = await app.addExpense({ payerId: an, amountVnd: 90_000, participantChanges: { add: [an] } });
  const put = (body) => app.request("PUT", `/api/expenses/${id}`, { body });

  assert.equal((await put({ participantChanges: { add: [binh] } })).status, 200);
  const second = await put({ participantChanges: { add: [chi] } });
  assert.deepEqual(new Set(second.data.expense.participantIds), new Set([an, binh, chi]));
  const removed = await put({ participantChanges: { remove: [an, "not-a-participant"] } });
  assert.equal(removed.status, 200);
  assert.deepEqual(new Set(removed.data.expense.participantIds), new Set([binh, chi]));
  const repeated = await put({ participantChanges: { add: [binh] } });
  assert.deepEqual(new Set(repeated.data.expense.participantIds), new Set([binh, chi]));

  for (const body of [
    { participantChanges: { add: [an], remove: [an] } },
    { participantChanges: { add: [an, an] } },
    { participantChanges: { add: "x" } },
    { participantChanges: { other: [] } },
    { participantChanges: null },
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.data.error, "Danh sách người tham gia không hợp lệ.");
  }
  const unknown = await put({ participantChanges: { add: ["nobody"] } });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.data.error, "Một hoặc nhiều thành viên không còn tồn tại.");

  // Only tabs opened before the deploy send the full list: they are told to reload, and nothing changes.
  for (const body of [
    { participantIds: [an] },
    { participantIds: [an], payerId: an },
    { participantChanges: { add: [an] }, participantIds: [an] },
  ]) {
    const stale = await put(body);
    assert.equal(stale.status, 409, JSON.stringify(body));
    assert.deepEqual(stale.data, { error: "Trang đang dùng phiên bản cũ. Hãy tải lại trang rồi thử lại." });
  }
  assert.deepEqual(new Set((await app.state()).expenses[0].participantIds), new Set([binh, chi]));

  const actions = app.db.rows("SELECT action FROM audit_log WHERE entity = 'expense_participant' ORDER BY id").map((row) => row.action);
  assert.deepEqual(actions, ["participant_add", "participant_add", "participant_add", "participant_remove"]);
});

test("expense edits write one audit row per changed field and participant toggle", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const binh = await app.addMember("Bình");
  const id = await app.addExpense({ payerId: an, amountVnd: 100_000, participantChanges: { add: [an] } });
  const before = app.db.rows("SELECT COUNT(*) AS count FROM audit_log")[0].count;
  await app.request("PUT", `/api/expenses/${id}`, {
    body: { description: "Taxi", amountVnd: 100_000, participantChanges: { add: [binh], remove: [an] } },
  });
  const entries = app.db.rows(
    "SELECT actor, action, entity, entity_id AS entityId, before_json AS beforeJson, after_json AS afterJson FROM audit_log ORDER BY id",
  ).slice(before);
  assert.deepEqual(entries.map((entry) => entry.action).sort(), ["participant_add", "participant_remove", "update"].sort());
  assert.ok(entries.every((entry) => entry.actor === "public"));
  const fieldUpdate = entries.find((entry) => entry.action === "update");
  assert.deepEqual(JSON.parse(fieldUpdate.afterJson), { field: "description", value: "Taxi" });
});

test("members are admin-managed, unique ignoring case, and hard delete cascades", options, async () => {
  const app = createApp();
  assert.equal((await app.request("POST", "/api/members", { body: { name: "X" } })).status, 401);
  await app.login();
  const an = await app.addMember("An");
  const binh = await app.addMember("Bình");
  const chi = await app.addMember("Chi");
  const duplicate = await app.request("POST", "/api/members", { body: { name: "an" }, admin: true });
  assert.equal(duplicate.status, 409);
  assert.equal((await app.request("POST", "/api/members", { body: { name: "   " }, admin: true })).status, 400);
  assert.equal((await app.request("PATCH", `/api/members/${chi}`, { body: { name: "Chi Mới" }, admin: true })).status, 200);
  assert.equal((await app.request("PATCH", "/api/members/missing", { body: { name: "Z" }, admin: true })).status, 404);
  assert.equal((await app.request("PATCH", `/api/members/${chi}`, { body: { name: "AN" }, admin: true })).status, 409);

  await app.request("POST", "/api/admin/member-groups", { body: { name: "Nhóm", memberIds: [an, binh] }, admin: true });
  const paidByAn = await app.addExpense({ payerId: an, amountVnd: 90_000, participantChanges: { add: [binh, chi] } });
  const sharedWithAn = await app.addExpense({ payerId: chi, amountVnd: 60_000, participantChanges: { add: [an, chi] } });
  const unrelated = await app.addExpense({ payerId: chi, amountVnd: 30_000, participantChanges: { add: [binh, chi] } });
  await app.request("PUT", "/api/admin/payments/total", { body: { memberId: an, amountVnd: 50_000 }, admin: true });

  const deleted = await app.request("DELETE", `/api/members/${an}`, { admin: true });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { deleted: true, impactedExpenses: 2 });
  const state = await app.state("/api", true);
  assert.deepEqual(state.members.map((member) => member.name), ["Bình", "Chi Mới"]);
  assert.deepEqual(state.expenses.map((expense) => expense.id), [unrelated]);
  assert.ok(!state.expenses.some((expense) => [paidByAn, sharedWithAn].includes(expense.id)));
  assert.equal(state.payments.filter((payment) => payment.memberId === an).length, 0);
  assert.deepEqual(state.groups, []);
  assert.equal(app.db.rows("SELECT COUNT(*) AS count FROM payment_adjustments")[0].count, 0);
});

test("member groups are exclusive and grouped members are listed together", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const binh = await app.addMember("Bình");
  const chi = await app.addMember("Chi");
  const dung = await app.addMember("Dũng");

  const guest = await app.request("POST", "/api/admin/member-groups", { body: { name: "G", memberIds: [an, binh] } });
  assert.equal(guest.status, 401);
  const created = await app.request("POST", "/api/admin/member-groups", { body: { name: "Nhà Vải", memberIds: [dung, binh] }, admin: true });
  assert.equal(created.status, 201);
  const groupId = created.data.group.id;
  assert.equal((await app.request("POST", "/api/admin/member-groups", { body: { name: "Solo", memberIds: [an] }, admin: true })).status, 400);
  const conflict = await app.request("POST", "/api/admin/member-groups", { body: { name: "Khác", memberIds: [an, dung] }, admin: true });
  assert.equal(conflict.status, 400);
  assert.equal(conflict.data.error, "Một thành viên không thể thuộc hai nhóm.");
  assert.equal((await app.request("POST", "/api/admin/member-groups", { body: { name: "Khác", memberIds: [an, "missing"] }, admin: true })).status, 404);
  assert.equal((await app.request("POST", "/api/admin/member-groups", { body: { name: "nhà vải", memberIds: [an, chi] }, admin: true })).status, 409);

  let state = await app.state();
  assert.deepEqual(state.members.map((member) => member.name), ["Bình", "Dũng", "An", "Chi"]);
  assert.deepEqual(state.groups.map((group) => [group.name, group.memberIds]), [["Nhà Vải", [binh, dung]]]);

  const updated = await app.request("PUT", `/api/admin/member-groups/${groupId}`, {
    body: { name: "Nhà Vải 2", memberIds: [chi, an] },
    admin: true,
  });
  assert.equal(updated.status, 200);
  state = await app.state();
  assert.deepEqual(state.members.map((member) => member.name), ["An", "Chi", "Bình", "Dũng"]);

  assert.equal((await app.request("DELETE", `/api/admin/member-groups/${groupId}`, { admin: true })).status, 200);
  assert.equal((await app.request("DELETE", `/api/admin/member-groups/${groupId}`, { admin: true })).status, 404);
  state = await app.state();
  assert.deepEqual(state.groups, []);
  assert.ok(state.members.every((member) => member.groupId === null));
});

test("paid transfer totals are reconciled with signed audited adjustments", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  assert.equal((await app.request("PUT", "/api/admin/payments/total", { body: { memberId: an, amountVnd: 1 } })).status, 401);
  const first = await app.request("PUT", "/api/admin/payments/total", { body: { memberId: an, amountVnd: 120_000 }, admin: true });
  // W-06: the response also carries the new adjustment row (additive), shaped like /api/state's entries.
  const { adjustment: firstAdjustment, ...firstTotals } = first.data;
  assert.deepEqual(firstTotals, { amountVnd: 120_000, adjustmentVnd: 120_000 });
  const unchanged = await app.request("PUT", "/api/admin/payments/total", { body: { memberId: an, amountVnd: 120_000 }, admin: true });
  assert.deepEqual(unchanged.data, { amountVnd: 120_000, changed: false });
  const negative = await app.request("PUT", "/api/admin/payments/total", { body: { memberId: an, amountVnd: -30_000 }, admin: true });
  const { adjustment: negativeAdjustment, ...negativeTotals } = negative.data;
  assert.deepEqual(negativeTotals, { amountVnd: -30_000, adjustmentVnd: -150_000 });
  assert.equal((await app.request("PUT", "/api/admin/payments/total", { body: { memberId: "missing", amountVnd: 5 }, admin: true })).status, 404);
  assert.equal((await app.request("PUT", "/api/admin/payments/total", { body: { memberId: an, amountVnd: 1.5 }, admin: true })).status, 400);

  const state = await app.state("/api", true);
  const adjustments = state.payments.filter((payment) => payment.memberId === an);
  assert.equal(adjustments.length, 2);
  assert.ok(adjustments.every((payment) => payment.adjustment === true && payment.status === "confirmed" &&
    payment.direction === "member_to_admin" && payment.id.startsWith("adjustment-")));
  assert.equal(adjustments.reduce((sum, payment) => sum + payment.amountVnd, 0), -30_000);
  for (const returned of [firstAdjustment, negativeAdjustment]) {
    assert.deepEqual(returned, adjustments.find((payment) => payment.id === returned.id));
  }
});

test("global settings are admin-only, validated and shared by every ledger", options, async () => {
  const app = createApp();
  assert.equal((await app.request("PUT", "/api/admin/font-size", { body: { fontSize: 100 } })).status, 401);
  await app.login();
  assert.equal((await app.request("PUT", "/api/admin/font-size", { body: { fontSize: 74 }, admin: true })).status, 400);
  assert.equal((await app.request("PUT", "/api/admin/font-size", { body: { fontSize: 120 }, admin: true })).status, 200);
  assert.equal((await app.request("PUT", "/api/admin/qr-size", { body: { qrSize: 1601 }, admin: true })).status, 400);
  assert.equal((await app.request("PUT", "/api/admin/qr-size", { body: { qrSize: 320 }, admin: true })).status, 200);
  const defaults = (await app.state()).columnWidths;
  const widths = { ...defaults, summary: { ...defaults.summary, member: 140 } };
  assert.equal((await app.request("PUT", "/api/admin/column-widths", {
    body: { ...widths, extra: {} }, admin: true,
  })).status, 400);
  assert.equal((await app.request("PUT", "/api/admin/column-widths", { body: widths, admin: true })).status, 200);

  await app.createLedger("Sổ phụ");
  for (const api of ["/api", "/api/g/so-phu"]) {
    const state = await app.state(api);
    assert.equal(state.fontSize, 120);
    assert.equal(state.qrSize, 320);
    assert.deepEqual(state.columnWidths, widths);
  }
});

test("history points restore Detail data but keep settings and the audit trail", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const binh = await app.addMember("Bình");
  const chi = await app.addMember("Chi");
  await app.request("POST", "/api/admin/member-groups", { body: { name: "Nhóm", memberIds: [an, binh] }, admin: true });
  const expenseId = await app.addExpense({ payerId: an, amountVnd: 90_000, participantChanges: { add: [an, binh, chi] } });
  await app.request("PUT", "/api/admin/payments/total", { body: { memberId: an, amountVnd: 10_000 }, admin: true });

  assert.equal((await app.request("GET", "/api/admin/history-points")).status, 401);
  const noPassword = await app.request("POST", "/api/admin/history-points", { body: { message: "Mốc 1" }, admin: true });
  assert.equal(noPassword.status, 400);
  const wrongPassword = await app.request("POST", "/api/admin/history-points", {
    body: { message: "Mốc 1", password: "bad" }, admin: true,
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal((await app.request("POST", "/api/admin/history-points", {
    body: { message: "x".repeat(201), password: "restore-password" }, admin: true,
  })).status, 400);
  const stored = await app.request("POST", "/api/admin/history-points", {
    body: { message: "  Mốc 1  ", password: "restore-password" }, admin: true,
  });
  assert.equal(stored.status, 201);
  assert.equal(stored.data.point.message, "Mốc 1");
  assert.equal(stored.data.storePasswordVerified, true);
  assert.equal((await app.state("/api", true)).storePasswordVerified, true);
  const second = await app.request("POST", "/api/admin/history-points", { body: { message: "Mốc 2" }, admin: true });
  assert.equal(second.status, 201);
  const list = await app.request("GET", "/api/admin/history-points", { admin: true });
  assert.deepEqual(list.data.points.map((point) => point.message).sort(), ["Mốc 1", "Mốc 2"]);

  await app.request("PUT", `/api/expenses/${expenseId}`, { body: { amountVnd: 999_000, participantChanges: { remove: [an, binh] } } });
  await app.request("DELETE", `/api/members/${chi}`, { admin: true });
  await app.request("PUT", "/api/admin/font-size", { body: { fontSize: 150 }, admin: true });
  const sessionsBefore = app.db.rows("SELECT COUNT(*) AS count FROM audit_sessions")[0].count;

  const pointId = stored.data.point.id;
  assert.equal((await app.request("POST", `/api/admin/history-points/${pointId}/restore`, { body: { password: "bad" }, admin: true })).status, 401);
  assert.equal((await app.request("POST", "/api/admin/history-points/missing/restore", { body: { password: "restore-password" }, admin: true })).status, 404);
  const restored = await app.request("POST", `/api/admin/history-points/${pointId}/restore`, {
    body: { password: "restore-password" }, admin: true,
  });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.data, { restored: true });

  const state = await app.state("/api", true);
  assert.deepEqual(state.members.map((member) => member.name), ["An", "Bình", "Chi"]);
  const expense = state.expenses.find((item) => item.id === expenseId);
  assert.equal(expense.amountVnd, 90_000);
  assert.equal(expense.participantIds.length, 3);
  assert.equal(state.fontSize, 150);
  assert.equal(state.payments.reduce((sum, payment) => sum + payment.amountVnd, 0), 10_000);
  assert.deepEqual(state.groups.map((group) => group.name), ["Nhóm"]);
  assert.ok(app.db.rows("SELECT COUNT(*) AS count FROM audit_sessions")[0].count >= sessionsBefore);
});

test("deleting a Store point always asks for the operations password and leaves the ledger's data untouched", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  await app.addExpense({ payerId: an, amountVnd: 50_000, participantChanges: { add: [an] } });
  const first = await app.request("POST", "/api/admin/history-points", {
    body: { message: "Mốc 1", password: "restore-password" }, admin: true,
  });
  const second = await app.request("POST", "/api/admin/history-points", { body: { message: "Mốc 2" }, admin: true });
  assert.equal(second.status, 201, "the session is authorized for Store");
  const pointId = first.data.point.id;
  const path = `/api/admin/history-points/${pointId}`;
  const stateBefore = await app.state("/api", true);
  const { createdAt } = (await app.request("GET", "/api/admin/history-points", { admin: true }))
    .data.points.find((point) => point.id === pointId);

  assert.equal((await app.request("DELETE", path)).status, 401);
  // A Store authorization does not cover deleting: the password is always asked for.
  for (const [body, status, error] of [
    [undefined, 400, "Nhập mật khẩu thao tác."],
    [{ password: "" }, 400, "Nhập mật khẩu thao tác."],
    [{ password: "bad" }, 401, "Mật khẩu thao tác không đúng."],
  ]) {
    const response = await app.request("DELETE", path, { body, admin: true });
    assert.equal(response.status, status, JSON.stringify(body));
    assert.deepEqual(response.data, { error });
  }
  assert.equal(app.count("SELECT COUNT(*) AS count FROM history_points"), 2);
  const missing = await app.request("DELETE", "/api/admin/history-points/missing", { body: { password: "restore-password" }, admin: true });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.data, { error: "Không tìm thấy điểm khôi phục." });

  const queries = app.db.queryCount;
  const deleted = await app.request("DELETE", path, { body: { password: "restore-password" }, admin: true });
  assert.equal(deleted.status, 200);
  assert.equal(app.db.queryCount - queries, 3, "point lookup, password limiter, delete + audit");
  assert.deepEqual(deleted.data, { deleted: true, id: pointId });
  const list = await app.request("GET", "/api/admin/history-points", { admin: true });
  assert.deepEqual(list.data.points.map((point) => point.message), ["Mốc 2"]);
  const stateAfter = await app.state("/api", true);
  assert.deepEqual([stateAfter.members, stateAfter.expenses, stateAfter.payments], [stateBefore.members, stateBefore.expenses, stateBefore.payments]);
  const [entry] = app.db.rows("SELECT actor, action, entity, entity_id AS entityId, before_json AS beforeJson, after_json AS afterJson FROM audit_log WHERE action = 'delete' AND entity = 'history_point'");
  assert.deepEqual({ ...entry, beforeJson: JSON.parse(entry.beforeJson) }, {
    actor: "admin", action: "delete", entity: "history_point", entityId: pointId, afterJson: null,
    beforeJson: { createdAt, memberCount: 1, expenseCount: 1, message: "Mốc 1" },
  });

  assert.equal((await app.request("DELETE", path, { body: { password: "restore-password" }, admin: true })).status, 404);
  assert.equal((await app.request("POST", `${path}/restore`, { body: { password: "restore-password" }, admin: true })).status, 404);

  // A point belongs to its ledger: another ledger's API cannot see or delete it.
  const ledger = await app.createLedger("Sổ phụ");
  const scoped = await app.request("POST", `${ledger.api}/admin/history-points`, {
    body: { message: "Mốc sổ phụ", password: "restore-password" }, admin: true,
  });
  const scopedPath = `/admin/history-points/${scoped.data.point.id}`;
  assert.equal((await app.request("DELETE", `/api${scopedPath}`, { body: { password: "restore-password" }, admin: true })).status, 404);
  assert.equal((await app.request("DELETE", `${ledger.api}${scopedPath}`, { body: { password: "restore-password" }, admin: true })).status, 200);
  assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${ledger.prefix}history_points"`), 0);
  assert.equal(app.count("SELECT COUNT(*) AS count FROM history_points"), 1);
});

test("every operations-password check refuses a missing secret or one equal to the Admin password", options, async () => {
  const app = createApp();
  await app.login();
  const ledger = await app.createLedger("Sổ phụ");
  await app.login();
  const point = (await app.request("POST", "/api/admin/history-points", {
    body: { message: "Mốc", password: SECRETS.HISTORY_RESTORE_PASSWORD }, admin: true,
  })).data.point;
  await app.login(); // a fresh session, not yet authorized for ledger creation and Store
  for (const [secret, error] of [
    [undefined, "Chưa cấu hình mật khẩu thao tác phía máy chủ."],
    [SECRETS.ADMIN_PASSWORD, "Mật khẩu thao tác phải khác mật khẩu Admin. Hãy cấu hình lại secret."],
  ]) {
    app.env.HISTORY_RESTORE_PASSWORD = secret;
    for (const [method, path, body] of [
      ["POST", "/api/admin/ledgers", { name: "Sổ mới", password: SECRETS.ADMIN_PASSWORD }],
      ["DELETE", `/api/admin/ledgers/${ledger.slug}`, { password: SECRETS.ADMIN_PASSWORD }],
      ["POST", `${ledger.api}/admin/history-points`, { message: "Mốc", password: SECRETS.ADMIN_PASSWORD }],
      ["POST", "/api/admin/history-points/any/restore", { password: SECRETS.ADMIN_PASSWORD }],
      ["DELETE", `/api/admin/history-points/${point.id}`, { password: SECRETS.ADMIN_PASSWORD }],
    ]) {
      const response = await app.request(method, path, { body, admin: true });
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(response.data, { error });
    }
  }
  assert.equal(app.count("SELECT COUNT(*) AS count FROM ledgers"), 2);
  assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${ledger.prefix}history_points"`), 0);
  assert.equal(app.count("SELECT COUNT(*) AS count FROM history_points"), 1);
});

test("creating a ledger asks for the operations password once per Admin session, for every ledger", options, async () => {
  const app = createApp();
  await app.login();
  const create = (body) => app.request("POST", "/api/admin/ledgers", { body, admin: true });
  // An old cached page still sends deletePassword; it is ignored.
  const missing = await create({ name: "Sổ A", deletePassword: "delete-me-123" });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.data, { error: "Nhập mật khẩu thao tác để tạo sổ trong phiên Admin này." });
  const wrong = await create({ name: "Sổ A", password: "delete-me-123" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, { error: "Mật khẩu thao tác không đúng." });
  assert.equal(app.count("SELECT COUNT(*) AS count FROM ledgers"), 1);
  assert.equal((await app.state("/api", true)).storePasswordVerified, false);

  const created = await create({ name: "Sổ A", password: "restore-password", deletePassword: "delete-me-123" });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data, {
    ledger: { id: created.data.ledger.id, slug: "so-a", name: "Sổ A" },
    storePasswordVerified: true,
  });
  assert.deepEqual(app.db.rows("SELECT delete_password_salt AS salt, delete_password_hash AS hash FROM ledgers WHERE slug = 'so-a'"),
    [{ salt: null, hash: null }]);
  const second = await create({ name: "Sổ B" });
  assert.equal(second.status, 201);
  assert.equal(second.data.storePasswordVerified, true);
  for (const api of ["/api", "/api/g/so-a", "/api/g/so-b"]) {
    assert.equal((await app.state(api, true)).storePasswordVerified, true, api);
    const stored = await app.request("POST", `${api}/admin/history-points`, { body: { message: "Mốc" }, admin: true });
    assert.equal(stored.status, 201, api);
  }
  // One authorization, kept in the unprefixed table; the ledgers' own copies stay unused.
  assert.equal(app.count("SELECT COUNT(*) AS count FROM admin_session_store_auth"), 1);
  for (const { id } of [created.data.ledger, second.data.ledger]) {
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "ledger_${id}_admin_session_store_auth"`), 0);
  }
  // Restore still always asks.
  const restore = await app.request("POST", "/api/g/so-a/admin/history-points/any/restore", { body: {}, admin: true });
  assert.equal(restore.status, 400);
  assert.deepEqual(restore.data, { error: "Nhập mật khẩu thao tác." });

  await app.login();
  assert.equal((await app.state("/api/g/so-b", true)).storePasswordVerified, false);
  assert.equal((await create({ name: "Sổ C" })).status, 400);
  assert.equal((await app.request("POST", "/api/g/so-b/admin/history-points", { body: { message: "Mốc" }, admin: true })).status, 400);
});

test("a Store authorization from one ledger covers Store in another ledger and ledger creation", options, async () => {
  const app = createApp();
  await app.login();
  const ledger = await app.createLedger("Sổ A");
  await app.login();
  assert.equal((await app.request("POST", `${ledger.api}/admin/history-points`, { body: { message: "Mốc" }, admin: true })).status, 400);
  const stored = await app.request("POST", "/api/admin/history-points", {
    body: { message: "Mốc", password: "restore-password" }, admin: true,
  });
  assert.equal(stored.status, 201);
  assert.equal(stored.data.storePasswordVerified, true);
  assert.equal((await app.request("POST", `${ledger.api}/admin/history-points`, { body: { message: "Mốc" }, admin: true })).status, 201);
  assert.equal((await app.state(ledger.api, true)).storePasswordVerified, true);
  assert.equal((await app.request("POST", "/api/admin/ledgers", { body: { name: "Sổ B" }, admin: true })).status, 201);
});

test("the operations authorization lasts 8 hours and is asked for again once it expires", options, async () => {
  const app = createApp();
  await app.login();
  const ledger = await app.createLedger("Sổ A");
  const hoursLeft = () => app.db.rows(
    "SELECT (julianday(expires_at) - julianday('now')) * 24 AS hours FROM admin_session_store_auth",
  ).map(({ hours }) => Math.round(hours * 100) / 100);
  assert.deepEqual(hoursLeft(), [8]);

  app.db.run("UPDATE admin_session_store_auth SET expires_at = datetime('now', '-1 second')");
  assert.equal((await app.state(ledger.api, true)).storePasswordVerified, false);
  for (const [path, body, error] of [
    ["/api/admin/ledgers", { name: "Sổ B" }, "Nhập mật khẩu thao tác để tạo sổ trong phiên Admin này."],
    [`${ledger.api}/admin/history-points`, { message: "Mốc" }, "Nhập mật khẩu thao tác để xác thực Store trong phiên Admin này."],
  ]) {
    const response = await app.request("POST", path, { body, admin: true });
    assert.equal(response.status, 400, path);
    assert.deepEqual(response.data, { error });
  }

  // Entering the password again renews the session's row for another 8 hours.
  const stored = await app.request("POST", `${ledger.api}/admin/history-points`, {
    body: { message: "Mốc", password: SECRETS.HISTORY_RESTORE_PASSWORD }, admin: true,
  });
  assert.equal(stored.status, 201);
  assert.deepEqual(hoursLeft(), [8]);
  assert.equal((await app.state("/api", true)).storePasswordVerified, true);
});

test("transfer totals are part of the audit snapshots and a changed total is recorded in a session", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const binh = await app.addMember("Bình");
  await app.addExpense({ payerId: an, amountVnd: 100_000, participantChanges: { add: [an, binh] } });
  // A legacy refund (Admin → member) and a legacy confirmed payment are counted like the Summary counts them.
  app.db.run(`INSERT INTO payments (id, member_id, direction, amount_vnd, status) VALUES
    ('p-refund', '${an}', 'admin_to_member', 20000, 'confirmed'),
    ('p-pending', '${an}', 'member_to_admin', 99000, 'pending')`);
  app.db.run("UPDATE audit_sessions SET last_activity = datetime('now', '-31 minutes')");
  const sessionsBefore = app.count("SELECT COUNT(*) AS count FROM audit_sessions");

  const saved = await app.request("PUT", "/api/admin/payments/total", { body: { memberId: binh, amountVnd: 50_000 }, admin: true });
  assert.equal(saved.status, 200);
  const sessions = (await app.request("GET", "/api/admin/audit", { admin: true })).data.sessions;
  assert.equal(sessions.length, sessionsBefore + 1, "the transfer opened a new session");
  const { session } = (await app.request("GET", `/api/admin/audit/${sessions[0].id}`, { admin: true })).data;
  assert.deepEqual(session.actors, ["admin"]);
  const sorted = (transfers) => [...transfers].sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  // "before" is the previous session's last snapshot, taken before the rows were inserted behind the app's back.
  assert.deepEqual(session.before.transfers, []);
  assert.deepEqual(sorted(session.after.transfers), sorted([
    { memberId: an, paidToAdminVnd: 0, refundedVnd: 20_000 },
    { memberId: binh, paidToAdminVnd: 50_000, refundedVnd: 0 },
  ]));
  assert.deepEqual(session.after.expenses, session.before.expenses);

  // Saving the same total again changes nothing: no adjustment, the session is not touched.
  const activity = app.db.rows("SELECT last_activity AS value, after_json AS json FROM audit_sessions ORDER BY rowid DESC LIMIT 1")[0];
  app.db.run("UPDATE audit_sessions SET last_activity = datetime('now', '-1 minute')");
  const again = await app.request("PUT", "/api/admin/payments/total", { body: { memberId: binh, amountVnd: 50_000 }, admin: true });
  assert.deepEqual(again.data, { amountVnd: 50_000, changed: false });
  const after = app.db.rows("SELECT last_activity AS value, after_json AS json FROM audit_sessions ORDER BY rowid DESC LIMIT 1")[0];
  assert.equal(after.json, activity.json);
  assert.notEqual(after.value, activity.value, "untouched: still the backdated activity time");
});

test("detail audit sessions merge activity within 30 minutes and expose before/after snapshots", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const expenseId = await app.addExpense({ payerId: an, description: "Cơm", amountVnd: 50_000, participantChanges: { add: [an] } });

  let sessions = (await app.request("GET", "/api/admin/audit", { admin: true })).data.sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].adminSeen, 1);
  assert.equal(sessions[0].guestSeen, 1);
  const first = (await app.request("GET", `/api/admin/audit/${sessions[0].id}`, { admin: true })).data.session;
  assert.deepEqual(first.actors, ["admin", "guest"]);
  assert.deepEqual(first.before.members, []);
  assert.deepEqual(first.after.members.map((member) => member.name), ["An"]);
  assert.equal(first.after.expenses[0].description, "Cơm");

  const lastActivity = app.db.rows("SELECT last_activity AS value FROM audit_sessions")[0].value;
  await app.request("PUT", `/api/expenses/${expenseId}`, { body: { description: "Cơm" } });
  assert.equal(app.db.rows("SELECT last_activity AS value FROM audit_sessions")[0].value, lastActivity);
  assert.equal((await app.request("PUT", `/api/expenses/${expenseId}`, { body: { foo: 1 } })).status, 400);
  assert.equal(app.db.rows("SELECT COUNT(*) AS count FROM audit_sessions")[0].count, 1);

  app.db.run("UPDATE audit_sessions SET started_at = datetime('now', '-2 hours'), last_activity = datetime('now', '-31 minutes')");
  await app.request("PUT", `/api/expenses/${expenseId}`, { body: { description: "Phở" } });
  sessions = (await app.request("GET", "/api/admin/audit", { admin: true })).data.sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].guestSeen, 1);
  assert.equal(sessions[0].adminSeen, 0);
  const second = (await app.request("GET", `/api/admin/audit/${sessions[0].id}`, { admin: true })).data.session;
  assert.deepEqual(second.actors, ["guest"]);
  assert.equal(second.before.expenses[0].description, "Cơm");
  assert.equal(second.after.expenses[0].description, "Phở");
  assert.equal((await app.request("GET", "/api/admin/audit/missing", { admin: true })).status, 404);
  assert.equal((await app.request("GET", "/api/admin/audit")).status, 401);
});

test("audit sessions and the audit log never exceed 999 entries", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  app.db.run("UPDATE audit_sessions SET last_activity = datetime('now', '-3 hours')");
  app.db.run("DELETE FROM audit_sessions");
  app.db.run("UPDATE audit_session_anchor SET snapshot_json = '{\"marker\":0}'");
  for (let index = 1; index <= 999; index += 1) {
    app.db.run(
      "INSERT INTO audit_sessions (id, started_at, last_activity, after_json) VALUES (?, datetime('now', '-3 hours'), datetime('now', '-3 hours'), ?)",
      `session-${index}`,
      JSON.stringify({ marker: index }),
    );
  }
  await app.request("PATCH", `/api/members/${an}`, { body: { name: "An Mới" }, admin: true });
  const sessions = app.db.rows("SELECT id, after_json AS afterJson FROM audit_sessions ORDER BY rowid");
  assert.equal(sessions.length, 999);
  assert.equal(sessions[0].id, "session-2");
  assert.equal(app.db.rows("SELECT snapshot_json AS value FROM audit_session_anchor")[0].value, "{\"marker\":1}");
  assert.equal(JSON.parse(sessions.at(-1).afterJson).members[0].name, "An Mới");

  for (let index = 0; index < 1005; index += 1) {
    app.db.run(
      "INSERT INTO audit_log (actor, action, entity, entity_id) VALUES ('admin', 'test', 'test', ?)",
      String(index),
    );
  }
  const [{ count, newest }] = app.db.rows("SELECT COUNT(*) AS count, MAX(entity_id + 0) AS newest FROM audit_log WHERE action = 'test'");
  assert.equal(app.db.rows("SELECT COUNT(*) AS count FROM audit_log")[0].count, 999);
  assert.equal(count, 999);
  assert.equal(newest, 1004);
});

test("ledgers are isolated by link and deleting one drops every prefixed object", options, async () => {
  const app = createApp();
  assert.equal((await app.request("POST", "/api/admin/ledgers", { body: { name: "X", password: "restore-password" } })).status, 401);
  await app.login();
  const defaultMember = await app.addMember("An");
  const defaultExpense = await app.addExpense({ payerId: defaultMember, amountVnd: 10_000, participantChanges: { add: [defaultMember] } });

  for (const [body, error] of [
    [{ name: "!!!", password: "restore-password" }, "Tên sổ cần chứa ít nhất một ký tự chữ hoặc số."],
    [{ name: "", password: "restore-password" }, "Tên sổ cần có từ 1 đến 80 ký tự."],
  ]) {
    const response = await app.request("POST", "/api/admin/ledgers", { body, admin: true });
    assert.equal(response.status, 400);
    assert.deepEqual(response.data, { error });
  }
  const created = await app.request("POST", "/api/admin/ledgers", { body: { name: "Đà Lạt 2026", password: "restore-password" }, admin: true });
  assert.equal(created.status, 201);
  assert.equal(created.data.ledger.slug, "da-lat-2026");
  assert.equal(created.data.ledger.name, "Đà Lạt 2026");
  const ledgerId = created.data.ledger.id;
  assert.match(ledgerId, /^[0-9a-f]{32}$/);
  const duplicate = await app.request("POST", "/api/admin/ledgers", { body: { name: "đà lạt 2026!" }, admin: true });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.data, { error: "Tên này đã được dùng để tạo link sổ khác." });

  const prefix = `ledger_${ledgerId}_`;
  const defaultObjects = app.db.rows(
    `SELECT type, name FROM sqlite_master WHERE tbl_name IN (${LEDGER_SCHEMA_TABLES.map(() => "?").join(",")}) AND sql IS NOT NULL`,
    ...LEDGER_SCHEMA_TABLES,
  );
  const copiedObjects = app.db.rows("SELECT type, name FROM sqlite_master WHERE substr(name, 1, length(?)) = ?", prefix, prefix);
  assert.deepEqual(
    copiedObjects.map((object) => `${object.type}:${object.name.slice(prefix.length)}`).sort(),
    defaultObjects.map((object) => `${object.type}:${object.name}`).sort(),
  );

  const scopedApi = "/api/g/da-lat-2026";
  const scopedState = await app.state(scopedApi);
  assert.deepEqual(scopedState.ledger, { slug: "da-lat-2026", name: "Đà Lạt 2026" });
  assert.deepEqual(scopedState.members, []);
  assert.equal((await app.request("POST", `${scopedApi}/members`, { body: { name: "Hà" } })).status, 401);
  const scopedMember = await app.addMember("Hà", scopedApi);
  const scopedExpense = await app.addExpense({ payerId: scopedMember, amountVnd: 500_000, participantChanges: { add: [scopedMember] } }, scopedApi);
  assert.equal((await app.request("PUT", `${scopedApi}/expenses/${defaultExpense}`, { body: { amountVnd: 1 } })).status, 404);
  assert.equal((await app.request("PUT", `${scopedApi}/expenses/${scopedExpense}`, { body: { payerId: defaultMember } })).status, 400);
  assert.equal((await app.request("PUT", `/api/expenses/${scopedExpense}`, { body: { amountVnd: 1 } })).status, 404);

  const defaultState = await app.state();
  assert.deepEqual(defaultState.members.map((member) => member.name), ["An"]);
  assert.deepEqual(defaultState.expenses.map((expense) => expense.id), [defaultExpense]);
  const scopedAfter = await app.state(scopedApi);
  assert.deepEqual(scopedAfter.members.map((member) => member.name), ["Hà"]);
  assert.equal(scopedAfter.expenses[0].amountVnd, 500_000);
  assert.equal((await app.request("GET", `${scopedApi}/admin/audit`, { admin: true })).data.sessions.length, 1);
  assert.equal((await app.request("POST", `${scopedApi}/admin/history-points`, {
    body: { message: "Đà Lạt", password: "restore-password" }, admin: true,
  })).status, 201);
  assert.equal((await app.request("GET", "/api/g/khong-co/state")).status, 404);

  const page = await app.request("GET", "/g/da-lat-2026");
  assert.equal(page.status, 200);
  assert.deepEqual(app.assetRequests, ["/"]);

  const list = await app.request("GET", "/api/admin/ledgers", { admin: true });
  assert.deepEqual(list.data.ledgers.map((ledger) => Object.keys(ledger)), [
    ["id", "slug", "name", "createdAt"],
    ["id", "slug", "name", "createdAt"],
  ]);
  assert.deepEqual(list.data.ledgers.map((ledger) => [ledger.slug, ledger.name]), [
    ["chill-guys", "Chill guys"],
    ["da-lat-2026", "Đà Lạt 2026"],
  ]);
  assert.equal((await app.request("GET", "/api/admin/ledgers")).status, 401);

  assert.equal((await app.request("DELETE", "/api/admin/ledgers/chill-guys", { body: { password: "restore-password" }, admin: true })).status, 403);
  assert.equal((await app.request("DELETE", "/api/admin/ledgers/khong-co", { body: { password: "restore-password" }, admin: true })).status, 404);
  assert.equal((await app.request("DELETE", "/api/admin/ledgers/da-lat-2026", { body: { password: "wrong-password" }, admin: true })).status, 401);
  assert.equal((await app.request("DELETE", "/api/admin/ledgers/da-lat-2026", { body: {}, admin: true })).status, 400);
  const deleted = await app.request("DELETE", "/api/admin/ledgers/da-lat-2026", { body: { password: "restore-password" }, admin: true });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.data, { deleted: true, slug: "da-lat-2026" });
  assert.deepEqual(app.db.rows("SELECT name FROM sqlite_master WHERE substr(name, 1, length(?)) = ?", prefix, prefix), []);
  assert.equal((await app.request("GET", `${scopedApi}/state`)).status, 404);
  assert.equal((await app.state()).members.length, 1);
});

test("deleting a ledger always asks for the operations password, also for older ledgers", options, async () => {
  const app = createApp();
  await app.login();
  // The session is authorized by this creation, which does not count for deletions.
  const withHash = await app.createLedger("Sổ có mật khẩu xóa");
  const withoutHash = await app.createLedger("Sổ cũ");
  // Ledgers created before the operations password kept their own PBKDF2 hash; it is ignored now.
  const salt = randomBytes(16);
  app.db.run(
    "UPDATE ledgers SET delete_password_salt = ?, delete_password_hash = ? WHERE id = ?",
    salt.toString("base64url"),
    pbkdf2Sync("delete-me-123", salt, 100_000, 32, "sha256").toString("base64url"),
    withHash.id,
  );
  for (const { slug } of [withHash, withoutHash]) {
    const remove = (body) => app.request("DELETE", `/api/admin/ledgers/${slug}`, { body, admin: true });
    for (const [body, status, error] of [
      // Pages cached before the operations password send no body at all.
      [undefined, 400, "Nhập mật khẩu thao tác."],
      [{}, 400, "Nhập mật khẩu thao tác."],
      [{ password: "" }, 400, "Nhập mật khẩu thao tác."],
      [{ password: "delete-me-123" }, 401, "Mật khẩu thao tác không đúng."],
    ]) {
      const response = await remove(body);
      assert.equal(response.status, status, `${slug} ${JSON.stringify(body)}`);
      assert.deepEqual(response.data, { error });
    }
    const deleted = await remove({ password: "restore-password" });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.data, { deleted: true, slug });
  }
  assert.deepEqual(app.db.rows("SELECT slug FROM ledgers"), [{ slug: "chill-guys" }]);
});

test("security guards: Origin check, signed session cookie and login rate limit", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const expenseId = await app.addExpense({ payerId: an });

  const crossOrigin = await app.request("PUT", `/api/expenses/${expenseId}`, {
    body: { amountVnd: 1 },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);

  const isAdminWith = async (cookie) => (await app.request("GET", "/api/admin/session", { headers: { cookie } })).data.isAdmin;
  assert.equal(await isAdminWith(signedCookie({ username: "admin", sessionId: "s1", expires: Date.now() + 60_000 })), true);
  assert.equal(await isAdminWith(signedCookie({ username: "admin", sessionId: "s1", expires: Date.now() - 1 })), false);
  assert.equal(await isAdminWith(signedCookie({ username: "other", sessionId: "s1", expires: Date.now() + 60_000 })), false);
  assert.equal(await isAdminWith(signedCookie({ username: "admin", expires: Date.now() + 60_000 }, "wrong-secret")), false);
  const forged = signedCookie({ username: "admin", sessionId: "s1", expires: Date.now() + 60_000 }).replace(/\.[^.]+$/, ".AAAA");
  assert.equal(await isAdminWith(forged), false);
  assert.equal((await app.request("POST", "/api/members", { body: { name: "Y" }, headers: { cookie: forged } })).status, 401);

  const logout = await app.request("POST", "/api/admin/logout", { body: {} });
  assert.match(logout.headers.get("set-cookie"), /admin_session=;.*Max-Age=0/);

  const fresh = createApp();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fresh.request("POST", "/api/admin/login", { body: { username: "admin", password: "wrong" } });
    assert.equal(response.status, 401);
  }
  const limited = await fresh.request("POST", "/api/admin/login", { body: { username: "admin", password: "admin-password" } });
  assert.equal(limited.status, 429);
});

test("unknown routes and malformed JSON return API errors, never server errors", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const expenseId = await app.addExpense({ payerId: an });
  assert.equal((await app.request("GET", "/api/unknown")).status, 404);
  assert.equal((await app.request("PUT", `/api/expenses/${expenseId}`, { body: "{oops" })).status, 400);
  assert.equal((await app.request("PUT", `/api/expenses/${expenseId}`, { body: "[]" })).status, 400);
  assert.equal((await app.request("POST", "/api/admin/login", { body: "null" })).status, 400);
  const state = await app.request("GET", "/api/state");
  assert.equal(state.headers.get("cache-control"), "no-store");
  assert.match(state.headers.get("content-type"), /^application\/json/);
});
