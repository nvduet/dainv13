import { readdirSync, readFileSync } from "node:fs";

let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}

export const sqliteUnavailable = sqlite
  ? false
  : "node:sqlite không khả dụng; cần Node.js 22.13 trở lên để chạy kiểm thử tích hợp.";

// The deploy gate (scripts/push_to_server.ps1) sets REQUIRE_NODE_SQLITE: there these suites must fail,
// not be skipped, when node:sqlite is missing.
if (sqliteUnavailable && process.env.REQUIRE_NODE_SQLITE) throw new Error(sqliteUnavailable);

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
// Giới hạn D1 (developers.cloudflare.com/d1/platform/limits) để kiểm thử bắt lỗi vượt giới hạn như production.
const D1_MAX_BOUND_PARAMETERS = 100;
const D1_MAX_SQL_BYTES = 100_000;
const D1_MAX_VALUE_BYTES = 2_000_000;
const encoder = new TextEncoder();

function toSqlValue(value) {
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && encoder.encode(value).byteLength > D1_MAX_VALUE_BYTES) {
    throw new Error("D1_ERROR: string or blob too big: SQLITE_TOOBIG");
  }
  return value;
}

class TestStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    if (values.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
    return new TestStatement(this.database, this.sql, values.map(toSqlValue));
  }

  execute() {
    if (encoder.encode(this.sql).byteLength > D1_MAX_SQL_BYTES) {
      throw new Error("D1_ERROR: statement too long: SQLITE_TOOBIG");
    }
    try {
      const results = this.database.sqlite.prepare(this.sql).all(...this.values).map((row) => ({ ...row }));
      return { success: true, results, meta: {} };
    } catch (caught) {
      throw new Error(`D1_ERROR: ${caught.message}`, { cause: caught });
    }
  }

  async first(column) {
    await this.database.roundTrip();
    const [row] = this.execute().results;
    if (!row) return null;
    return column === undefined ? row : row[column];
  }

  async all() {
    await this.database.roundTrip();
    return this.execute();
  }

  async run() {
    await this.database.roundTrip();
    return this.execute();
  }
}

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
}

class TestDatabase {
  constructor(database, { simulateIo = false } = {}) {
    this.sqlite = database;
    this.queryCount = 0;
    this.appliedMigrations = new Set();
    this.simulateIo = simulateIo;
  }

  // With simulateIo each query waits a short timer like a D1 round trip, so concurrent requests
  // interleave between their reads and writes (as they can in production).
  async roundTrip() {
    this.queryCount += 1;
    if (this.simulateIo) await new Promise((resolve) => setTimeout(resolve, 2));
  }

  // Applies pending migrations; with `before`, only those whose file name sorts before it.
  migrate({ before } = {}) {
    for (const name of migrationFiles()) {
      if (this.appliedMigrations.has(name) || (before && name >= before)) continue;
      this.sqlite.exec("BEGIN");
      try {
        this.sqlite.exec(readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"));
        this.sqlite.exec("COMMIT");
      } catch (caught) {
        this.sqlite.exec("ROLLBACK");
        throw new Error(`Migration ${name} failed: ${caught.message}`, { cause: caught });
      }
      this.appliedMigrations.add(name);
    }
  }

  prepare(sql) {
    return new TestStatement(this, sql);
  }

  async batch(statements) {
    await this.roundTrip();
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (caught) {
      this.sqlite.exec("ROLLBACK");
      throw caught;
    }
  }

  async exec(sql) {
    this.queryCount += 1;
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  rows(sql, ...values) {
    return this.sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
  }

  run(sql, ...values) {
    return this.sqlite.prepare(sql).run(...values);
  }
}

// `before` rebuilds an older production schema (e.g. "0013" = before migration 0013).
export function createTestDatabase({ before, simulateIo = false } = {}) {
  if (!sqlite) throw new Error(sqliteUnavailable);
  const database = new sqlite.DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const db = new TestDatabase(database, { simulateIo });
  db.migrate({ before });
  return db;
}
