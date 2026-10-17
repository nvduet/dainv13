import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";

const DEFAULT_COLUMN_WIDTHS = {
  expense: {
    payer: 110,
    description: 145,
    amount: 100,
    member: 80,
    count: 52,
    avg: 94,
    actions: 68,
  },
  summary: {
    label: 120,
    member: 130,
  },
};

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
    if (this.sql.includes("SELECT value_json AS valueJson FROM app_settings")) {
      if (this.sql.includes("'font-size'")) {
        return this.database.fontSize === null
          ? null
          : { valueJson: String(this.database.fontSize) };
      }
      return { valueJson: JSON.stringify(this.database.columnWidths) };
    }
    if (this.sql.includes("SELECT id, name FROM members WHERE id = ?")) {
      return this.database.members.find((member) => member.id === this.values[0]) || null;
    }
    if (this.sql.includes("FROM expenses WHERE id = ?")) {
      return this.database.expense?.id === this.values[0] ? this.database.expense : null;
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
    if (this.sql.includes("FROM payment_adjustments ORDER BY")) {
      return { results: this.database.adjustments.map((adjustment) => ({
        id: adjustment.id,
        memberId: adjustment.memberId,
        amountVnd: adjustment.amountVnd,
        createdAt: adjustment.createdAt,
      })) };
    }
    if (this.sql.includes("FROM members ORDER BY")) {
      return { results: this.database.members };
    }
    if (this.sql.includes("SELECT member_id AS memberId FROM expense_participants")) {
      return { results: this.database.expenseParticipants.map((memberId) => ({ memberId })) };
    }
    if (this.sql.includes("FROM payments ORDER BY")) {
      return { results: this.database.payments };
    }
    return { results: [] };
  }
}

class MockDatabase {
  columnWidths = DEFAULT_COLUMN_WIDTHS;
  fontSize = 100;
  rateLimitHits = 0;
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
    createdAt: "2026-10-17 10:00:00",
    updatedAt: "2026-10-17 10:00:00",
  };
  expenseParticipants = ["member-1"];
  auditEntries = [];
  adjustments = [];

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) {
      if (statement.sql.includes("INSERT INTO app_settings")) {
        if (statement.sql.includes("'font-size'")) {
          this.fontSize = Number(statement.values[0]);
        } else {
          this.columnWidths = JSON.parse(statement.values[0]);
        }
      }
      if (statement.sql.includes("INSERT INTO payment_adjustments")) {
        this.adjustments.push({
          id: statement.values[0],
          memberId: statement.values[1],
          amountVnd: statement.values[2],
          createdAt: "2026-10-17 11:00:00",
        });
      }
      if (statement.sql.includes("UPDATE expenses SET payer_id")) {
        [this.expense.payerId, this.expense.description, this.expense.amountVnd] = statement.values;
      }
      if (statement.sql.includes("DELETE FROM expense_participants")) {
        this.expenseParticipants = [];
      }
      if (statement.sql.includes("INSERT INTO expense_participants")) {
        this.expenseParticipants.push(statement.values[1]);
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
      }
    }
    return [];
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
});
