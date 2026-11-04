// Each ledger is its own set of tables: the default ledger uses the unprefixed names created by
// migrations, every other ledger uses ledger_<32 hex id>_<table>. Route code is written against the
// unprefixed names and reaches a ledger through ledgerDatabase(), which rewrites table identifiers.

// Parents before children (foreign keys); deleting a ledger drops them in reverse order.
// app_settings is legacy (settings moved to global_app_settings in 0012); per-ledger rate_limits and
// admin_session_store_auth are no longer written (all buckets and the Admin session's operations
// authorization live in the unprefixed tables). They stay so copies keep the same schema.
export const LEDGER_TABLES = Object.freeze([
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
]);

// Shared by every ledger and always reached through the raw database (ctx.globalDB).
export const GLOBAL_TABLES = Object.freeze(["ledgers", "global_app_settings"]);

// Version 1 = audit_log trimmed by rowid range and without audit_log_created_idx (migration 0013).
// Migrations must be applied before this Worker is deployed (scripts/push_to_server.ps1 applies them
// first): the ledger lookup reads ledgers.schema_version.
export const LEDGER_SCHEMA_VERSION = 1;

const TABLE_NAMES = new Map(LEDGER_TABLES.map((name) => [name.toLowerCase(), name]));
const SQL_TOKEN = /'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|\b[A-Za-z_][A-Za-z0-9_]*\b/g;
const CREATE_INDEX_NAME = /\b(CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)/i;
const CREATE_TRIGGER_NAME = /\b(CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?)([A-Za-z_][A-Za-z0-9_]*)/i;
const MAX_CACHED_SQL = 500;
const rewrittenSql = new Map();

function ledgerTablePrefix(ledgerId) {
  if (ledgerId === "default") return "";
  if (!/^[\da-f]{32}$/i.test(ledgerId)) throw new Error("Invalid ledger identifier.");
  return `ledger_${ledgerId}_`;
}

// SQLite identifiers are case-insensitive; string literals are left untouched.
export function rewriteLedgerSql(sql, prefix) {
  if (!prefix) return sql;
  const cacheKey = `${prefix}\n${sql}`;
  const cached = rewrittenSql.get(cacheKey);
  if (cached !== undefined) return cached;
  const rewritten = sql
    .replace(SQL_TOKEN, (token) => {
      const quote = token[0];
      if (quote === "'") return token;
      const quoted = quote === "\"" || quote === "`" || quote === "[";
      const table = TABLE_NAMES.get((quoted ? token.slice(1, -1) : token).toLowerCase());
      if (!table) return token;
      return quoted ? `${quote}${prefix}${table}${quote === "[" ? "]" : quote}` : `${prefix}${table}`;
    })
    .replace(CREATE_INDEX_NAME, (_match, prefixText, name) => `${prefixText}${prefix}${name}`)
    .replace(CREATE_TRIGGER_NAME, (_match, prefixText, name) => `${prefixText}${prefix}${name}`);
  if (rewrittenSql.size >= MAX_CACHED_SQL) rewrittenSql.clear();
  rewrittenSql.set(cacheKey, rewritten);
  return rewritten;
}

// Fail-closed: only prepare() and batch() exist, so nothing can reach unprefixed tables by accident.
export function ledgerDatabase(database, ledgerId) {
  const prefix = ledgerTablePrefix(ledgerId);
  return {
    prepare: (sql) => database.prepare(rewriteLedgerSql(sql, prefix)),
    batch: (statements) => database.batch(statements),
  };
}

// The default tables' current schema, which a new ledger copies. The caller runs this read (inside its
// own batch if it likes) and passes the rows to ledgerSchemaFromRows.
export function ledgerSchemaQuery(database) {
  const placeholders = LEDGER_TABLES.map(() => "?").join(", ");
  return database.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND (
      (type = 'table' AND name IN (${placeholders}))
      OR (type IN ('index', 'trigger') AND tbl_name IN (${placeholders}))
    )
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END
  `).bind(...LEDGER_TABLES, ...LEDGER_TABLES);
}

// The CREATE statements for a new ledger from the rows of ledgerSchemaQuery.
export function ledgerSchemaFromRows(database, ledgerId, objects) {
  const prefix = ledgerTablePrefix(ledgerId);
  const tableCount = objects.filter((object) => object.type === "table").length;
  if (tableCount !== LEDGER_TABLES.length) {
    throw new Error("Không thể tạo sổ mới vì schema cơ sở dữ liệu chưa đầy đủ.");
  }
  return objects.map((object) => database.prepare(rewriteLedgerSql(object.sql, prefix)));
}

// DROP statements for the ledger's existing tables (children first; indexes and triggers go with
// their tables), or null when a prefixed table is not a known ledger table.
export async function ledgerDropStatements(database, ledgerId) {
  const prefix = ledgerTablePrefix(ledgerId);
  const tables = await database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND substr(name, 1, length(?)) = ?
  `).bind(prefix, prefix).all();
  const existing = new Set(tables.results.map(({ name }) => name.slice(prefix.length)));
  if ([...existing].some((table) => !LEDGER_TABLES.includes(table))) return null;
  return [...LEDGER_TABLES].reverse()
    .filter((table) => existing.has(table))
    .map((table) => database.prepare(`DROP TABLE IF EXISTS "${prefix}${table}"`));
}

// Must match the trigger created by migrations/0013_cheaper_audit_log_retention.sql (asserted by tests).
export function auditLogRetentionTriggerSql(prefix) {
  return `CREATE TRIGGER "${prefix}audit_log_keep_latest_999" AFTER INSERT ON "${prefix}audit_log" ` +
    `BEGIN DELETE FROM "${prefix}audit_log" WHERE id <= NEW.id - 999; END`;
}

// Brings a ledger created before migration 0013 to LEDGER_SCHEMA_VERSION. Runs on the RAW database
// with explicit names: rewriteLedgerSql does not prefix DROP TRIGGER/DROP INDEX names, so going through
// ledgerDatabase() would drop the default ledger's objects. A failure is retried on a later request.
export async function upgradeLedgerSchema(database, ledgerId) {
  const prefix = ledgerTablePrefix(ledgerId);
  try {
    await database.batch([
      database.prepare(`DROP TRIGGER IF EXISTS "${prefix}audit_log_keep_latest_999"`),
      database.prepare(auditLogRetentionTriggerSql(prefix)),
      database.prepare(`DROP INDEX IF EXISTS "${prefix}audit_log_created_idx"`),
      database.prepare(`
        UPDATE ledgers SET schema_version = ${LEDGER_SCHEMA_VERSION}
        WHERE id = ? AND schema_version < ${LEDGER_SCHEMA_VERSION}
      `).bind(ledgerId),
    ]);
  } catch (caught) {
    console.error("Ledger schema upgrade failed", caught);
  }
}
