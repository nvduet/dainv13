import { MAX_HISTORY_MESSAGE_LENGTH, MAX_HISTORY_POINTS } from "../../public/shared/constants.mjs";
import { audit, exceedsStoredJsonLimit } from "../audit.js";
import { decodePathParam, error, json, readJson } from "../http.js";
import {
  authorizeOperations,
  operationsAuthorizationQuery,
  requireOperationsPassword,
  requireOperationsPasswordConfigured,
} from "../operations-password.js";

export async function listHistoryPoints({ db }) {
  const result = await db.prepare(`
    SELECT id, created_at AS createdAt, member_count AS memberCount,
           expense_count AS expenseCount, message
    FROM history_points ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_HISTORY_POINTS}
  `).all();
  return json({ points: result.results });
}

export async function storeHistoryPoint(ctx) {
  const { request, db, globalDB, adminSession, auditActor } = ctx;
  const body = await readJson(request);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_HISTORY_MESSAGE_LENGTH) {
    return error(`Nhập message từ 1 đến ${MAX_HISTORY_MESSAGE_LENGTH} ký tự cho điểm lưu.`);
  }
  const authorization = await operationsAuthorizationQuery(globalDB, adminSession.sessionId).first();
  const authorize = await authorizeOperations(ctx, Boolean(authorization), body.password,
    "Nhập mật khẩu thao tác để xác thực Store trong phiên Admin này.");
  const [membersResult, expensesResult, participantsResult, paymentsResult, adjustmentsResult] =
    await db.batch([
      db.prepare("SELECT id, name, position, created_at AS createdAt FROM members ORDER BY position, name COLLATE NOCASE"),
      db.prepare(`SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd,
        expense_date AS date, position, created_at AS createdAt, updated_at AS updatedAt
        FROM expenses ORDER BY position, created_at, id`),
      db.prepare("SELECT expense_id AS expenseId, member_id AS memberId FROM expense_participants ORDER BY expense_id, member_id"),
      db.prepare(`SELECT id, member_id AS memberId, direction, amount_vnd AS amountVnd,
        status, created_at AS createdAt, confirmed_at AS confirmedAt, confirmed_by AS confirmedBy
        FROM payments ORDER BY created_at, id`),
      db.prepare(`SELECT id, member_id AS memberId, amount_delta_vnd AS amountVnd,
        created_by AS createdBy, created_at AS createdAt
        FROM payment_adjustments ORDER BY created_at, id`),
    ]);
  const snapshot = {
    members: membersResult.results,
    expenses: expensesResult.results,
    participants: participantsResult.results,
    payments: paymentsResult.results,
    adjustments: adjustmentsResult.results,
  };
  const snapshotJson = JSON.stringify(snapshot);
  if (exceedsStoredJsonLimit(snapshotJson)) {
    return error("Dữ liệu sổ quá lớn để Store (vượt giới hạn 2 MB của D1).", 413);
  }
  const point = {
    id: crypto.randomUUID(),
    memberCount: snapshot.members.length,
    expenseCount: snapshot.expenses.length,
    message,
  };
  await db.batch([
    db.prepare(`
      INSERT INTO history_points (id, snapshot_json, member_count, expense_count, message)
      VALUES (?, ?, ?, ?, ?)
    `).bind(point.id, snapshotJson, point.memberCount, point.expenseCount, message),
    db.prepare(`
      DELETE FROM history_points
      WHERE id NOT IN (
        SELECT id FROM history_points ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_HISTORY_POINTS}
      )
    `),
    audit(db, auditActor, "store", "history_point", point.id, null, {
      memberCount: point.memberCount,
      expenseCount: point.expenseCount,
      message,
    }),
    ...authorize,
  ]);
  return json({ point, storePasswordVerified: true }, 201);
}

export async function restoreHistoryPoint(ctx) {
  const { request, env, db, params, auditActor } = ctx;
  await requireOperationsPasswordConfigured(env);
  const body = await readJson(request);
  await requireOperationsPassword(ctx, body.password, "Nhập mật khẩu thao tác.", { spendLimiter: false });
  const id = decodePathParam(params[0]);
  const point = id === null ? null : await db.prepare(
    "SELECT snapshot_json AS snapshotJson FROM history_points WHERE id = ?",
  ).bind(id).first();
  if (!point) return error("Không tìm thấy điểm khôi phục.", 404);
  let snapshot;
  try {
    snapshot = JSON.parse(point.snapshotJson);
  } catch {
    return error("Dữ liệu điểm khôi phục bị lỗi.", 500);
  }
  if (!snapshot || !Array.isArray(snapshot.members) || !Array.isArray(snapshot.expenses) ||
      !Array.isArray(snapshot.participants) || !Array.isArray(snapshot.payments) ||
      !Array.isArray(snapshot.adjustments)) {
    return error("Cấu trúc điểm khôi phục không hợp lệ.", 500);
  }
  // Groups are not part of a point: current groups are kept for members that still exist.
  const savedGroupMembers = await db.prepare(
    "SELECT member_id AS memberId, group_id AS groupId FROM member_group_members",
  ).all();
  const restoredMemberIds = new Set(snapshot.members.map((member) => member.id));
  const retainedGroupMembers = savedGroupMembers.results
    .filter(({ memberId }) => restoredMemberIds.has(memberId));
  // Older points may lack a column; COALESCE only where the schema has a default.
  await db.batch([
    db.prepare("DELETE FROM expenses"),
    db.prepare("DELETE FROM payments"),
    db.prepare("DELETE FROM payment_adjustments"),
    db.prepare("DELETE FROM members"),
    db.prepare(`
      INSERT INTO members (id, name, position, created_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.name'),
        COALESCE(json_extract(value, '$.position'), 0),
        COALESCE(json_extract(value, '$.createdAt'), CURRENT_TIMESTAMP)
      FROM json_each(?)
    `).bind(JSON.stringify(snapshot.members)),
    db.prepare(`
      INSERT INTO member_group_members (member_id, group_id)
      SELECT json_extract(value, '$.memberId'), json_extract(value, '$.groupId')
      FROM json_each(?)
    `).bind(JSON.stringify(retainedGroupMembers)),
    db.prepare(`
      DELETE FROM member_groups
      WHERE id NOT IN (
        SELECT group_id FROM member_group_members
        GROUP BY group_id HAVING COUNT(*) >= 2
      )
    `),
    db.prepare(`
      INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date,
        position, created_at, updated_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.payerId'),
        COALESCE(json_extract(value, '$.description'), ''),
        COALESCE(json_extract(value, '$.amountVnd'), 0),
        json_extract(value, '$.date'),
        COALESCE(json_extract(value, '$.position'), 0),
        COALESCE(json_extract(value, '$.createdAt'), CURRENT_TIMESTAMP),
        COALESCE(json_extract(value, '$.updatedAt'), CURRENT_TIMESTAMP)
      FROM json_each(?)
    `).bind(JSON.stringify(snapshot.expenses)),
    db.prepare(`
      INSERT INTO expense_participants (expense_id, member_id)
      SELECT json_extract(value, '$.expenseId'), json_extract(value, '$.memberId')
      FROM json_each(?)
    `).bind(JSON.stringify(snapshot.participants)),
    db.prepare(`
      INSERT INTO payments (id, member_id, direction, amount_vnd, status,
        created_at, confirmed_at, confirmed_by)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.memberId'),
        json_extract(value, '$.direction'), json_extract(value, '$.amountVnd'),
        json_extract(value, '$.status'),
        COALESCE(json_extract(value, '$.createdAt'), CURRENT_TIMESTAMP),
        json_extract(value, '$.confirmedAt'), json_extract(value, '$.confirmedBy')
      FROM json_each(?)
    `).bind(JSON.stringify(snapshot.payments)),
    db.prepare(`
      INSERT INTO payment_adjustments (id, member_id, amount_delta_vnd, created_by, created_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.memberId'),
        json_extract(value, '$.amountVnd'),
        COALESCE(json_extract(value, '$.createdBy'), 'admin'),
        COALESCE(json_extract(value, '$.createdAt'), CURRENT_TIMESTAMP)
      FROM json_each(?)
    `).bind(JSON.stringify(snapshot.adjustments)),
    audit(db, auditActor, "restore", "history_point", id, null, {
      memberCount: snapshot.members.length,
      expenseCount: snapshot.expenses.length,
    }),
  ]);
  return json({ restored: true });
}
