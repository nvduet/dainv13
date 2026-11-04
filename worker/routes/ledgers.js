import { DEFAULT_LEDGER, MAX_NAME_LENGTH } from "../../public/shared/constants.mjs";
import { ApiError, decodePathParam, error, json, readJson } from "../http.js";
import {
  LEDGER_SCHEMA_VERSION,
  ledgerDropStatements,
  ledgerSchemaFromRows,
  ledgerSchemaQuery,
} from "../ledger-schema.js";
import {
  operationsAuthorizationQuery,
  operationsPasswordAttempt,
  recordOperationsAuthorization,
  requireOperationsPassword,
  requireOperationsPasswordConfigured,
} from "../operations-password.js";
import { validName } from "../validation.js";

function makeLedgerSlug(name) {
  return name.trim()
    .replace(/đ/gi, "d")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/g, "");
}

export async function listLedgers({ db }) {
  const result = await db.prepare(`
    SELECT id, slug, name, created_at AS createdAt
    FROM ledgers ORDER BY created_at, rowid
  `).all();
  return json({ ledgers: result.results });
}

// A deletePassword sent by a page cached before the operations password is ignored; new ledgers keep
// delete_password_salt/hash NULL. Without the session's operations authorization the password is
// checked, and its limiter runs in the same round trip as the schema read.
async function insertLedger(ctx) {
  const { request, env, db, globalDB, adminSession } = ctx;
  const body = await readJson(request);
  if (!validName(body.name)) return error(`Tên sổ cần có từ 1 đến ${MAX_NAME_LENGTH} ký tự.`);
  const name = body.name.trim();
  const slug = makeLedgerSlug(name);
  if (!slug) return error("Tên sổ cần chứa ít nhất một ký tự chữ hoặc số.");
  const findSlug = () => db.prepare("SELECT id FROM ledgers WHERE slug = ?").bind(slug);
  const [existing, authorization] = await db.batch([
    findSlug(),
    operationsAuthorizationQuery(globalDB, adminSession.sessionId),
  ]);
  if (existing.results.length > 0) return error("Tên này đã được dùng để tạo link sổ khác.", 409);
  let attempt = null;
  if (authorization.results.length === 0) {
    await requireOperationsPasswordConfigured(env);
    attempt = await operationsPasswordAttempt(ctx, body.password,
      "Nhập mật khẩu thao tác để tạo sổ trong phiên Admin này.");
  }
  const reads = await db.batch([...(attempt?.statements ?? []), ledgerSchemaQuery(db)]);
  await attempt?.verify(reads);

  const ledger = { id: crypto.randomUUID().replace(/-/g, ""), slug, name };
  // The table-count check throws before anything is written; the row, every table and the session's
  // authorization are then written in one batch, so a failure leaves none of them behind.
  const schema = ledgerSchemaFromRows(db, ledger.id, reads.at(-1).results);
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO ledgers (id, slug, name, schema_version)
        VALUES (?, ?, ?, ${LEDGER_SCHEMA_VERSION})
      `).bind(ledger.id, ledger.slug, ledger.name),
      ...schema,
      ...(attempt ? [recordOperationsAuthorization(globalDB, adminSession.sessionId)] : []),
    ]);
  } catch (caught) {
    if (await findSlug().first()) return error("Tên này đã được dùng để tạo link sổ khác.", 409);
    throw caught;
  }
  return json({ ledger, storePasswordVerified: true }, 201);
}

// Only Admin reaches this route, so unexpected failures include their technical cause.
export async function createLedger(ctx) {
  try {
    return await insertLedger(ctx);
  } catch (caught) {
    if (caught instanceof ApiError) throw caught;
    console.error("Request failed", caught);
    const detail = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
    return error(`Không tạo được sổ. Chi tiết kỹ thuật: ${detail.slice(0, 1000)}`, 500);
  }
}

// Always asks for the operations password, for every ledger: delete-password hashes stored by older
// versions are ignored. The default ledger is never deleted. Pages cached before the operations
// password send no body, which reads as a missing password.
export async function deleteLedger(ctx) {
  const { request, env, db, params } = ctx;
  const slug = decodePathParam(params[0]);
  const ledger = slug === null
    ? null
    : await db.prepare("SELECT id, slug FROM ledgers WHERE slug = ?").bind(slug).first();
  if (!ledger) return error("Không tìm thấy sổ chi tiêu.", 404);
  if (ledger.id === "default") {
    return error(`Sổ ${DEFAULT_LEDGER.name} hiện tại được bảo vệ và không thể xóa.`, 403);
  }
  await requireOperationsPasswordConfigured(env);
  const body = await readJson(request, { allowEmpty: true });
  await requireOperationsPassword(ctx, body.password, "Nhập mật khẩu thao tác.");

  const drops = await ledgerDropStatements(db, ledger.id);
  if (!drops) return error("Schema sổ không hợp lệ; không xóa được an toàn.", 500);
  await db.batch([
    ...drops,
    db.prepare("DELETE FROM ledgers WHERE id = ? AND slug = ?").bind(ledger.id, ledger.slug),
  ]);
  return json({ deleted: true, slug: ledger.slug });
}
