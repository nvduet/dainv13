import assert from "node:assert/strict";
import test from "node:test";
import { createApp, SECRETS } from "./helpers/app.mjs";
import { createTestDatabase, sqliteUnavailable } from "./helpers/d1-sqlite.mjs";

const options = { skip: sqliteUnavailable };

// The default ledger and a freshly created one, each with its table prefix. Race tests simulate D1
// round trips so that concurrent requests interleave between their reads and writes.
async function ledgers({ simulateIo = false } = {}) {
  const app = createApp(SECRETS, { db: createTestDatabase({ simulateIo }) });
  await app.login();
  const created = await app.createLedger("Sổ phụ");
  return { app, targets: [{ api: "/api", prefix: "" }, { api: created.api, prefix: created.prefix }] };
}

function statuses(responses) {
  return responses.map(({ status }) => status).sort();
}

test("concurrent identical paid-total saves add one adjustment", options, async () => {
  const { app, targets } = await ledgers({ simulateIo: true });
  for (const { api, prefix } of targets) {
    const an = await app.addMember("An", api);
    const save = () => app.request("PUT", `${api}/admin/payments/total`, { body: { memberId: an, amountVnd: 120_000 }, admin: true });
    const responses = await Promise.all([save(), save()]);
    assert.deepEqual(statuses(responses), [200, 200]);
    assert.deepEqual(responses.map(({ data }) => data.adjustmentVnd ?? data.changed).sort(), [120_000, false]);
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}payment_adjustments" WHERE member_id = ?`, an), 1);
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}audit_log" WHERE action = 'reconcile'`), 1);
    const state = await app.state(api, true);
    assert.equal(state.payments.filter((payment) => payment.memberId === an)
      .reduce((sum, payment) => sum + payment.amountVnd, 0), 120_000);
  }
});

test("concurrent member adds never pass 50 members or duplicate a name", options, async () => {
  const { app, targets } = await ledgers({ simulateIo: true });
  for (const { api, prefix } of targets) {
    for (let index = 0; index < 49; index += 1) {
      app.db.run(`INSERT INTO "${prefix}members" (id, name, position) VALUES (?, ?, ?)`, `seed-${index}`, `Người ${index}`, index);
    }
    const add = (name) => app.request("POST", `${api}/members`, { body: { name }, admin: true });
    const full = await Promise.all([add("Mới A"), add("Mới B")]);
    assert.deepEqual(statuses(full), [201, 400]);
    assert.deepEqual(full.find(({ status }) => status === 400).data, { error: "Danh sách đã đạt giới hạn 50 thành viên." });
    assert.equal(full.find(({ status }) => status === 201).data.member.position, 49);
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}members"`), 50);
    // At the limit a duplicate name still reports the duplicate first, as before.
    assert.equal((await add("người 1")).status, 409);

    app.db.run(`DELETE FROM "${prefix}members" WHERE id LIKE 'seed-%'`);
    const same = await Promise.all([add("Trùng"), add("trùng")]);
    assert.deepEqual(statuses(same), [201, 409]);
    assert.deepEqual(same.find(({ status }) => status === 409).data, { error: "Tên thành viên này đã có trong danh sách." });
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}members" WHERE name = 'trùng'`), 1);
  }
});

test("concurrent renames and group writes resolve to today's conflict responses", options, async () => {
  const { app, targets } = await ledgers({ simulateIo: true });
  for (const { api } of targets) {
    const ids = [];
    for (const name of ["An", "Bình", "Chi", "Dũng"]) ids.push(await app.addMember(name, api));
    const rename = (id, name) => app.request("PATCH", `${api}/members/${id}`, { body: { name }, admin: true });
    const renames = await Promise.all([rename(ids[0], "Cùng tên"), rename(ids[1], "cùng tên")]);
    assert.deepEqual(statuses(renames), [200, 409]);
    assert.deepEqual(renames.find(({ status }) => status === 409).data, { error: "Tên thành viên này đã có trong danh sách." });

    const group = (name, memberIds) => app.request("POST", `${api}/admin/member-groups`, { body: { name, memberIds }, admin: true });
    const sameName = await Promise.all([group("Nhà", [ids[0], ids[1]]), group("nhà", [ids[2], ids[3]])]);
    assert.deepEqual(statuses(sameName), [201, 409]);
    assert.deepEqual(sameName.find(({ status }) => status === 409).data, { error: "Tên nhóm đã tồn tại." });
    const created = sameName.find(({ status }) => status === 201).data.group;
    const free = ids.filter((id) => !created.memberIds.includes(id));
    const overlap = await Promise.all([group("Một", [free[0], free[1]]), group("Hai", [free[1], free[0]])]);
    assert.deepEqual(statuses(overlap), [201, 400]);
    assert.deepEqual(overlap.find(({ status }) => status === 400).data, { error: "Một thành viên không thể thuộc hai nhóm." });
  }
});

test("participant ticks merge on a ledger link too", options, async () => {
  const { app, targets } = await ledgers({ simulateIo: true });
  const { api, prefix } = targets[1];
  const an = await app.addMember("An", api);
  const binh = await app.addMember("Bình", api);
  const chi = await app.addMember("Chi", api);
  const id = await app.addExpense({ payerId: an, amountVnd: 90_000, participantChanges: { add: [an] } }, api);
  const tick = (participantChanges) => app.request("PUT", `${api}/expenses/${id}`, { body: { participantChanges } });

  const both = await Promise.all([tick({ add: [binh] }), tick({ add: [chi] })]);
  assert.deepEqual(statuses(both), [200, 200]);
  const removed = await tick({ remove: [an, "not-a-participant"] });
  assert.deepEqual(new Set(removed.data.expense.participantIds), new Set([binh, chi]));
  assert.equal((await tick({ add: ["nobody"] })).status, 400);
  const actions = app.db.rows(`SELECT action FROM "${prefix}audit_log" WHERE entity = 'expense_participant' ORDER BY id`)
    .map(({ action }) => action);
  assert.deepEqual(actions, ["participant_add", "participant_add", "participant_add", "participant_remove"]);
  assert.equal(app.count("SELECT COUNT(*) AS count FROM audit_log WHERE entity = 'expense_participant'"), 0);
});

test("expense saves write only what changed", options, async () => {
  const { app, targets } = await ledgers();
  for (const { api, prefix } of targets) {
    const an = await app.addMember("An", api);
    const binh = await app.addMember("Bình", api);
    const chi = await app.addMember("Chi", api);
    const id = await app.addExpense({ description: "Cơm", participantChanges: { add: [an, binh] } }, api);
    const participants = () => Object.fromEntries(app.db.rows(
      `SELECT member_id AS memberId, rowid FROM "${prefix}expense_participants" WHERE expense_id = ?`, id,
    ).map(({ memberId, rowid }) => [memberId, rowid]));
    const totalChanges = () => app.db.rows("SELECT total_changes() AS count")[0].count;

    const before = participants();
    const changed = await app.request("PUT", `${api}/expenses/${id}`, {
      body: { participantChanges: { add: [chi], remove: [an] } },
    });
    assert.deepEqual(new Set(changed.data.expense.participantIds), new Set([binh, chi]));
    const after = participants();
    assert.equal(after[binh], before[binh], "unchanged participant row is kept");
    assert.equal(an in after, false);

    const [stored] = app.db.rows(`SELECT updated_at AS updatedAt FROM "${prefix}expenses" WHERE id = ?`, id);
    const audits = app.count(`SELECT COUNT(*) AS count FROM "${prefix}audit_log"`);
    const changes = totalChanges();
    const noop = await app.request("PUT", `${api}/expenses/${id}`, {
      body: { description: "Cơm", participantChanges: { add: [chi, binh] } },
    });
    assert.equal(noop.status, 200);
    assert.equal(noop.data.expense.updatedAt, stored.updatedAt);
    assert.deepEqual(new Set(noop.data.expense.participantIds), new Set([binh, chi]));
    assert.equal(totalChanges() - changes, 1, "only the rate-limit hit is written");
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}audit_log"`), audits);
  }
});

test("member ids are checked only when the save sends them", options, async () => {
  const app = createApp();
  await app.login();
  const an = await app.addMember("An");
  const id = await app.addExpense({ payerId: an, participantChanges: { add: [an] } });
  const prepare = app.db.prepare.bind(app.db);
  const memberChecks = [];
  app.db.prepare = (sql) => {
    if (sql.includes("COUNT(*) AS count FROM members WHERE id IN")) memberChecks.push(sql);
    return prepare(sql);
  };
  assert.equal((await app.request("PUT", `/api/expenses/${id}`, { body: { description: "Taxi" } })).status, 200);
  assert.equal(memberChecks.length, 0);
  assert.equal((await app.request("PUT", `/api/expenses/${id}`, { body: { payerId: an } })).status, 200);
  assert.equal(memberChecks.length, 1);
  assert.equal((await app.request("PUT", `/api/expenses/${id}`, { body: { participantChanges: { remove: [an] } } })).status, 200);
  assert.equal(memberChecks.length, 1);
});

test("an expense deleted during a save answers 404", options, async () => {
  const { app, targets } = await ledgers();
  for (const { api, prefix } of targets) {
    const an = await app.addMember("An", api);
    const batch = app.db.batch.bind(app.db);
    let deleteBeforeWrite = null;
    app.db.batch = (statements) => {
      if (deleteBeforeWrite && statements.some(({ sql }) => /UPDATE \S*expenses SET/.test(sql))) {
        app.db.run(`DELETE FROM "${prefix}expenses" WHERE id = ?`, deleteBeforeWrite);
        deleteBeforeWrite = null;
      }
      return batch(statements);
    };
    for (const body of [{ description: "Đã xóa" }, { participantChanges: { add: [an] } }]) {
      const id = await app.addExpense({}, api);
      deleteBeforeWrite = id;
      const response = await app.request("PUT", `${api}/expenses/${id}`, { body });
      assert.equal(response.status, 404, JSON.stringify(body));
      assert.deepEqual(response.data, { error: "Không tìm thấy khoản chi." });
    }
    app.db.batch = batch;
  }
});

test("concurrently added expenses get distinct positions", options, async () => {
  const { app, targets } = await ledgers({ simulateIo: true });
  for (const { api, prefix } of targets) {
    const responses = await Promise.all(Array.from({ length: 5 }, () => app.request("POST", `${api}/expenses`, { body: {} })));
    assert.deepEqual(statuses(responses), [201, 201, 201, 201, 201]);
    assert.deepEqual(app.db.rows(`SELECT position FROM "${prefix}expenses" ORDER BY position`).map(({ position }) => position),
      [0, 1, 2, 3, 4]);
  }
});

test("audit rows built in SQL are byte-identical to JSON.stringify", options, async () => {
  const { app, targets } = await ledgers();
  for (const { api, prefix } of targets) {
    // Lone surrogates: JSON.stringify escapes them, while the stored name holds U+FFFD.
    for (const name of ["An \"Quote\" \\ back", "Tab\tInside", "Line\nBreak", "Emoji 😀", "Ký tự đặc biệt",
      "Ctrl\u0001\u001fX", "<b>&amp;</b>", " Sep ", "Lẻ\ud800B", "\udc00", "Cuối\ud83d"]) {
      const { member } = (await app.request("POST", `${api}/members`, { body: { name }, admin: true })).data;
      const [row] = app.db.rows(
        `SELECT actor, before_json AS beforeJson, after_json AS afterJson FROM "${prefix}audit_log"
         WHERE action = 'create' AND entity = 'member' AND entity_id = ?`, member.id);
      assert.deepEqual(row, { actor: "admin", beforeJson: null, afterJson: JSON.stringify(member) }, JSON.stringify(name));
    }
    const memberId = (await app.state(api)).members[0].id;
    for (const amountVnd of [999_999_999_999, -1_000_000_000_000, 0, 1]) {
      const response = await app.request("PUT", `${api}/admin/payments/total`, { body: { memberId, amountVnd }, admin: true });
      assert.equal(response.status, 200);
    }
    const reconciled = app.db.rows(`
      SELECT entity_id AS entityId, before_json AS beforeJson, after_json AS afterJson
      FROM "${prefix}audit_log" WHERE action = 'reconcile' ORDER BY id
    `);
    assert.deepEqual(reconciled, [
      [0, 999_999_999_999],
      [999_999_999_999, -1_000_000_000_000],
      [-1_000_000_000_000, 0],
      [0, 1],
    ].map(([previous, total]) => ({
      entityId: memberId,
      beforeJson: JSON.stringify({ memberId, paidToAdminVnd: previous }),
      afterJson: JSON.stringify({ memberId, paidToAdminVnd: total, adjustmentVnd: total - previous }),
    })));
  }
});

test("oversized snapshots: Store answers 413 and the audit session is skipped", options, async (t) => {
  const { app, targets } = await ledgers();
  const warnings = t.mock.method(console, "warn", () => {});
  app.db.run("DELETE FROM admin_session_store_auth");
  for (const { api, prefix } of targets) {
    app.db.run(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
      INSERT INTO "${prefix}expenses" (id, description, position) SELECT printf('seed-%05d', i), ?, i FROM n
    `, "Đ".repeat(200));
    const points = app.count(`SELECT COUNT(*) AS count FROM "${prefix}history_points"`);
    const store = await app.request("POST", `${api}/admin/history-points`, {
      body: { message: "Quá lớn", password: "restore-password" }, admin: true,
    });
    assert.equal(store.status, 413);
    assert.deepEqual(store.data, { error: "Dữ liệu sổ quá lớn để Store (vượt giới hạn 2 MB của D1)." });
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}history_points"`), points);
    assert.equal(app.count("SELECT COUNT(*) AS count FROM admin_session_store_auth"), 0, "a failed Store records no authorization");

    app.db.run(`DELETE FROM "${prefix}audit_sessions"`);
    const warned = warnings.mock.callCount();
    const edit = await app.request("PUT", `${api}/expenses/seed-00001`, { body: { description: "Sửa" } });
    assert.equal(edit.status, 200);
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}audit_sessions"`), 0);
    assert.equal(warnings.mock.callCount(), warned + 1);
  }
});

test("restoring an older point fills only the columns that have schema defaults", options, async () => {
  const { app, targets } = await ledgers();
  for (const { api, prefix } of targets) {
    const an = await app.addMember("An", api);
    await app.addExpense({ payerId: an, amountVnd: 30_000, participantChanges: { add: [an] } }, api);
    const stored = await app.request("POST", `${api}/admin/history-points`, {
      body: { message: "Mốc cũ", password: "restore-password" }, admin: true,
    });
    assert.equal(stored.status, 201);
    const oldSnapshot = {
      members: [{ id: "old-member", name: "Cũ" }],
      expenses: [{ id: "old-expense", payerId: "old-member", date: null }],
      participants: [{ expenseId: "old-expense", memberId: "old-member" }],
      payments: [{ id: "old-payment", memberId: "old-member", direction: "member_to_admin", amountVnd: 5_000, status: "confirmed" }],
      adjustments: [{ id: "old-adjustment", memberId: "old-member", amountVnd: -1_000 }],
    };
    app.db.run(`UPDATE "${prefix}history_points" SET snapshot_json = ? WHERE id = ?`, JSON.stringify(oldSnapshot), stored.data.point.id);
    const restored = await app.request("POST", `${api}/admin/history-points/${stored.data.point.id}/restore`, {
      body: { password: "restore-password" }, admin: true,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const one = (sql) => app.db.rows(sql)[0];
    assert.deepEqual(one(`SELECT position, created_at IS NOT NULL AS dated FROM "${prefix}members"`), { position: 0, dated: 1 });
    assert.deepEqual(one(`SELECT description, amount_vnd AS amount, position, expense_date AS date,
      created_at IS NOT NULL AND updated_at IS NOT NULL AS dated FROM "${prefix}expenses"`),
    { description: "", amount: 0, position: 0, date: null, dated: 1 });
    assert.deepEqual(one(`SELECT created_at IS NOT NULL AS dated, confirmed_at AS confirmedAt FROM "${prefix}payments"`),
      { dated: 1, confirmedAt: null });
    assert.deepEqual(one(`SELECT created_by AS createdBy, created_at IS NOT NULL AS dated FROM "${prefix}payment_adjustments"`),
      { createdBy: "admin", dated: 1 });
    assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}expense_participants"`), 1);
  }
});

// Free-tier guard: D1 queries per request (a batch is one query).
test("per-request D1 query budgets", options, async () => {
  const { app, targets } = await ledgers();
  for (const [index, { api }] of targets.entries()) {
    const lookup = index === 0 ? 0 : 1;
    const an = await app.addMember("An", api);
    const id = await app.addExpense({ payerId: an, participantChanges: { add: [an] } }, api);
    await app.request("PUT", `${api}/admin/payments/total`, { body: { memberId: an, amountVnd: 1 }, admin: true });
    const queries = async (method, path, request = {}) => {
      const count = app.db.queryCount;
      const response = await app.request(method, `${api}${path}`, request);
      assert.ok(response.status < 500, `${method} ${path}: ${JSON.stringify(response.data)}`);
      return app.db.queryCount - count - lookup;
    };
    assert.equal(await queries("GET", "/state"), 1);
    assert.equal(await queries("GET", "/state", { admin: true }), 1);
    assert.equal(await queries("GET", "/admin/session", { admin: true }), 0);
    assert.equal(await queries("POST", "/members", { body: { name: "Khách" } }), 0);
    assert.equal(await queries("PUT", `/expenses/${id}`, { body: { description: "Taxi" } }), 6);
    // No-op saves skip the write and the session; a sent payer is still checked.
    assert.equal(await queries("PUT", `/expenses/${id}`, { body: { description: "Taxi" } }), 4);
    assert.equal(await queries("PUT", `/expenses/${id}`, { body: { payerId: an } }), 5);
    assert.equal(await queries("PUT", `/expenses/${id}`, { body: { amountVnd: 5_000, payerId: an } }), 7);
    // A 4xx takes no after-snapshot: limiter, before-snapshot, expense read.
    assert.equal(await queries("PUT", `/expenses/${id}`, { body: { date: "2026-02-30" } }), 3);
    assert.equal(await queries("POST", "/expenses", { body: {} }), 5);
    // A client's first hit in a window cleans up older windows in the limiter's own round trip.
    assert.equal(await queries("POST", "/expenses", { body: {}, headers: { "cf-connecting-ip": `198.51.100.${index}` } }), 5);
    assert.equal(await queries("POST", "/members", { body: { name: "Bình" }, admin: true }), 6);
    // A transfer total is tracked like a Detail write (before/after snapshots, session); unchanged, no session.
    assert.equal(await queries("PUT", "/admin/payments/total", { body: { memberId: an, amountVnd: 2 }, admin: true }), 6);
    assert.equal(await queries("PUT", "/admin/payments/total", { body: { memberId: an, amountVnd: 2 }, admin: true }), 5);
  }
});

// Free-tier guard: the operations password adds no round trip of its own to ledger creation.
test("ledger creation, Store and ledger deletion query budgets", options, async () => {
  const app = createApp();
  await app.login();
  const password = SECRETS.HISTORY_RESTORE_PASSWORD;
  const queries = async (method, path, body) => {
    const count = app.db.queryCount;
    const response = await app.request(method, path, { body, admin: true });
    assert.ok(response.status < 300, `${method} ${path}: ${JSON.stringify(response.data)}`);
    return app.db.queryCount - count;
  };
  // Limiter, slug + session authorization, password limiter + schema read, insert batch.
  assert.equal(await queries("POST", "/api/admin/ledgers", { name: "Sổ một", password }), 4);
  // Authorized: the schema read goes alone.
  assert.equal(await queries("POST", "/api/admin/ledgers", { name: "Sổ hai" }), 4);
  // Limiter, authorization, snapshot, insert batch.
  assert.equal(await queries("POST", "/api/admin/history-points", { message: "Mốc" }), 4);
  // Ledger, password limiter, table list, drop batch.
  assert.equal(await queries("DELETE", "/api/admin/ledgers/so-hai", { password }), 4);
  await app.login();
  // A new session's first Store also spends its password limiter.
  assert.equal(await queries("POST", "/api/admin/history-points", { message: "Mốc", password }), 5);
});

// Free-tier guard for rows read: a paid-total save aggregates the member's payments and adjustments
// once, whether or not it adds an adjustment (rows are counted inside SUM).
test("a paid-total save reads the member's payments and adjustments once", options, async () => {
  const { app, targets } = await ledgers();
  let aggregated = 0;
  app.db.sqlite.function("counted", () => {
    aggregated += 1;
    return 0n;
  });
  const prepare = app.db.prepare.bind(app.db);
  app.db.prepare = (sql) => prepare(sql.replace(/SUM\((amount_vnd|amount_delta_vnd)\)/g, "SUM($1 + counted())"));
  for (const { api, prefix } of targets) {
    const an = await app.addMember("An", api);
    for (const [id, amountVnd] of [["p1", 1_000], ["p2", 2_000]]) {
      app.db.run(`INSERT INTO "${prefix}payments" (id, member_id, direction, amount_vnd, status)
        VALUES (?, ?, 'member_to_admin', ?, 'confirmed')`, id, an, amountVnd);
    }
    for (let index = 0; index < 5; index += 1) {
      app.db.run(`INSERT INTO "${prefix}payment_adjustments" (id, member_id, amount_delta_vnd, created_by)
        VALUES (?, ?, 100, 'admin')`, `a${index}`, an);
    }
    // 2 payments + 5 adjustments = 3,500; the changed save adds a sixth adjustment.
    for (const [amountVnd, rows] of [[3_500, 7], [4_000, 7], [4_000, 8]]) {
      aggregated = 0;
      const response = await app.request("PUT", `${api}/admin/payments/total`, { body: { memberId: an, amountVnd }, admin: true });
      assert.equal(response.status, 200);
      assert.equal(aggregated, rows, `${api} ${amountVnd}`);
    }
  }
});
