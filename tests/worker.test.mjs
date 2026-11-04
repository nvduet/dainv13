import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COLUMN_WIDTHS } from "../public/shared/constants.mjs";
import worker from "../worker/index.js";
import { LEDGER_TABLES } from "../worker/ledger-schema.js";

const SECRETS = {
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "secret",
  ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
};
const NOW = "2026-10-17 11:00:00";

function rowsOf(item) {
  return item ? [item] : [];
}

class MockStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    return this.database.execute(this).results[0] ?? null;
  }

  async all() {
    return this.database.execute(this);
  }
}

// In-memory stand-in for D1 that understands exactly the SQL the worker sends (one ledger's data).
// Table prefixes of other ledgers are ignored; unknown SQL throws so the mock cannot drift silently.
class MockDatabase {
  columnWidths = structuredClone(DEFAULT_COLUMN_WIDTHS);
  fontSize = 90;
  qrSize = 250;
  rateLimitHits = new Map();
  ledgers = [
    { id: "default", slug: "chill-guys", name: "Chill guys", schemaVersion: 1 },
    { id: "a".repeat(32), slug: "legacy-ledger", name: "Sổ cũ" },
  ];
  members = [
    { id: "member-1", name: "Thành viên 1", position: 0 },
    { id: "member-2", name: "Thành viên 2", position: 1 },
  ];
  payments = [{
    id: "payment-1",
    memberId: "member-1",
    direction: "member_to_admin",
    amountVnd: 100_000,
    status: "confirmed",
    createdAt: "2026-10-17 10:00:00",
    confirmedAt: "2026-10-17 10:00:00",
    confirmedBy: "admin",
  }];
  expense = {
    id: "expense-1",
    payerId: "member-1",
    description: "Ăn trưa",
    amountVnd: 100_000,
    date: null,
    createdAt: "2026-10-17 10:00:00",
    updatedAt: "2026-10-17 10:00:00",
  };
  expenseParticipants = ["member-1"];
  historyPoints = [];
  auditEntries = [];
  auditSessions = [];
  auditAnchor = null;
  memberGroups = [];
  memberGroupMembers = [];
  storeAuthorizations = [];
  adjustments = [];
  schemaChanges = [];

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    return statements.map((statement) => this.execute(statement));
  }

  execute(statement) {
    const sql = statement.sql.replace(/\bledger_[\da-f]{32}_/g, "").replace(/\s+/g, " ").trim();
    const results = this.query(sql, statement.values);
    if (results === undefined) throw new Error(`Unmocked SQL: ${sql}`);
    return { results, meta: {} };
  }

  paidToAdmin(memberId) {
    return this.payments
      .filter((payment) => payment.memberId === memberId && payment.direction === "member_to_admin" &&
        payment.status === "confirmed")
      .reduce((sum, payment) => sum + payment.amountVnd, 0) +
      this.adjustments
        .filter((adjustment) => adjustment.memberId === memberId)
        .reduce((sum, adjustment) => sum + adjustment.amountVnd, 0);
  }

  pushAudit(entry) {
    this.auditEntries.push(entry);
    this.auditEntries = this.auditEntries.slice(-999);
  }

  expenseRow(columns) {
    if (!this.expense) return [];
    const row = { ...this.expense, date: this.expense.date || null, position: 0 };
    return [Object.fromEntries(columns.map((column) => [column, row[column]]))];
  }

  query(sql, v) {
    // Global: ledgers, schema copies, rate limits and settings.
    if (sql === "SELECT id, slug, name, schema_version AS schemaVersion FROM ledgers WHERE slug = ?") {
      return rowsOf(this.ledgers.find((ledger) => ledger.slug === v[0]));
    }
    if (sql === "SELECT id FROM ledgers WHERE slug = ?") {
      return rowsOf(this.ledgers.find((ledger) => ledger.slug === v[0]));
    }
    if (sql === "SELECT id, slug FROM ledgers WHERE slug = ?") {
      return rowsOf(this.ledgers.find((ledger) => ledger.slug === v[0])).map(({ id, slug }) => ({ id, slug }));
    }
    if (sql === "DELETE FROM ledgers WHERE id = ? AND slug = ?") {
      this.ledgers = this.ledgers.filter((ledger) => ledger.id !== v[0] || ledger.slug !== v[1]);
      return [];
    }
    if (sql.startsWith("UPDATE ledgers SET schema_version = 1 WHERE id = ?")) {
      const ledger = this.ledgers.find((item) => item.id === v[0]);
      if (ledger) ledger.schemaVersion = 1;
      return [];
    }
    if (sql.startsWith("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      return LEDGER_TABLES.map((table) => ({ type: "table", name: `${v[0]}${table}` }));
    }
    if (/^(CREATE|DROP) /.test(sql)) {
      this.schemaChanges.push(statementText(sql));
      return [];
    }
    if (/^INSERT INTO \w*rate_limits/.test(sql)) {
      const bucket = `${v[0]}|${v[1]}`;
      const hits = this.rateLimitHits.get(bucket) ?? 0;
      if (hits > 0 && hits >= v[2]) return [];
      this.rateLimitHits.set(bucket, hits + 1);
      return [{ hit_count: hits + 1 }];
    }
    if (sql.startsWith("DELETE FROM rate_limits WHERE bucket_key = ?1 AND window_start < ?2 AND (SELECT latest.hit_count")) {
      if (this.rateLimitHits.get(`${v[0]}|${v[1]}`) === 1) {
        for (const bucket of this.rateLimitHits.keys()) {
          const [key, window] = bucket.split("|");
          if (key === v[0] && Number(window) < v[1]) this.rateLimitHits.delete(bucket);
        }
      }
      return [];
    }
    if (sql.startsWith("SELECT value_json AS valueJson FROM global_app_settings WHERE key = ")) {
      if (sql.endsWith("'font-size'")) return this.fontSize === null ? [] : [{ valueJson: String(this.fontSize) }];
      if (sql.endsWith("'qr-size'")) return this.qrSize === null ? [] : [{ valueJson: String(this.qrSize) }];
      return [{ valueJson: JSON.stringify(this.columnWidths) }];
    }
    if (sql.startsWith("INSERT INTO global_app_settings (key, value_json) VALUES (?, ?)")) {
      if (v[0] === "font-size") this.fontSize = Number(v[1]);
      else if (v[0] === "qr-size") this.qrSize = Number(v[1]);
      else this.columnWidths = JSON.parse(v[1]);
      return [];
    }

    // Audit log.
    if (sql.startsWith("INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json) VALUES")) {
      this.pushAudit({ actor: v[0], action: v[1], entity: v[2], entityId: v[3], beforeJson: v[4], afterJson: v[5] });
      return [];
    }
    if (sql.includes("SELECT ?4, 'reconcile', 'payment_total'")) {
      const adjustment = this.adjustments.find((item) => item.id === v[2]);
      if (adjustment) {
        this.pushAudit({
          actor: v[3],
          action: "reconcile",
          entity: "payment_total",
          entityId: v[0],
          beforeJson: JSON.stringify({ memberId: v[0], paidToAdminVnd: v[1] - adjustment.amountVnd }),
          afterJson: JSON.stringify({ memberId: v[0], paidToAdminVnd: v[1], adjustmentVnd: adjustment.amountVnd }),
        });
      }
      return [];
    }

    // Members.
    if (sql === "SELECT id, name, position FROM members ORDER BY position, name COLLATE NOCASE") {
      return this.members.map(({ id, name, position }) => ({ id, name, position }));
    }
    if (sql === "SELECT id, name, position, created_at AS createdAt FROM members ORDER BY position, name COLLATE NOCASE") {
      return this.members.map(({ id, name, position }) => ({ id, name, position, createdAt: NOW }));
    }
    if (sql === "SELECT id, name FROM members WHERE id = ?") {
      return rowsOf(this.members.find((member) => member.id === v[0])).map(({ id, name }) => ({ id, name }));
    }
    if (sql.startsWith("SELECT COUNT(*) AS count FROM members WHERE id IN")) {
      return [{ count: v.filter((id) => this.members.some((member) => member.id === id)).length }];
    }
    if (sql === "DELETE FROM members") {
      this.members = [];
      this.memberGroupMembers = [];
      return [];
    }
    if (sql.startsWith("INSERT INTO members (id, name, position, created_at) SELECT") && sql.endsWith("FROM json_each(?)")) {
      this.members = JSON.parse(v[0]).map(({ id, name, position }) => ({ id, name, position }));
      return [];
    }

    // Expenses (the mock holds at most one).
    if (sql === "SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd, expense_date AS date, created_at AS createdAt, updated_at AS updatedAt FROM expenses WHERE id = ?") {
      return this.expense?.id === v[0]
        ? this.expenseRow(["id", "payerId", "description", "amountVnd", "date", "createdAt", "updatedAt"])
        : [];
    }
    if (sql === "SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd, expense_date AS date, created_at AS createdAt, updated_at AS updatedAt FROM expenses ORDER BY position, created_at, id") {
      return this.expenseRow(["id", "payerId", "description", "amountVnd", "date", "createdAt", "updatedAt"]);
    }
    if (sql === "SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd, expense_date AS date, position FROM expenses ORDER BY position, created_at, id") {
      return this.expenseRow(["id", "payerId", "description", "amountVnd", "date", "position"]);
    }
    if (sql === "SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd, expense_date AS date, position, created_at AS createdAt, updated_at AS updatedAt FROM expenses ORDER BY position, created_at, id") {
      return this.expenseRow(["id", "payerId", "description", "amountVnd", "date", "position", "createdAt", "updatedAt"]);
    }
    if (sql.startsWith("INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date, position) SELECT ?, NULL, '', 0, NULL,")) {
      this.expense = {
        id: v[0],
        payerId: null,
        description: "",
        amountVnd: 0,
        date: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      this.expenseParticipants = [];
      return [];
    }
    if (sql.startsWith("UPDATE expenses SET ")) {
      let index = 0;
      if (this.expense?.id === v.at(-1)) {
        if (sql.includes("payer_id = ?")) this.expense.payerId = v[index++];
        if (sql.includes("expense_date = ?")) this.expense.date = v[index++];
        if (sql.includes("description = ?")) this.expense.description = v[index++];
        if (sql.includes("amount_vnd = ?")) this.expense.amountVnd = v[index++];
        this.expense.updatedAt = "2026-10-17 11:00:01";
      }
      return [];
    }
    if (sql === "DELETE FROM expenses WHERE id = ?" || sql === "DELETE FROM expenses") {
      if (sql === "DELETE FROM expenses" || this.expense?.id === v[0]) {
        this.expense = null;
        this.expenseParticipants = [];
      }
      return [];
    }
    if (sql.startsWith("INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date, position, created_at, updated_at) SELECT") &&
        sql.endsWith("FROM json_each(?)")) {
      const [expense] = JSON.parse(v[0]);
      this.expense = expense ? {
        id: expense.id,
        payerId: expense.payerId,
        description: expense.description,
        amountVnd: expense.amountVnd,
        date: expense.date,
        createdAt: expense.createdAt,
        updatedAt: expense.updatedAt,
      } : null;
      return [];
    }

    // Expense participants.
    if (sql === "SELECT expense_id AS expenseId, member_id AS memberId FROM expense_participants" ||
        sql === "SELECT expense_id AS expenseId, member_id AS memberId FROM expense_participants ORDER BY expense_id, member_id") {
      return this.expenseParticipants.map((memberId) => ({ expenseId: this.expense?.id, memberId }));
    }
    if (sql === "SELECT member_id AS memberId FROM expense_participants WHERE expense_id = ? ORDER BY member_id") {
      return this.expense?.id === v[0]
        ? [...this.expenseParticipants].sort().map((memberId) => ({ memberId }))
        : [];
    }
    if (sql.startsWith("DELETE FROM expense_participants WHERE expense_id = ? AND member_id IN")) {
      if (this.expense?.id === v[0]) {
        this.expenseParticipants = this.expenseParticipants.filter((memberId) => !v.slice(1).includes(memberId));
      }
      return [];
    }
    if (sql === "INSERT OR IGNORE INTO expense_participants (expense_id, member_id) VALUES (?, ?)") {
      if (this.expense?.id !== v[0]) throw new Error("FOREIGN KEY constraint failed");
      if (!this.expenseParticipants.includes(v[1])) this.expenseParticipants.push(v[1]);
      return [];
    }
    if (sql.startsWith("INSERT INTO expense_participants (expense_id, member_id) SELECT") && sql.endsWith("FROM json_each(?)")) {
      this.expenseParticipants = JSON.parse(v[0]).map((item) => item.memberId);
      return [];
    }

    // Payments and adjustments.
    if (sql.startsWith("SELECT id, member_id AS memberId, direction, amount_vnd AS amountVnd, status, created_at AS createdAt, confirmed_at AS confirmedAt FROM payments WHERE status = 'confirmed'")) {
      return this.payments
        .filter((payment) => payment.status === "confirmed")
        .map(({ id, memberId, direction, amountVnd, status, createdAt, confirmedAt }) =>
          ({ id, memberId, direction, amountVnd, status, createdAt, confirmedAt }));
    }
    if (sql.startsWith("SELECT id, member_id AS memberId, direction, amount_vnd AS amountVnd, status, created_at AS createdAt, confirmed_at AS confirmedAt, confirmed_by AS confirmedBy FROM payments")) {
      return this.payments.map((payment) => ({ ...payment }));
    }
    if (sql === "DELETE FROM payments") {
      this.payments = [];
      return [];
    }
    if (sql.startsWith("INSERT INTO payments (id, member_id, direction, amount_vnd, status, created_at, confirmed_at, confirmed_by) SELECT")) {
      this.payments = JSON.parse(v[0]);
      return [];
    }
    if (sql === "SELECT id, member_id AS memberId, amount_delta_vnd AS amountVnd, created_at AS createdAt FROM payment_adjustments ORDER BY created_at DESC, id DESC") {
      return this.adjustments.map(({ id, memberId, amountVnd, createdAt }) => ({ id, memberId, amountVnd, createdAt }));
    }
    if (sql.startsWith("SELECT id, member_id AS memberId, amount_delta_vnd AS amountVnd, created_by AS createdBy, created_at AS createdAt FROM payment_adjustments")) {
      return this.adjustments.map((adjustment) => ({ ...adjustment }));
    }
    if (sql === "DELETE FROM payment_adjustments") {
      this.adjustments = [];
      return [];
    }
    if (sql.startsWith("WITH paid AS MATERIALIZED") &&
        sql.includes("INSERT INTO payment_adjustments (id, member_id, amount_delta_vnd, created_by) SELECT ?3, ?1,")) {
      const delta = v[1] - this.paidToAdmin(v[0]);
      if (delta === 0) return [];
      this.adjustments.push({ id: v[2], memberId: v[0], amountVnd: delta, createdBy: "admin", createdAt: NOW });
      return [{ id: v[2], adjustmentVnd: delta, createdAt: NOW }];
    }
    if (sql.startsWith("INSERT INTO payment_adjustments (id, member_id, amount_delta_vnd, created_by, created_at) SELECT")) {
      this.adjustments = JSON.parse(v[0]);
      return [];
    }

    // Member groups.
    if (sql === "SELECT id, name, position FROM member_groups ORDER BY position, name COLLATE NOCASE") {
      return this.memberGroups.map(({ id, name, position }) => ({ id, name, position }));
    }
    if (sql === "SELECT id, name, position FROM member_groups WHERE id = ?") {
      return rowsOf(this.memberGroups.find((group) => group.id === v[0]));
    }
    if (sql === "SELECT id FROM member_groups WHERE name = ?" || sql === "SELECT id FROM member_groups WHERE name = ? AND id <> ?") {
      return this.memberGroups
        .filter((group) => group.name.toLowerCase() === v[0].toLowerCase() && (v.length === 1 || group.id !== v[1]))
        .map(({ id }) => ({ id }));
    }
    if (sql === "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM member_groups") {
      return [{ next: this.memberGroups.length }];
    }
    if (sql === "INSERT INTO member_groups (id, name, position) VALUES (?, ?, ?)") {
      this.memberGroups.push({ id: v[0], name: v[1], position: v[2] });
      return [];
    }
    if (sql === "DELETE FROM member_groups WHERE id = ?") {
      this.memberGroups = this.memberGroups.filter((group) => group.id !== v[0]);
      this.memberGroupMembers = this.memberGroupMembers.filter((member) => member.groupId !== v[0]);
      return [];
    }
    if (sql.startsWith("DELETE FROM member_groups WHERE id NOT IN") && sql.includes("HAVING COUNT(*) >= 2")) {
      const groupCounts = new Map();
      for (const assignment of this.memberGroupMembers) {
        groupCounts.set(assignment.groupId, (groupCounts.get(assignment.groupId) || 0) + 1);
      }
      this.memberGroups = this.memberGroups.filter((group) => groupCounts.get(group.id) >= 2);
      this.memberGroupMembers = this.memberGroupMembers.filter((assignment) => groupCounts.get(assignment.groupId) >= 2);
      return [];
    }
    if (sql === "SELECT member_id AS memberId, group_id AS groupId FROM member_group_members") {
      return this.memberGroupMembers.map(({ memberId, groupId }) => ({ memberId, groupId }));
    }
    if (sql === "SELECT member_id AS memberId FROM member_group_members WHERE group_id = ? ORDER BY member_id") {
      return this.memberGroupMembers
        .filter((member) => member.groupId === v[0])
        .map(({ memberId }) => ({ memberId }))
        .sort((left, right) => left.memberId.localeCompare(right.memberId));
    }
    if (sql.startsWith("SELECT member_id AS memberId FROM member_group_members WHERE member_id IN")) {
      return this.memberGroupMembers
        .filter((member) => v.includes(member.memberId))
        .map(({ memberId }) => ({ memberId }));
    }
    if (sql === "INSERT INTO member_group_members (member_id, group_id) VALUES (?, ?)") {
      this.memberGroupMembers.push({ memberId: v[0], groupId: v[1] });
      return [];
    }
    if (sql.startsWith("INSERT INTO member_group_members (member_id, group_id) SELECT") && sql.endsWith("FROM json_each(?)")) {
      this.memberGroupMembers.push(...JSON.parse(v[0]));
      return [];
    }

    // Store authorization and history points.
    if (sql.startsWith("SELECT session_id AS sessionId FROM admin_session_store_auth WHERE session_id = ?")) {
      return this.storeAuthorizations
        .filter((item) => item.sessionId === v[0])
        .map(({ sessionId }) => ({ sessionId }));
    }
    if (sql.startsWith("INSERT INTO admin_session_store_auth (session_id, expires_at)")) {
      this.storeAuthorizations = this.storeAuthorizations.filter((auth) => auth.sessionId !== v[0]);
      this.storeAuthorizations.push({ sessionId: v[0], expiresAt: "2099-01-01 00:00:00" });
      return [];
    }
    if (sql.startsWith("SELECT id, created_at AS createdAt, member_count AS memberCount, expense_count AS expenseCount, message FROM history_points")) {
      return this.historyPoints.map(({ id, createdAt, memberCount, expenseCount, message }) => ({
        id, createdAt, memberCount, expenseCount, message: message || "",
      }));
    }
    if (sql === "SELECT snapshot_json AS snapshotJson FROM history_points WHERE id = ?") {
      const point = this.historyPoints.find((item) => item.id === v[0]);
      return point ? [{ snapshotJson: JSON.stringify(point.snapshot) }] : [];
    }
    if (sql.startsWith("INSERT INTO history_points (id, snapshot_json, member_count, expense_count, message)")) {
      this.historyPoints.push({
        id: v[0],
        snapshot: JSON.parse(v[1]),
        memberCount: v[2],
        expenseCount: v[3],
        message: v[4] || "",
        createdAt: NOW,
      });
      return [];
    }
    if (sql.startsWith("DELETE FROM history_points WHERE id NOT IN")) {
      this.historyPoints = this.historyPoints.slice(-50);
      return [];
    }

    // Detail audit sessions (the newest session is treated as active).
    if (sql === "SELECT 1 AS hasAnchor FROM audit_session_anchor WHERE id = 1") {
      return this.auditAnchor == null ? [] : [{ hasAnchor: 1 }];
    }
    if (sql.startsWith("INSERT OR IGNORE INTO audit_session_anchor (id, snapshot_json)")) {
      this.auditAnchor ??= v[0];
      return [];
    }
    if (sql.startsWith("INSERT INTO audit_sessions (id, admin_seen, guest_seen, after_json)")) {
      const active = this.auditSessions.at(-1);
      if (active) {
        active.afterJson = v[3];
        active.adminSeen = Math.max(active.adminSeen, v[1]);
        active.guestSeen = Math.max(active.guestSeen, v[2]);
        active.lastActivity = "2026-10-17 11:00:01";
      } else {
        this.auditSessions.push({
          id: v[0],
          adminSeen: v[1],
          guestSeen: v[2],
          afterJson: v[3],
          startedAt: NOW,
          lastActivity: NOW,
        });
      }
      return [];
    }
    if (sql.startsWith("UPDATE audit_session_anchor SET snapshot_json =")) {
      const excess = this.auditSessions.length - 999;
      if (excess > 0) this.auditAnchor = this.auditSessions[excess - 1].afterJson;
      return [];
    }
    if (sql.startsWith("DELETE FROM audit_sessions WHERE rowid <=")) {
      this.auditSessions = this.auditSessions.slice(-999);
      return [];
    }
    if (sql.startsWith("SELECT id, started_at AS startedAt, last_activity AS lastActivity, admin_seen AS adminSeen, guest_seen AS guestSeen FROM audit_sessions ORDER BY")) {
      return [...this.auditSessions].reverse().map(({ id, startedAt, lastActivity, adminSeen, guestSeen }) =>
        ({ id, startedAt, lastActivity, adminSeen, guestSeen }));
    }
    if (sql.includes("FROM audit_sessions current WHERE current.id = ?")) {
      const index = this.auditSessions.findIndex((session) => session.id === v[0]);
      if (index < 0) return [];
      return [{
        ...this.auditSessions[index],
        beforeJson: index > 0 ? this.auditSessions[index - 1].afterJson : this.auditAnchor,
      }];
    }
    return undefined;
  }
}

function statementText(sql) {
  return sql.length > 60 ? `${sql.slice(0, 60)}…` : sql;
}

function createEnv(DB = new MockDatabase(), extra = {}) {
  return { DB, ...SECRETS, ...extra };
}

function request(path, { method = "GET", body, cookie, headers = {} } = {}) {
  return new Request(`https://example.test${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { origin: "https://example.test" }),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function send(env, path, options) {
  return worker.fetch(request(path, options), env);
}

async function login(env) {
  const response = await send(env, "/api/admin/login", {
    method: "POST",
    body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD },
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

test("column widths require Admin and persist for everyone", async () => {
  const env = createEnv();
  const guestResponse = await send(env, "/api/admin/column-widths", {
    method: "PUT",
    body: DEFAULT_COLUMN_WIDTHS,
  });
  assert.equal(guestResponse.status, 401);

  const cookie = await login(env);
  const defaultState = await (await send(env, "/api/state")).json();
  assert.deepEqual(defaultState.columnWidths, DEFAULT_COLUMN_WIDTHS);
  assert.equal(defaultState.fontSize, 90);
  assert.equal(defaultState.qrSize, 250);

  const invalidWidths = {
    ...DEFAULT_COLUMN_WIDTHS,
    expense: { ...DEFAULT_COLUMN_WIDTHS.expense, payer: 2001 },
  };
  const invalidResponse = await send(env, "/api/admin/column-widths", {
    method: "PUT",
    body: invalidWidths,
    cookie,
  });
  assert.equal(invalidResponse.status, 400);

  const updatedWidths = {
    ...DEFAULT_COLUMN_WIDTHS,
    expense: { ...DEFAULT_COLUMN_WIDTHS.expense, payer: 24, avg: 40 },
    summary: { ...DEFAULT_COLUMN_WIDTHS.summary, member: 40 },
  };
  const saveResponse = await send(env, "/api/admin/column-widths", {
    method: "PUT",
    body: updatedWidths,
    cookie,
  });
  assert.equal(saveResponse.status, 200);
  assert.deepEqual((await saveResponse.json()).columnWidths, updatedWidths);

  const stateResponse = await send(env, "/api/state");
  assert.deepEqual((await stateResponse.json()).columnWidths, updatedWidths);
});

test("editing a paid transfer total adds audited deltas without rewriting payments", async () => {
  const env = createEnv();
  const DB = env.DB;
  const guestResponse = await send(env, "/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: 250_000 },
  });
  assert.equal(guestResponse.status, 401);

  const cookie = await login(env);
  const updateResponse = await send(env, "/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: 250_000 },
    cookie,
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).adjustmentVnd, 150_000);
  assert.equal(DB.payments[0].amountVnd, 100_000);

  const resetResponse = await send(env, "/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: 0 },
    cookie,
  });
  assert.equal(resetResponse.status, 200);
  assert.equal((await resetResponse.json()).adjustmentVnd, -250_000);

  const state = await (await send(env, "/api/state")).json();
  assert.equal(
    state.payments
      .filter((payment) => payment.memberId === "member-1" && payment.direction === "member_to_admin")
      .reduce((sum, payment) => sum + payment.amountVnd, 0),
    0,
  );
  const totalChanges = DB.auditEntries.filter((entry) =>
    entry.action === "reconcile" && entry.entity === "payment_total",
  );
  assert.equal(totalChanges.length, 2);
  assert.equal(JSON.parse(totalChanges[0].afterJson).paidToAdminVnd, 250_000);
  assert.equal(JSON.parse(totalChanges[1].afterJson).paidToAdminVnd, 0);

  const negativeTotalResponse = await send(env, "/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: -25_000 },
    cookie,
  });
  assert.equal(negativeTotalResponse.status, 200);
  assert.equal((await negativeTotalResponse.json()).amountVnd, -25_000);

  const excessiveNegativeResponse = await send(env, "/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: -1_000_000_000_001 },
    cookie,
  });
  assert.equal(excessiveNegativeResponse.status, 400);
});

test("font size is admin-only, range-checked, and shared through state", async () => {
  const env = createEnv();
  const guestResponse = await send(env, "/api/admin/font-size", {
    method: "PUT",
    body: { fontSize: 150 },
  });
  assert.equal(guestResponse.status, 401);

  const cookie = await login(env);
  const invalidResponse = await send(env, "/api/admin/font-size", {
    method: "PUT",
    body: { fontSize: 201 },
    cookie,
  });
  assert.equal(invalidResponse.status, 400);

  const saveResponse = await send(env, "/api/admin/font-size", {
    method: "PUT",
    body: { fontSize: 150 },
    cookie,
  });
  assert.equal(saveResponse.status, 200);
  assert.equal(env.DB.fontSize, 150);

  const stateResponse = await send(env, "/api/state");
  assert.equal((await stateResponse.json()).fontSize, 150);
});

test("QR image size is admin-only, range-checked, and shared through state", async () => {
  const env = createEnv();
  const guestResponse = await send(env, "/api/admin/qr-size", {
    method: "PUT",
    body: { qrSize: 600 },
  });
  assert.equal(guestResponse.status, 401);

  const cookie = await login(env);
  const invalidResponse = await send(env, "/api/admin/qr-size", {
    method: "PUT",
    body: { qrSize: 1601 },
    cookie,
  });
  assert.equal(invalidResponse.status, 400);

  const saveResponse = await send(env, "/api/g/legacy-ledger/admin/qr-size", {
    method: "PUT",
    body: { qrSize: 600 },
    cookie,
  });
  assert.equal(saveResponse.status, 200);
  assert.equal(env.DB.qrSize, 600);

  const stateResponse = await send(env, "/api/g/chill-guys/state");
  assert.equal((await stateResponse.json()).qrSize, 600);
});

test("creating a ledger with an existing slug returns a conflict instead of a server error", async () => {
  const env = createEnv();
  env.DB.ledgers.push({
    id: "c".repeat(32),
    slug: "f4",
    name: "F4",
  });
  const cookie = await login(env);

  const response = await send(env, "/api/admin/ledgers", {
    method: "POST",
    body: { name: "F4" },
    cookie,
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Tên này đã được dùng để tạo link sổ khác.",
  });
});

test("authenticated ledger creation errors include the technical cause", async () => {
  const DB = new MockDatabase();
  const originalQuery = DB.query.bind(DB);
  DB.query = (sql, values) => {
    if (sql.startsWith("SELECT type, name, sql FROM sqlite_master")) {
      return LEDGER_TABLES.map((table) => ({
        type: "table",
        name: table,
        sql: `CREATE TABLE ${table} (id TEXT)`,
      }));
    }
    return originalQuery(sql, values);
  };
  const originalBatch = DB.batch.bind(DB);
  DB.batch = async (statements) => {
    if (statements.some((statement) =>
      statement.sql.includes("CREATE TABLE ledger_") && statement.sql.includes("_members"),
    )) {
      throw new Error("no such table: template_members");
    }
    return originalBatch(statements);
  };
  const env = createEnv(DB, { HISTORY_RESTORE_PASSWORD: "operations-secret" });
  const cookie = await login(env);

  const response = await send(env, "/api/admin/ledgers", {
    method: "POST",
    body: { name: "Schema error", password: "operations-secret" },
    cookie,
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Error: no such table: template_members/);
  assert.equal(DB.ledgers.some((ledger) => ledger.slug === "schema-error"), false);
});

test("deleting a ledger always needs the operations password; the default ledger stays protected", async () => {
  const env = createEnv(new MockDatabase(), { HISTORY_RESTORE_PASSWORD: "operations-secret" });
  const path = "/api/admin/ledgers/legacy-ledger";
  const guestResponse = await send(env, path, { method: "DELETE", body: { password: "operations-secret" } });
  assert.equal(guestResponse.status, 401);

  const cookie = await login(env);
  const defaultResponse = await send(env, "/api/admin/ledgers/chill-guys", {
    method: "DELETE",
    body: { password: "operations-secret" },
    cookie,
  });
  assert.equal(defaultResponse.status, 403);

  const missingPasswordResponse = await send(env, path, { method: "DELETE", body: { password: "" }, cookie });
  assert.equal(missingPasswordResponse.status, 400);
  assert.deepEqual(await missingPasswordResponse.json(), { error: "Nhập mật khẩu thao tác." });
  const wrongPasswordResponse = await send(env, path, {
    method: "DELETE",
    body: { password: "incorrect-password" },
    cookie,
  });
  assert.equal(wrongPasswordResponse.status, 401);
  assert.deepEqual(await wrongPasswordResponse.json(), { error: "Mật khẩu thao tác không đúng." });
  assert.equal(env.DB.ledgers.some((ledger) => ledger.slug === "legacy-ledger"), true);

  const deleteResponse = await send(env, path, {
    method: "DELETE",
    body: { password: "operations-secret" },
    cookie,
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { deleted: true, slug: "legacy-ledger" });
  assert.equal(env.DB.ledgers.some((ledger) => ledger.slug === "legacy-ledger"), false);
});

test("the admin-managed member list is the only member list and only Admin can edit it", async () => {
  const env = { DB: new MockDatabase() };
  const guestCreateResponse = await send(env, "/api/members", { method: "POST", body: { name: "Tên tự tạo" } });
  assert.equal(guestCreateResponse.status, 401);

  const state = await (await send(env, "/api/state")).json();
  assert.deepEqual(state.members.map((member) => member.id), ["member-1", "member-2"]);
  assert.equal("tableMembers" in state, false);
});

test("member groups are exclusive and group members are ordered together in state", async () => {
  const env = createEnv();
  const cookie = await login(env);

  const created = await send(env, "/api/admin/member-groups", {
    method: "POST",
    body: { name: "Nhà A", memberIds: ["member-1", "member-2"] },
    cookie,
  });
  assert.equal(created.status, 201);
  const group = (await created.json()).group;
  assert.deepEqual(group.memberIds, ["member-1", "member-2"]);

  const duplicateAssignment = await send(env, "/api/admin/member-groups", {
    method: "POST",
    body: { name: "Nhà B", memberIds: ["member-1", "member-2"] },
    cookie,
  });
  assert.equal(duplicateAssignment.status, 400);

  const state = await (await send(env, "/api/state", { cookie })).json();
  assert.deepEqual(state.members.map((member) => member.id), ["member-1", "member-2"]);
  assert.deepEqual(state.groups[0].memberIds, ["member-1", "member-2"]);

  const deleteResponse = await send(env, `/api/admin/member-groups/${group.id}`, {
    method: "DELETE",
    cookie,
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal(env.DB.memberGroupMembers.length, 0);
});

test("detail changes from Admin and guest share one bounded audit session with snapshots", async () => {
  const env = createEnv();
  const DB = env.DB;
  const cookie = await login(env);

  const guestEdit = await send(env, "/api/expenses/expense-1", {
    method: "PUT",
    body: { description: "Guest edit" },
  });
  assert.equal(guestEdit.status, 200);
  const adminEdit = await send(env, "/api/expenses/expense-1", {
    method: "PUT",
    body: { amountVnd: 125_000 },
    cookie,
  });
  assert.equal(adminEdit.status, 200);

  assert.equal(DB.auditSessions.length, 1);
  assert.equal(DB.auditSessions[0].adminSeen, 1);
  assert.equal(DB.auditSessions[0].guestSeen, 1);
  const before = JSON.parse(DB.auditAnchor);
  const after = JSON.parse(DB.auditSessions[0].afterJson);
  assert.equal(before.expenses[0].description, "Ăn trưa");
  assert.equal(after.expenses[0].description, "Guest edit");
  assert.equal(after.expenses[0].amountVnd, 125_000);

  const list = await send(env, "/api/admin/audit", { cookie });
  assert.equal(list.status, 200);
  const sessions = (await list.json()).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].guestSeen, 1);
  assert.equal(sessions[0].adminSeen, 1);

  const detail = await send(env, `/api/admin/audit/${sessions[0].id}`, { cookie });
  assert.equal(detail.status, 200);
  const detailSession = (await detail.json()).session;
  assert.deepEqual(detailSession.actors, ["admin", "guest"]);
  assert.equal(detailSession.before.expenses[0].description, "Ăn trưa");
  assert.equal(detailSession.after.expenses[0].amountVnd, 125_000);

  DB.auditSessions = Array.from({ length: 1_000 }, (_, index) => ({
    id: `session-${index}`,
    afterJson: JSON.stringify({ index }),
    adminSeen: 0,
    guestSeen: 1,
  }));
  const lastGuestChange = await send(env, "/api/expenses/expense-1", {
    method: "PUT",
    body: { date: "2026-10-31" },
  });
  assert.equal(lastGuestChange.status, 200);
  assert.equal(DB.auditSessions.length, 999);
  assert.equal(JSON.parse(DB.auditAnchor).index, 0);
  assert.equal(DB.auditSessions[0].id, "session-1");
});

test("retired payment request and refund APIs are no longer available", async () => {
  const env = { DB: new MockDatabase() };
  const reportResponse = await send(env, "/api/payments", {
    method: "POST",
    body: { memberId: "member-1", amountVnd: 1000 },
  });
  const refundResponse = await send(env, "/api/admin/refunds", {
    method: "POST",
    body: { memberId: "member-1", amountVnd: 1000 },
  });
  assert.equal(reportResponse.status, 404);
  assert.equal(refundResponse.status, 404);
});

test("expense edits audit each changed field and participant checkbox action separately", async () => {
  const env = { DB: new MockDatabase() };
  const DB = env.DB;
  const response = await send(env, "/api/expenses/expense-1", {
    method: "PUT",
    body: {
      payerId: "member-1",
      description: "Ăn tối",
      amountVnd: 125_000,
      participantChanges: { add: ["member-2"], remove: ["member-1"] },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(DB.auditEntries.map((entry) => entry.action), [
    "update",
    "update",
    "participant_add",
    "participant_remove",
  ]);
  assert.deepEqual(
    DB.auditEntries.slice(0, 2).map((entry) => JSON.parse(entry.afterJson)),
    [
      { field: "description", value: "Ăn tối" },
      { field: "amountVnd", value: 125_000 },
    ],
  );
  assert.deepEqual(DB.expenseParticipants, ["member-2"]);
  assert.deepEqual(
    {
      payerId: DB.expense.payerId,
      description: DB.expense.description,
      amountVnd: DB.expense.amountVnd,
    },
    { payerId: "member-1", description: "Ăn tối", amountVnd: 125_000 },
  );
});

test("a stale page sending the full participantIds list is told to reload and changes nothing", async () => {
  const env = { DB: new MockDatabase() };
  const DB = env.DB;
  const response = await send(env, "/api/expenses/expense-1", {
    method: "PUT",
    body: { description: "Từ tab cũ", participantIds: ["member-2"] },
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Trang đang dùng phiên bản cũ. Hãy tải lại trang rồi thử lại." });
  assert.deepEqual(DB.expenseParticipants, ["member-1"]);
  assert.equal(DB.expense.description, "Ăn trưa");
  assert.deepEqual(DB.auditEntries, []);
  assert.deepEqual(DB.auditSessions, []);
});

test("expense drafts save partial fields and validate optional dates", async () => {
  const env = { DB: new MockDatabase() };
  const DB = env.DB;
  const createResponse = await send(env, "/api/expenses", {
    method: "POST",
    body: {},
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).expense;
  assert.equal(created.description, "");
  assert.equal(created.amountVnd, 0);
  assert.deepEqual(created.participantIds, []);

  const partialResponse = await send(env, `/api/expenses/${created.id}`, {
    method: "PUT",
    body: { description: "  Ăn sáng  " },
  });
  assert.equal(partialResponse.status, 200);
  assert.equal(DB.expense.description, "Ăn sáng");

  const invalidDate = await send(env, `/api/expenses/${created.id}`, {
    method: "PUT",
    body: { date: "2026-02-30" },
  });
  assert.equal(invalidDate.status, 400);

  const dateResponse = await send(env, `/api/expenses/${created.id}`, {
    method: "PUT",
    body: { date: "2026-02-28", payerId: "member-1", amountVnd: 80_000, participantChanges: { add: ["member-2"] } },
  });
  assert.equal(dateResponse.status, 200);
  const updated = (await dateResponse.json()).expense;
  assert.equal(updated.date, "2026-02-28");
  assert.equal(updated.description, "Ăn sáng");
  assert.deepEqual(updated.participantIds, ["member-2"]);

  const negativeExpenseResponse = await send(env, `/api/expenses/${created.id}`, {
    method: "PUT",
    body: { amountVnd: -165_000 },
  });
  assert.equal(negativeExpenseResponse.status, 200);
  assert.equal((await negativeExpenseResponse.json()).expense.amountVnd, -165_000);
  assert.equal(DB.expense.amountVnd, -165_000);

  const excessiveNegativeResponse = await send(env, `/api/expenses/${created.id}`, {
    method: "PUT",
    body: { amountVnd: -1_000_000_000_001 },
  });
  assert.equal(excessiveNegativeResponse.status, 400);
});

test("history points are Admin-only and restore business data without changing settings", async () => {
  const env = createEnv(new MockDatabase(), { HISTORY_RESTORE_PASSWORD: "restore-secret" });
  const DB = env.DB;
  DB.historyPoints = Array.from({ length: 50 }, (_, index) => ({
    id: `old-${index}`,
    snapshot: {},
    memberCount: 0,
    expenseCount: 0,
    createdAt: "2026-10-17 09:00:00",
  }));

  assert.equal((await send(env, "/api/admin/history-points")).status, 401);
  assert.equal((await send(env, "/api/admin/history-points/missing/restore", {
    method: "POST",
    body: {},
  })).status, 401);
  const cookie = await login(env);

  const store = await send(env, "/api/admin/history-points", {
    method: "POST",
    body: { message: "Initial backup", password: "restore-secret" },
    cookie,
  });
  assert.equal(store.status, 201);
  const firstStored = await store.json();
  const pointId = firstStored.point.id;
  assert.equal(firstStored.point.message, "Initial backup");
  assert.equal(firstStored.storePasswordVerified, true);

  const secondStore = await send(env, "/api/admin/history-points", {
    method: "POST",
    body: { message: "Store without asking again" },
    cookie,
  });
  assert.equal(secondStore.status, 201);
  assert.equal(DB.historyPoints.at(-1).message, "Store without asking again");
  assert.equal(DB.historyPoints.length, 50);
  const listResponse = await send(env, "/api/admin/history-points", { cookie });
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).points.length, 50);
  const storedSnapshot = DB.historyPoints.at(-1).snapshot;
  assert.deepEqual(Object.keys(storedSnapshot).sort(), [
    "adjustments", "expenses", "members", "participants", "payments",
  ]);

  delete env.HISTORY_RESTORE_PASSWORD;
  const missingSecret = await send(env, `/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "restore-secret" },
    cookie,
  });
  assert.equal(missingSecret.status, 503);
  env.HISTORY_RESTORE_PASSWORD = "restore-secret";

  const wrongPassword = await send(env, `/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "secret" },
    cookie,
  });
  assert.equal(wrongPassword.status, 401);

  env.HISTORY_RESTORE_PASSWORD = env.ADMIN_PASSWORD;
  const sameAsAdmin = await send(env, `/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "secret" },
    cookie,
  });
  assert.equal(sameAsAdmin.status, 503);
  env.HISTORY_RESTORE_PASSWORD = "restore-secret";

  DB.members = [];
  DB.expense = null;
  DB.expenseParticipants = [];
  DB.columnWidths.expense.date = 177;
  const restore = await send(env, `/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "restore-secret" },
    cookie,
  });
  assert.equal(restore.status, 200);
  assert.equal(DB.members.length, 2);
  assert.equal(DB.expense.id, "expense-1");
  assert.deepEqual(DB.expenseParticipants, ["member-1"]);
  assert.equal(DB.columnWidths.expense.date, 177);
  assert.equal(DB.historyPoints.length, 50);
});
