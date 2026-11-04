import assert from "node:assert/strict";
import test from "node:test";
import {
  GLOBAL_TABLES,
  LEDGER_SCHEMA_VERSION,
  LEDGER_TABLES,
  auditLogRetentionTriggerSql,
  ledgerSchemaFromRows,
  ledgerSchemaQuery,
  rewriteLedgerSql,
} from "../worker/ledger-schema.js";
import { createApp } from "./helpers/app.mjs";
import { createTestDatabase, sqliteUnavailable } from "./helpers/d1-sqlite.mjs";

const options = { skip: sqliteUnavailable };
const P = `ledger_${"0123456789abcdef".repeat(2)}_`;
const normalize = (sql) => sql.replace(/"/g, "").replace(/\s+/g, " ").trim();

test("rewriteLedgerSql prefixes ledger table identifiers and nothing else", () => {
  for (const [sql, expected] of [
    ["SELECT 'members' AS label, 'it''s expenses' FROM members",
      `SELECT 'members' AS label, 'it''s expenses' FROM ${P}members`],
    ["SELECT * FROM \"members\" JOIN `expenses` ON 1 JOIN [payments] ON 1",
      `SELECT * FROM "${P}members" JOIN \`${P}expenses\` ON 1 JOIN [${P}payments] ON 1`],
    ["SELECT \"members_extra\", \"a\"\"members\" FROM \"audit_log\"",
      `SELECT "members_extra", "a""members" FROM "${P}audit_log"`],
    ["SELECT current.id FROM audit_sessions current WHERE current.rowid > (SELECT MAX(previous.rowid) FROM audit_sessions previous)",
      `SELECT current.id FROM ${P}audit_sessions current WHERE current.rowid > (SELECT MAX(previous.rowid) FROM ${P}audit_sessions previous)`],
    ["SELECT member_id, expense_id FROM expense_participants WHERE member_id IN (SELECT id FROM members)",
      `SELECT member_id, expense_id FROM ${P}expense_participants WHERE member_id IN (SELECT id FROM ${P}members)`],
    ["select * from Members join EXPENSES using (id) join \"Member_Groups\" on 1",
      `select * from ${P}members join ${P}expenses using (id) join "${P}member_groups" on 1`],
    ["CREATE INDEX IF NOT EXISTS expenses_payer_idx ON expenses(payer_id)",
      `CREATE INDEX IF NOT EXISTS ${P}expenses_payer_idx ON ${P}expenses(payer_id)`],
    ["create unique index member_names on members (name)",
      `create unique index ${P}member_names on ${P}members (name)`],
    ["CREATE TRIGGER audit_log_keep_latest_999\nAFTER INSERT ON audit_log\nBEGIN\n  DELETE FROM audit_log WHERE id <= NEW.id - 999;\nEND",
      `CREATE TRIGGER ${P}audit_log_keep_latest_999\nAFTER INSERT ON ${P}audit_log\nBEGIN\n  DELETE FROM ${P}audit_log WHERE id <= NEW.id - 999;\nEND`],
    ["SELECT value_json FROM global_app_settings JOIN ledgers ON 1",
      "SELECT value_json FROM global_app_settings JOIN ledgers ON 1"],
    ["SELECT datetime('now', '-30 minutes'), json_extract(value, '$.members') FROM json_each(?)",
      "SELECT datetime('now', '-30 minutes'), json_extract(value, '$.members') FROM json_each(?)"],
  ]) {
    assert.equal(rewriteLedgerSql(sql, P), expected);
    assert.equal(rewriteLedgerSql(sql, P), expected, "memoized");
    assert.equal(rewriteLedgerSql(sql, ""), sql, "default ledger");
  }
  // The memo is bounded; results stay correct after it is cleared.
  for (let index = 0; index < 1_200; index += 1) {
    assert.equal(rewriteLedgerSql(`SELECT ${index} FROM members`, P), `SELECT ${index} FROM ${P}members`);
  }
});

test("ledger and global table lists cover every migrated table; parents come first", options, () => {
  const db = createTestDatabase();
  const tables = db.rows(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE 'd1\\_%' ESCAPE '\\'
  `).map(({ name }) => name);
  assert.deepEqual(tables.sort(), [...LEDGER_TABLES, ...GLOBAL_TABLES].sort());
  for (const [index, table] of LEDGER_TABLES.entries()) {
    for (const { parent } of db.rows("SELECT \"table\" AS parent FROM pragma_foreign_key_list(?)", table)) {
      assert.ok(LEDGER_TABLES.indexOf(parent) < index, `${parent} must come before ${table}`);
    }
  }
});

test("the audit_log retention trigger of migration 0013 is the shared definition and never scans", options, () => {
  const db = createTestDatabase();
  const [{ sql }] = db.rows("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_log_keep_latest_999'");
  assert.equal(normalize(sql), normalize(auditLogRetentionTriggerSql("")));
  assert.equal(db.rows("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'audit_log_created_idx'")[0].count, 0);
  assert.deepEqual(db.rows("SELECT id, schema_version AS version FROM ledgers"), [{ id: "default", version: 1 }]);

  const plan = (body) => db.rows(`EXPLAIN QUERY PLAN ${body.replace("NEW.id", "5000")}`)
    .map(({ detail }) => detail).join("; ");
  const body = sql.match(/BEGIN\s+([\s\S]*?);\s*END/i)[1];
  assert.equal(body, "DELETE FROM audit_log WHERE id <= NEW.id - 999");
  assert.doesNotMatch(plan(body), /SCAN/);
  assert.match(plan("DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 999)"), /SCAN/);
});

// A ledger created by the pre-0013 Worker (old trigger and index), with migration 0013 applied afterwards.
async function databaseWithLegacyLedger() {
  const db = createTestDatabase({ before: "0013" });
  const id = "a".repeat(32);
  db.run("INSERT INTO ledgers (id, slug, name) VALUES (?, 'so-cu', 'Sổ cũ')", id);
  await db.batch(ledgerSchemaFromRows(db, id, (await ledgerSchemaQuery(db).all()).results));
  db.migrate();
  return { db, id, prefix: `ledger_${id}_` };
}

test("a ledger created before 0013 is upgraded once and then matches a new ledger", options, async () => {
  const { db, id, prefix } = await databaseWithLegacyLedger();
  const sqlOf = (name) => db.rows("SELECT sql FROM sqlite_master WHERE name = ?", name)[0]?.sql;
  const version = () => db.rows("SELECT schema_version AS version FROM ledgers WHERE id = ?", id)[0].version;
  assert.match(sqlOf(`${prefix}audit_log_keep_latest_999`), /NOT IN/);
  assert.ok(sqlOf(`${prefix}audit_log_created_idx`));
  assert.equal(version(), 0);

  const app = createApp(undefined, { db });
  await app.login();
  const fresh = await app.createLedger("Sổ mới");
  const batch = db.batch.bind(db);
  let upgrades = 0;
  db.batch = (statements) => {
    if (statements.some((statement) => statement.sql.startsWith("CREATE TRIGGER"))) upgrades += 1;
    return batch(statements);
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await app.request("GET", "/api/g/so-cu/state");
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.ledger, { slug: "so-cu", name: "Sổ cũ" });
  }
  assert.equal(upgrades, 1);
  assert.equal(version(), LEDGER_SCHEMA_VERSION);

  const objects = (ledgerPrefix) => db.rows(`
    SELECT type, name, sql FROM sqlite_master WHERE substr(name, 1, length(?)) = ? ORDER BY type, name
  `, ledgerPrefix, ledgerPrefix).map(({ type, name, sql }) =>
    [type, name.slice(ledgerPrefix.length), normalize(sql.replaceAll(ledgerPrefix, ""))]);
  assert.deepEqual(objects(prefix), objects(fresh.prefix));
  assert.equal(normalize(sqlOf("audit_log_keep_latest_999")), normalize(auditLogRetentionTriggerSql("")));
  assert.ok(sqlOf(`${fresh.prefix}audit_log_keep_latest_999`));

  for (let index = 0; index < 1_005; index += 1) {
    db.run(`INSERT INTO "${prefix}audit_log" (actor, action, entity, entity_id) VALUES ('admin', 'test', 'test', ?)`, String(index));
  }
  assert.equal(app.count(`SELECT COUNT(*) AS count FROM "${prefix}audit_log"`), 999);
});

test("a failed upgrade is logged, the request is still served and a later request retries", options, async (t) => {
  const { db, id } = await databaseWithLegacyLedger();
  const app = createApp(undefined, { db });
  const errors = t.mock.method(console, "error", () => {});
  const batch = db.batch.bind(db);
  let failing = true;
  db.batch = async (statements) => {
    if (failing && statements.some((statement) => statement.sql.startsWith("CREATE TRIGGER"))) {
      throw new Error("D1_ERROR: injected failure");
    }
    return batch(statements);
  };
  const version = () => db.rows("SELECT schema_version AS version FROM ledgers WHERE id = ?", id)[0].version;
  assert.equal((await app.request("GET", "/api/g/so-cu/state")).status, 200);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0].arguments[0], "Ledger schema upgrade failed");
  assert.equal(version(), 0);

  failing = false;
  assert.equal((await app.request("GET", "/api/g/so-cu/state")).status, 200);
  assert.equal(version(), 1);
});

test("ledger creation is atomic: a failing CREATE leaves no row and no table", options, async (t) => {
  const app = createApp();
  await app.login();
  t.mock.method(console, "error", () => {});
  const prepare = app.db.prepare.bind(app.db);
  app.db.prepare = (sql) => prepare(sql.startsWith("CREATE TRIGGER ledger_") ? "CREATE TRIGGER broken" : sql);
  const failed = await app.request("POST", "/api/admin/ledgers", {
    body: { name: "Sổ hỏng", password: "restore-password" }, admin: true,
  });
  assert.equal(failed.status, 500);
  assert.match(failed.data.error, /^Không tạo được sổ\. Chi tiết kỹ thuật: Error: D1_ERROR: /);
  assert.deepEqual(app.db.rows("SELECT slug FROM ledgers"), [{ slug: "chill-guys" }]);
  assert.equal(app.count("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'ledger\\_%' ESCAPE '\\'"), 0);
  assert.equal(app.count("SELECT COUNT(*) AS count FROM admin_session_store_auth"), 0, "the authorization is part of the batch");

  app.db.prepare = prepare;
  const created = await app.createLedger("Sổ hỏng");
  assert.deepEqual(app.db.rows("SELECT schema_version AS version FROM ledgers WHERE id = ?", created.id), [{ version: 1 }]);
});

test("concurrent creation of one ledger name gives one ledger and one conflict", options, async () => {
  const app = createApp(undefined, { db: createTestDatabase({ simulateIo: true }) });
  await app.login();
  const create = (name) => app.request("POST", "/api/admin/ledgers", {
    body: { name, password: "restore-password" }, admin: true,
  });
  const responses = await Promise.all([create("Đà Lạt"), create("đà lạt!")]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
  assert.deepEqual(responses.find(({ status }) => status === 409).data, { error: "Tên này đã được dùng để tạo link sổ khác." });
  assert.equal(app.count("SELECT COUNT(*) AS count FROM ledgers"), 2);
});

test("deleting a ledger drops its existing tables and always removes its row", options, async () => {
  const app = createApp();
  await app.login();
  const prefixed = (prefix) => app.db.rows(
    "SELECT type, name FROM sqlite_master WHERE substr(name, 1, length(?)) = ? ORDER BY name", prefix, prefix);
  const remove = (slug) => app.request("DELETE", `/api/admin/ledgers/${slug}`, { body: { password: "restore-password" }, admin: true });
  const kept = await app.createLedger("Sổ giữ");
  const keptObjects = prefixed(kept.prefix);

  const partial = await app.createLedger("Sổ thiếu");
  for (const table of ["admin_session_store_auth", "audit_session_anchor", "expense_participants"]) {
    app.db.run(`DROP TABLE "${partial.prefix}${table}"`);
  }
  assert.equal((await remove(partial.slug)).status, 200);
  assert.deepEqual(prefixed(partial.prefix), []);

  const empty = await app.createLedger("Sổ rỗng");
  for (const table of [...LEDGER_TABLES].reverse()) app.db.run(`DROP TABLE "${empty.prefix}${table}"`);
  assert.equal((await remove(empty.slug)).status, 200);
  assert.equal(app.count("SELECT COUNT(*) AS count FROM ledgers WHERE id = ?", empty.id), 0);

  const foreign = await app.createLedger("Sổ lạ");
  app.db.run(`CREATE TABLE "${foreign.prefix}unknown" (id TEXT)`);
  const foreignObjects = prefixed(foreign.prefix);
  const refused = await remove(foreign.slug);
  assert.equal(refused.status, 500);
  assert.deepEqual(refused.data, { error: "Schema sổ không hợp lệ; không xóa được an toàn." });
  assert.deepEqual(prefixed(foreign.prefix), foreignObjects);
  assert.equal(app.count("SELECT COUNT(*) AS count FROM ledgers WHERE id = ?", foreign.id), 1);

  assert.deepEqual(prefixed(kept.prefix), keptObjects);
  assert.equal(normalize(app.db.rows("SELECT sql FROM sqlite_master WHERE name = 'audit_log_keep_latest_999'")[0].sql),
    normalize(auditLogRetentionTriggerSql("")));
});
