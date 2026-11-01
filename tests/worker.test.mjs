import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

const DEFAULT_COLUMN_WIDTHS = {
  expense: {
    payer: 100,
    date: 110,
    description: 180,
    amount: 60,
    member: 60,
    count: 70,
    avg: 80,
    actions: 68,
  },
  summary: {
    label: 120,
    member: 100,
  },
};
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
    if (this.sql.includes("INSERT INTO rate_limits")) {
      this.database.rateLimitHits += 1;
      return { hit_count: this.database.rateLimitHits };
    }
    if (this.sql.includes("FROM ledgers WHERE slug = ?")) {
      return this.database.ledgers.find((ledger) => ledger.slug === this.values[0]) || null;
    }
    if (this.sql.includes("SELECT value_json AS valueJson FROM global_app_settings")) {
      if (this.sql.includes("'font-size'")) {
        return this.database.fontSize === null
          ? null
          : { valueJson: String(this.database.fontSize) };
      }
      if (this.sql.includes("'qr-size'")) {
        return this.database.qrSize === null
          ? null
          : { valueJson: String(this.database.qrSize) };
      }
      return { valueJson: JSON.stringify(this.database.columnWidths) };
    }
    if (this.sql.includes("SELECT id, name FROM members WHERE id = ?")) {
      return this.database.members.find((member) => member.id === this.values[0]) || null;
    }
    if (this.sql.includes("FROM member_groups WHERE id = ?")) {
      return this.database.memberGroups.find((group) => group.id === this.values[0]) || null;
    }
    if (this.sql.includes("FROM member_groups WHERE name = ?")) {
      return this.database.memberGroups.find((group) =>
        group.name === this.values[0] && (!this.sql.includes("id <> ?") || group.id !== this.values[1]),
      ) || null;
    }
    if (this.sql.includes("FROM admin_session_store_auth")) {
      return this.database.storeAuthorizations.find((item) => item.sessionId === this.values[0]) || null;
    }
    if (this.sql.includes("FROM audit_sessions current WHERE current.id = ?")) {
      const index = this.database.auditSessions.findIndex((session) => session.id === this.values[0]);
      if (index < 0) return null;
      return {
        ...this.database.auditSessions[index],
        beforeJson: index > 0
          ? this.database.auditSessions[index - 1].afterJson
          : this.database.auditAnchor,
      };
    }
    if (this.sql.includes("FROM expenses WHERE id = ?")) {
      return this.database.expense?.id === this.values[0] ? this.database.expense : null;
    }
    if (this.sql.includes("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM expenses")) {
      return { next: this.database.expense ? 1 : 0 };
    }
    if (this.sql.includes("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM member_groups")) {
      return { next: this.database.memberGroups.length };
    }
    if (this.sql.includes("FROM history_points WHERE id = ?")) {
      const point = this.database.historyPoints.find((item) => item.id === this.values[0]);
      return point ? { snapshotJson: JSON.stringify(point.snapshot) } : null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM members WHERE id IN")) {
      return { count: this.values.filter((id) => this.database.members.some((member) => member.id === id)).length };
    }
    if (this.sql.includes("SUM(amount_vnd)")) {
      return { total: this.database.confirmedPaymentTotal };
    }
    if (this.sql.includes("SUM(amount_delta_vnd)")) {
      return {
        total: this.database.adjustments.reduce((sum, adjustment) => sum + adjustment.amountVnd, 0),
      };
    }
    return null;
  }

  async all() {
    if (this.sql.includes("FROM ledgers ORDER BY")) {
      return { results: this.database.ledgers.map((ledger) => ({
        id: ledger.id,
        slug: ledger.slug,
        name: ledger.name,
        hasDeletePassword: Boolean(ledger.deletePasswordSalt && ledger.deletePasswordHash),
      })) };
    }
    if (this.sql.includes("FROM sqlite_master")) {
      const prefix = this.values[0];
      return { results: LEDGER_SCHEMA_TABLES.map((table) => ({
        type: "table",
        name: `${prefix}${table}`,
      })) };
    }
    if (this.sql.includes("FROM audit_sessions ORDER BY")) {
      return { results: [...this.database.auditSessions].reverse().map((session) => ({
        id: session.id,
        startedAt: session.startedAt,
        lastActivity: session.lastActivity,
        adminSeen: session.adminSeen,
        guestSeen: session.guestSeen,
      })) };
    }
    if (this.sql.includes("FROM member_groups ORDER BY")) {
      return { results: this.database.memberGroups.map(({ id, name, position }) => ({ id, name, position })) };
    }
    if (this.sql.includes("FROM member_group_members")) {
      if (this.sql.includes("WHERE group_id = ?")) {
        return { results: this.database.memberGroupMembers
          .filter((member) => member.groupId === this.values[0])
          .map(({ memberId }) => ({ memberId })) };
      }
      if (this.sql.includes("WHERE group_id <> ? AND member_id IN")) {
        return { results: this.database.memberGroupMembers
          .filter((member) => member.groupId !== this.values[0] && this.values.slice(1).includes(member.memberId))
          .map(({ memberId }) => ({ memberId })) };
      }
      if (this.sql.includes("WHERE member_id IN")) {
        return { results: this.database.memberGroupMembers
          .filter((member) => this.values.includes(member.memberId))
          .map(({ memberId }) => ({ memberId })) };
      }
      return { results: this.database.memberGroupMembers.map((member) => ({ ...member })) };
    }
    if (this.sql.includes("FROM payment_adjustments ORDER BY")) {
      return { results: this.database.adjustments.map((adjustment) => ({
        id: adjustment.id,
        memberId: adjustment.memberId,
        amountVnd: adjustment.amountVnd,
        createdAt: adjustment.createdAt,
      })) };
    }
    if (this.sql.includes("FROM history_points ORDER BY")) {
      return { results: this.database.historyPoints.map(({ id, createdAt, memberCount, expenseCount }) => ({
        id, createdAt, memberCount, expenseCount, message: this.database.historyPoints.find((point) => point.id === id)?.message || "",
      })) };
    }
    if (this.sql.includes("FROM expenses ORDER BY position")) {
      return { results: this.database.expense ? [{
        ...this.database.expense,
        date: this.database.expense.date || null,
        position: 0,
      }] : [] };
    }
    if (this.sql.includes("SELECT expense_id AS expenseId, member_id AS memberId")) {
      return { results: this.database.expenseParticipants.map((memberId) => ({
        expenseId: this.database.expense?.id,
        memberId,
      })) };
    }
    if (this.sql.includes("FROM members ORDER BY")) {
      return { results: this.database.members };
    }
    if (this.sql.includes("SELECT member_id AS memberId FROM expense_participants")) {
      return { results: this.database.expenseParticipants.map((memberId) => ({ memberId })) };
    }
    if (this.sql.includes("FROM payments") && this.sql.includes("ORDER BY")) {
      return { results: this.database.payments.filter((payment) => payment.status === "confirmed") };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.includes("UPDATE ledgers")) {
      const ledger = this.database.ledgers.find((item) =>
        item.id === this.values[2] && item.slug === this.values[3],
      );
      if (ledger) {
        ledger.deletePasswordSalt = this.values[0];
        ledger.deletePasswordHash = this.values[1];
      }
      return { meta: { changes: ledger ? 1 : 0 } };
    }
    return { meta: { changes: 0 } };
  }
}

class MockDatabase {
  columnWidths = DEFAULT_COLUMN_WIDTHS;
  fontSize = 90;
  qrSize = 250;
  rateLimitHits = 0;
  ledgers = [
    { id: "default", slug: "chill-guys", name: "Chill guys" },
    { id: "a".repeat(32), slug: "legacy-ledger", name: "Sổ cũ" },
  ];
  members = [
    { id: "member-1", name: "Thành viên 1", position: 0 },
    { id: "member-2", name: "Thành viên 2", position: 1 },
  ];
  confirmedPaymentTotal = 100_000;
  payments = [{
    id: "payment-1",
    memberId: "member-1",
    direction: "member_to_admin",
    amountVnd: 100_000,
    status: "confirmed",
    createdAt: "2026-10-17 10:00:00",
    confirmedAt: "2026-10-17 10:00:00",
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

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      if (statement.sql.includes("INSERT OR IGNORE INTO audit_session_anchor")) {
        this.auditAnchor ??= statement.values[0];
      }
      if (statement.sql.includes("SELECT id, name, position, created_at AS createdAt FROM members")) {
        results.push({ results: this.members.map((member) => ({ ...member, createdAt: "2026-10-17 10:00:00" })) });
        continue;
      }
      if (statement.sql.includes("FROM member_groups ORDER BY")) {
        results.push({ results: this.memberGroups.map(({ id, name, position }) => ({ id, name, position })) });
        continue;
      }
      if (statement.sql.includes("FROM member_group_members")) {
        results.push({ results: this.memberGroupMembers.map(({ memberId, groupId }) => ({ memberId, groupId })) });
        continue;
      }
      if (statement.sql.includes("SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd")) {
        results.push({ results: this.expense ? [{
          ...this.expense,
          date: this.expense.date || null,
          position: 0,
        }] : [] });
        continue;
      }
      if (statement.sql.includes("SELECT expense_id AS expenseId, member_id AS memberId")) {
        results.push({ results: this.expenseParticipants.map((memberId) => ({
          expenseId: this.expense?.id,
          memberId,
        })) });
        continue;
      }
      if (statement.sql.includes("SELECT id, member_id AS memberId, direction, amount_vnd AS amountVnd")) {
        results.push({ results: this.payments });
        continue;
      }
      if (statement.sql.includes("SELECT id, member_id AS memberId, amount_delta_vnd AS amountVnd")) {
        results.push({ results: this.adjustments });
        continue;
      }
      results.push({});
      if (statement.sql.includes("INSERT INTO global_app_settings")) {
        if (statement.sql.includes("'font-size'")) {
          this.fontSize = Number(statement.values[0]);
        } else if (statement.sql.includes("'qr-size'")) {
          this.qrSize = Number(statement.values[0]);
        } else {
          this.columnWidths = JSON.parse(statement.values[0]);
        }
      }
      if (statement.sql.includes("DELETE FROM ledgers WHERE id = ? AND slug = ?")) {
        this.ledgers = this.ledgers.filter((ledger) =>
          ledger.id !== statement.values[0] || ledger.slug !== statement.values[1],
        );
      }
      if (statement.sql.includes("INSERT INTO payment_adjustments")) {
        this.adjustments.push({
          id: statement.values[0],
          memberId: statement.values[1],
          amountVnd: statement.values[2],
          createdAt: "2026-10-17 11:00:00",
        });
      }
      if (statement.sql.includes("UPDATE expenses SET")) {
        let index = 0;
        if (statement.sql.includes("payer_id = ?")) this.expense.payerId = statement.values[index++];
        if (statement.sql.includes("expense_date = ?")) this.expense.date = statement.values[index++];
        if (statement.sql.includes("description = ?")) this.expense.description = statement.values[index++];
        if (statement.sql.includes("amount_vnd = ?")) this.expense.amountVnd = statement.values[index++];
      }
      if (statement.sql.includes("VALUES (?, NULL, '', 0, NULL, ?)")) {
        this.expense = {
          id: statement.values[0],
          payerId: null,
          description: "",
          amountVnd: 0,
          date: null,
          createdAt: null,
          updatedAt: null,
        };
        this.expenseParticipants = [];
      }
      if (statement.sql.includes("INSERT INTO history_points")) {
        this.historyPoints.push({
          id: statement.values[0],
          snapshot: JSON.parse(statement.values[1]),
          memberCount: statement.values[2],
          expenseCount: statement.values[3],
          message: statement.values[4] || "",
          createdAt: "2026-10-17 11:00:00",
        });
      }
      if (statement.sql.includes("DELETE FROM history_points")) {
        this.historyPoints = this.historyPoints.slice(-50);
      }
      if (statement.sql.includes("DELETE FROM expenses")) {
        this.expense = null;
        this.expenseParticipants = [];
      }
      if (statement.sql.includes("DELETE FROM payments")) this.payments = [];
      if (statement.sql.includes("DELETE FROM payment_adjustments")) this.adjustments = [];
      if (statement.sql.trim() === "DELETE FROM members") this.members = [];
      if (statement.sql.includes("DELETE FROM members WHERE id = ?")) {
        const memberId = statement.values[0];
        this.members = this.members.filter((member) => member.id !== memberId);
        this.memberGroupMembers = this.memberGroupMembers.filter((entry) => entry.memberId !== memberId);
      }
      if (statement.sql.includes("INSERT INTO member_groups (id, name, position)")) {
        this.memberGroups.push({
          id: statement.values[0],
          name: statement.values[1],
          position: statement.values[2],
        });
      }
      if (statement.sql.includes("UPDATE member_groups SET name = ?")) {
        const group = this.memberGroups.find((item) => item.id === statement.values[1]);
        if (group) group.name = statement.values[0];
      }
      if (statement.sql.includes("DELETE FROM member_groups WHERE id = ?")) {
        const groupId = statement.values[0];
        this.memberGroups = this.memberGroups.filter((group) => group.id !== groupId);
        this.memberGroupMembers = this.memberGroupMembers.filter((member) => member.groupId !== groupId);
      }
      if (statement.sql.includes("DELETE FROM member_groups") && statement.sql.includes("HAVING COUNT(*) >= 2")) {
        const groupCounts = new Map();
        for (const assignment of this.memberGroupMembers) {
          groupCounts.set(assignment.groupId, (groupCounts.get(assignment.groupId) || 0) + 1);
        }
        this.memberGroups = this.memberGroups.filter((group) => groupCounts.get(group.id) >= 2);
        this.memberGroupMembers = this.memberGroupMembers.filter((assignment) => groupCounts.has(assignment.groupId));
      }
      if (statement.sql.includes("DELETE FROM member_group_members WHERE group_id = ?")) {
        this.memberGroupMembers = this.memberGroupMembers.filter((member) => member.groupId !== statement.values[0]);
      }
      if (statement.sql.includes("INSERT INTO member_group_members (member_id, group_id)")) {
        this.memberGroupMembers.push({ memberId: statement.values[0], groupId: statement.values[1] });
      }
      if (statement.sql.includes("INSERT INTO admin_session_store_auth")) {
        this.storeAuthorizations = this.storeAuthorizations.filter((auth) => auth.sessionId !== statement.values[0]);
        this.storeAuthorizations.push({ sessionId: statement.values[0], expiresAt: "2099-01-01 00:00:00" });
      }
      if (statement.sql.includes("INSERT INTO audit_sessions")) {
        const active = this.auditSessions.at(-1);
        if (!active) {
          this.auditSessions.push({
            id: statement.values[0],
            adminSeen: statement.values[1],
            guestSeen: statement.values[2],
            afterJson: statement.values[3],
            startedAt: "2026-10-17 11:00:00",
            lastActivity: "2026-10-17 11:00:00",
          });
        }
      }
      if (statement.sql.includes("UPDATE audit_sessions")) {
        const session = this.auditSessions.at(-1);
        if (session) {
          session.afterJson = statement.values[0];
          session.adminSeen = Math.max(session.adminSeen, statement.values[1]);
          session.guestSeen = Math.max(session.guestSeen, statement.values[2]);
          session.lastActivity = "2026-10-17 11:00:01";
        }
      }
      if (statement.sql.includes("UPDATE audit_session_anchor")) {
        if (this.auditSessions.length > 999) this.auditAnchor = this.auditSessions[0].afterJson;
      }
      if (statement.sql.includes("DELETE FROM audit_sessions")) this.auditSessions = this.auditSessions.slice(-999);
      if (statement.sql.includes("INSERT INTO members (id, name, position, created_at)")) {
        const data = JSON.parse(statement.values[0]);
        this.members = data.members;
      }
      if (statement.sql.includes("INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date") &&
          statement.sql.includes("json_each")) {
        const data = JSON.parse(statement.values[0]);
        this.expense = data.expenses[0] || null;
      }
      if (statement.sql.includes("INSERT INTO expense_participants (expense_id, member_id)")) {
        if (statement.sql.includes("json_each")) {
          const data = JSON.parse(statement.values[0]);
          this.expenseParticipants = data.participants.map((item) => item.memberId);
        } else {
          this.expenseParticipants.push(statement.values[1]);
        }
      }
      if (statement.sql.includes("INSERT INTO payments (id, member_id, direction, amount_vnd, status")) {
        const data = JSON.parse(statement.values[0]);
        this.payments = data.payments;
      }
      if (statement.sql.includes("INSERT INTO payment_adjustments (id, member_id, amount_delta_vnd, created_by")) {
        if (statement.sql.includes("json_each")) {
          const data = JSON.parse(statement.values[0]);
          this.adjustments = data.adjustments;
        }
      }
      if (statement.sql.includes("DELETE FROM expense_participants")) {
        this.expenseParticipants = [];
      }
      if (statement.sql.includes("INSERT INTO audit_log")) {
        this.auditEntries.push({
          actor: statement.values[0],
          action: statement.values[1],
          entity: statement.values[2],
          entityId: statement.values[3],
          beforeJson: statement.values[4],
          afterJson: statement.values[5],
        });
        this.auditEntries = this.auditEntries.slice(-999);
      }
    }
    return results;
  }
}

test("column widths require Admin and persist for everyone", async () => {
  const DB = new MockDatabase();
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  const guestResponse = await worker.fetch(request("/api/admin/column-widths", {
    method: "PUT",
    body: DEFAULT_COLUMN_WIDTHS,
  }), env);
  assert.equal(guestResponse.status, 401);

  const loginResponse = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const defaultStateResponse = await worker.fetch(request("/api/state"), env);
  const defaultState = await defaultStateResponse.json();
  assert.deepEqual(defaultState.columnWidths, DEFAULT_COLUMN_WIDTHS);
  assert.equal(defaultState.fontSize, 90);
  assert.equal(defaultState.qrSize, 250);

  const invalidWidths = {
    ...DEFAULT_COLUMN_WIDTHS,
    expense: { ...DEFAULT_COLUMN_WIDTHS.expense, payer: 2001 },
  };
  const invalidResponse = await worker.fetch(request("/api/admin/column-widths", {
    method: "PUT",
    body: invalidWidths,
    cookie,
  }), env);
  assert.equal(invalidResponse.status, 400);

  const updatedWidths = {
    ...DEFAULT_COLUMN_WIDTHS,
    expense: { ...DEFAULT_COLUMN_WIDTHS.expense, payer: 24, avg: 40 },
    summary: { ...DEFAULT_COLUMN_WIDTHS.summary, member: 40 },
  };
  const saveResponse = await worker.fetch(request("/api/admin/column-widths", {
    method: "PUT",
    body: updatedWidths,
    cookie,
  }), env);
  assert.equal(saveResponse.status, 200);
  assert.deepEqual((await saveResponse.json()).columnWidths, updatedWidths);

  const stateResponse = await worker.fetch(request("/api/state"), env);
  assert.deepEqual((await stateResponse.json()).columnWidths, updatedWidths);
});

test("editing a paid transfer total adds audited deltas without rewriting payments", async () => {
  const DB = new MockDatabase();
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  const guestResponse = await worker.fetch(request("/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: 250_000 },
  }), env);
  assert.equal(guestResponse.status, 401);

  const loginResponse = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const updateResponse = await worker.fetch(request("/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: 250_000 },
    cookie,
  }), env);
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).adjustmentVnd, 150_000);
  assert.equal(DB.payments[0].amountVnd, 100_000);

  const resetResponse = await worker.fetch(request("/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: 0 },
    cookie,
  }), env);
  assert.equal(resetResponse.status, 200);
  assert.equal((await resetResponse.json()).adjustmentVnd, -250_000);

  const stateResponse = await worker.fetch(request("/api/state"), env);
  const state = await stateResponse.json();
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

  const negativeTotalResponse = await worker.fetch(request("/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: -25_000 },
    cookie,
  }), env);
  assert.equal(negativeTotalResponse.status, 200);
  assert.equal((await negativeTotalResponse.json()).amountVnd, -25_000);

  const excessiveNegativeResponse = await worker.fetch(request("/api/admin/payments/total", {
    method: "PUT",
    body: { memberId: "member-1", amountVnd: -1_000_000_000_001 },
    cookie,
  }), env);
  assert.equal(excessiveNegativeResponse.status, 400);
});

test("font size is admin-only, range-checked, and shared through state", async () => {
  const DB = new MockDatabase();
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  const guestResponse = await worker.fetch(request("/api/admin/font-size", {
    method: "PUT",
    body: { fontSize: 150 },
  }), env);
  assert.equal(guestResponse.status, 401);

  const loginResponse = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const invalidResponse = await worker.fetch(request("/api/admin/font-size", {
    method: "PUT",
    body: { fontSize: 201 },
    cookie,
  }), env);
  assert.equal(invalidResponse.status, 400);

  const saveResponse = await worker.fetch(request("/api/admin/font-size", {
    method: "PUT",
    body: { fontSize: 150 },
    cookie,
  }), env);
  assert.equal(saveResponse.status, 200);
  assert.equal(DB.fontSize, 150);

  const stateResponse = await worker.fetch(request("/api/state"), env);
  assert.equal((await stateResponse.json()).fontSize, 150);
});

test("QR image size is admin-only, range-checked, and shared through state", async () => {
  const DB = new MockDatabase();
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  const guestResponse = await worker.fetch(request("/api/admin/qr-size", {
    method: "PUT",
    body: { qrSize: 600 },
  }), env);
  assert.equal(guestResponse.status, 401);

  const loginResponse = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const invalidResponse = await worker.fetch(request("/api/admin/qr-size", {
    method: "PUT",
    body: { qrSize: 1601 },
    cookie,
  }), env);
  assert.equal(invalidResponse.status, 400);

  const saveResponse = await worker.fetch(request("/api/g/legacy-ledger/admin/qr-size", {
    method: "PUT",
    body: { qrSize: 600 },
    cookie,
  }), env);
  assert.equal(saveResponse.status, 200);
  assert.equal(DB.qrSize, 600);

  const stateResponse = await worker.fetch(request("/api/g/chill-guys/state"), env);
  assert.equal((await stateResponse.json()).qrSize, 600);
});

test("creating a ledger with an existing slug returns a conflict instead of a server error", async () => {
  const DB = new MockDatabase();
  DB.ledgers.push({
    id: "c".repeat(32),
    slug: "f4",
    name: "F4",
  });
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const loginResponse = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const response = await worker.fetch(request("/api/admin/ledgers", {
    method: "POST",
    body: { name: "F4", deletePassword: "temporary-f4-password" },
    cookie,
  }), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Tên này đã được dùng để tạo link sổ khác.",
  });
});

test("authenticated ledger creation errors include the technical cause", async () => {
  const DB = new MockDatabase();
  const originalPrepare = DB.prepare.bind(DB);
  DB.prepare = (sql) => {
    if (sql.includes("FROM sqlite_master")) {
      return {
        bind: () => ({
          all: async () => ({
            results: LEDGER_SCHEMA_TABLES.map((table) => ({
              type: "table",
              name: table,
              sql: `CREATE TABLE ${table} (id TEXT)`,
            })),
          }),
        }),
      };
    }
    return originalPrepare(sql);
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
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const loginResponse = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const response = await worker.fetch(request("/api/admin/ledgers", {
    method: "POST",
    body: { name: "Schema error", deletePassword: "temporary-error-password" },
    cookie,
  }), env);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Error: no such table: template_members/);
});

test("legacy ledgers without a delete password can be deleted without one; default remains protected", async () => {
  const DB = new MockDatabase();
  const salt = new Uint8Array(16).fill(7);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("configured-password"),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const passwordBits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations: 100_000,
  }, key, 256);
  DB.ledgers.push({
    id: "b".repeat(32),
    slug: "protected-ledger",
    name: "Sổ có mật khẩu",
    deletePasswordSalt: Buffer.from(salt).toString("base64url"),
    deletePasswordHash: Buffer.from(passwordBits).toString("base64url"),
  });
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const path = "/api/admin/ledgers/legacy-ledger";
  const guestResponse = await worker.fetch(request(path, { method: "DELETE" }), env);
  assert.equal(guestResponse.status, 401);

  const loginResponse = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];

  const defaultResponse = await worker.fetch(request("/api/admin/ledgers/chill-guys", {
    method: "DELETE",
    cookie,
  }), env);
  assert.equal(defaultResponse.status, 403);

  const deleteResponse = await worker.fetch(request(path, {
    method: "DELETE",
    cookie,
  }), env);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { deleted: true, slug: "legacy-ledger" });
  assert.equal(DB.ledgers.some((ledger) => ledger.slug === "legacy-ledger"), false);

  const missingPasswordResponse = await worker.fetch(request("/api/admin/ledgers/protected-ledger", {
    method: "DELETE",
    cookie,
  }), env);
  assert.equal(missingPasswordResponse.status, 400);
  const wrongPasswordResponse = await worker.fetch(request("/api/admin/ledgers/protected-ledger", {
    method: "DELETE",
    body: { password: "incorrect-password" },
    cookie,
  }), env);
  assert.equal(wrongPasswordResponse.status, 401);
  const correctPasswordResponse = await worker.fetch(request("/api/admin/ledgers/protected-ledger", {
    method: "DELETE",
    body: { password: "configured-password" },
    cookie,
  }), env);
  assert.equal(correctPasswordResponse.status, 200);
});

test("the admin-managed member list is the only member list and only Admin can edit it", async () => {
  const DB = new MockDatabase();
  const env = { DB };
  const request = (path, body) => new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
    },
    body: JSON.stringify(body),
  });

  const guestCreateResponse = await worker.fetch(request("/api/members", { name: "Tên tự tạo" }), env);
  assert.equal(guestCreateResponse.status, 401);

  const stateResponse = await worker.fetch(new Request("https://example.test/api/state"), env);
  const state = await stateResponse.json();
  assert.deepEqual(state.members.map((member) => member.id), ["member-1", "member-2"]);
  assert.equal("tableMembers" in state, false);
});

test("member groups are exclusive and group members are ordered together in state", async () => {
  const DB = new MockDatabase();
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const login = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const created = await worker.fetch(request("/api/admin/member-groups", {
    method: "POST",
    body: { name: "Nhà A", memberIds: ["member-1", "member-2"] },
    cookie,
  }), env);
  assert.equal(created.status, 201);
  const group = (await created.json()).group;
  assert.deepEqual(group.memberIds, ["member-1", "member-2"]);

  const duplicateAssignment = await worker.fetch(request("/api/admin/member-groups", {
    method: "POST",
    body: { name: "Nhà B", memberIds: ["member-1", "member-2"] },
    cookie,
  }), env);
  assert.equal(duplicateAssignment.status, 400);

  const stateResponse = await worker.fetch(request("/api/state", { cookie }), env);
  const state = await stateResponse.json();
  assert.deepEqual(state.members.map((member) => member.id), ["member-1", "member-2"]);
  assert.deepEqual(state.groups[0].memberIds, ["member-1", "member-2"]);

  const deleteResponse = await worker.fetch(request(`/api/admin/member-groups/${group.id}`, {
    method: "DELETE",
    cookie,
  }), env);
  assert.equal(deleteResponse.status, 200);
  assert.equal(DB.memberGroupMembers.length, 0);
});

test("detail changes from Admin and guest share one bounded audit session with snapshots", async () => {
  const DB = new MockDatabase();
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const login = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const guestEdit = await worker.fetch(request("/api/expenses/expense-1", {
    method: "PUT",
    body: { description: "Guest edit" },
  }), env);
  assert.equal(guestEdit.status, 200);
  const adminEdit = await worker.fetch(request("/api/expenses/expense-1", {
    method: "PUT",
    body: { amountVnd: 125_000 },
    cookie,
  }), env);
  assert.equal(adminEdit.status, 200);

  assert.equal(DB.auditSessions.length, 1);
  assert.equal(DB.auditSessions[0].adminSeen, 1);
  assert.equal(DB.auditSessions[0].guestSeen, 1);
  const before = JSON.parse(DB.auditAnchor);
  const after = JSON.parse(DB.auditSessions[0].afterJson);
  assert.equal(before.expenses[0].description, "Ăn trưa");
  assert.equal(after.expenses[0].description, "Guest edit");
  assert.equal(after.expenses[0].amountVnd, 125_000);

  const list = await worker.fetch(request("/api/admin/audit", { cookie }), env);
  assert.equal(list.status, 200);
  const sessions = (await list.json()).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].guestSeen, 1);
  assert.equal(sessions[0].adminSeen, 1);

  const detail = await worker.fetch(request(`/api/admin/audit/${sessions[0].id}`, { cookie }), env);
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
  const lastGuestChange = await worker.fetch(request("/api/expenses/expense-1", {
    method: "PUT",
    body: { date: "2026-10-31" },
  }), env);
  assert.equal(lastGuestChange.status, 200);
  assert.equal(DB.auditSessions.length, 999);
  assert.equal(JSON.parse(DB.auditAnchor).index, 0);
  assert.equal(DB.auditSessions[0].id, "session-1");
});

test("retired payment request and refund APIs are no longer available", async () => {
  const DB = new MockDatabase();
  const request = (path, body) => new Request(`https://example.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
    },
    body: JSON.stringify(body),
  });

  const reportResponse = await worker.fetch(request("/api/payments", {
    memberId: "member-1",
    amountVnd: 1000,
  }), { DB });
  const refundResponse = await worker.fetch(request("/api/admin/refunds", {
    memberId: "member-1",
    amountVnd: 1000,
  }), { DB });
  assert.equal(reportResponse.status, 404);
  assert.equal(refundResponse.status, 404);
});

test("expense edits audit each changed field and participant checkbox action separately", async () => {
  const DB = new MockDatabase();
  const response = await worker.fetch(new Request("https://example.test/api/expenses/expense-1", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
    },
    body: JSON.stringify({
      payerId: "member-1",
      description: "Ăn tối",
      amountVnd: 125_000,
      participantIds: ["member-2"],
    }),
  }), { DB });

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

test("expense drafts save partial fields and validate optional dates", async () => {
  const DB = new MockDatabase();
  const request = (path, { method = "GET", body } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  const createResponse = await worker.fetch(request("/api/expenses", {
    method: "POST",
    body: {},
  }), { DB });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).expense;
  assert.equal(created.description, "");
  assert.equal(created.amountVnd, 0);
  assert.deepEqual(created.participantIds, []);

  const partialResponse = await worker.fetch(request(`/api/expenses/${created.id}`, {
    method: "PUT",
    body: { description: "  Ăn sáng  " },
  }), { DB });
  assert.equal(partialResponse.status, 200);
  assert.equal(DB.expense.description, "Ăn sáng");

  const invalidDate = await worker.fetch(request(`/api/expenses/${created.id}`, {
    method: "PUT",
    body: { date: "2026-02-30" },
  }), { DB });
  assert.equal(invalidDate.status, 400);

  const dateResponse = await worker.fetch(request(`/api/expenses/${created.id}`, {
    method: "PUT",
    body: { date: "2026-02-28", payerId: "member-1", amountVnd: 80_000, participantIds: ["member-2"] },
  }), { DB });
  assert.equal(dateResponse.status, 200);
  const updated = (await dateResponse.json()).expense;
  assert.equal(updated.date, "2026-02-28");
  assert.equal(updated.description, "Ăn sáng");
  assert.deepEqual(updated.participantIds, ["member-2"]);

  const negativeExpenseResponse = await worker.fetch(request(`/api/expenses/${created.id}`, {
    method: "PUT",
    body: { amountVnd: -165_000 },
  }), { DB });
  assert.equal(negativeExpenseResponse.status, 200);
  assert.equal((await negativeExpenseResponse.json()).expense.amountVnd, -165_000);
  assert.equal(DB.expense.amountVnd, -165_000);

  const excessiveNegativeResponse = await worker.fetch(request(`/api/expenses/${created.id}`, {
    method: "PUT",
    body: { amountVnd: -1_000_000_000_001 },
  }), { DB });
  assert.equal(excessiveNegativeResponse.status, 400);
});

test("history points are Admin-only and restore business data without changing settings", async () => {
  const DB = new MockDatabase();
  DB.historyPoints = Array.from({ length: 50 }, (_, index) => ({
    id: `old-${index}`,
    snapshot: {},
    memberCount: 0,
    expenseCount: 0,
    createdAt: "2026-10-17 09:00:00",
  }));
  const env = {
    DB,
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "secret",
    ADMIN_SESSION_SECRET: "a-long-session-secret-for-tests",
    HISTORY_RESTORE_PASSWORD: "restore-secret",
  };
  const request = (path, { method = "GET", body, cookie } = {}) => new Request(
    `https://example.test${path}`,
    {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(method === "GET" ? {} : { origin: "https://example.test" }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );

  assert.equal((await worker.fetch(request("/api/admin/history-points"), env)).status, 401);
  assert.equal((await worker.fetch(request("/api/admin/history-points/missing/restore", {
    method: "POST",
    body: {},
  }), env)).status, 401);
  const login = await worker.fetch(request("/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "secret" },
  }), env);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const store = await worker.fetch(request("/api/admin/history-points", {
    method: "POST",
    body: { message: "Initial backup", password: "restore-secret" },
    cookie,
  }), env);
  assert.equal(store.status, 201);
  const firstStored = await store.json();
  const pointId = firstStored.point.id;
  assert.equal(firstStored.point.message, "Initial backup");
  assert.equal(firstStored.storePasswordVerified, true);

  const secondStore = await worker.fetch(request("/api/admin/history-points", {
    method: "POST",
    body: { message: "Store without asking again" },
    cookie,
  }), env);
  assert.equal(secondStore.status, 201);
  assert.equal(DB.historyPoints.at(-1).message, "Store without asking again");
  assert.equal(DB.historyPoints.length, 50);
  const listResponse = await worker.fetch(request("/api/admin/history-points", { cookie }), env);
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).points.length, 50);
  const storedSnapshot = DB.historyPoints.at(-1).snapshot;
  assert.deepEqual(Object.keys(storedSnapshot).sort(), [
    "adjustments", "expenses", "members", "participants", "payments",
  ]);

  delete env.HISTORY_RESTORE_PASSWORD;
  const missingSecret = await worker.fetch(request(`/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "restore-secret" },
    cookie,
  }), env);
  assert.equal(missingSecret.status, 503);
  env.HISTORY_RESTORE_PASSWORD = "restore-secret";

  const wrongPassword = await worker.fetch(request(`/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "secret" },
    cookie,
  }), env);
  assert.equal(wrongPassword.status, 401);

  env.HISTORY_RESTORE_PASSWORD = env.ADMIN_PASSWORD;
  const sameAsAdmin = await worker.fetch(request(`/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "secret" },
    cookie,
  }), env);
  assert.equal(sameAsAdmin.status, 503);
  env.HISTORY_RESTORE_PASSWORD = "restore-secret";

  DB.members = [];
  DB.expense = null;
  DB.expenseParticipants = [];
  DB.columnWidths.expense.date = 177;
  const restore = await worker.fetch(request(`/api/admin/history-points/${pointId}/restore`, {
    method: "POST",
    body: { password: "restore-secret" },
    cookie,
  }), env);
  assert.equal(restore.status, 200);
  assert.equal(DB.members.length, 2);
  assert.equal(DB.expense.id, "expense-1");
  assert.deepEqual(DB.expenseParticipants, ["member-1"]);
  assert.equal(DB.columnWidths.expense.date, 177);
  assert.equal(DB.historyPoints.length, 50);
});
