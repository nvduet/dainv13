import { MAX_DESCRIPTION_LENGTH } from "../../public/shared/constants.mjs";
import { audit } from "../audit.js";
import { decodePathParam, error, json, readJson } from "../http.js";
import {
  validExpenseDate,
  validExpenseId,
  validId,
  validIds,
  validParticipantChanges,
  validPosition,
  validSignedAmount,
} from "../validation.js";

const NOT_FOUND = "Không tìm thấy khoản chi.";
const EXPENSE_COLUMNS = Object.freeze({
  payerId: "payer_id",
  date: "expense_date",
  description: "description",
  amountVnd: "amount_vnd",
});
const PATCH_FIELDS = new Set([...Object.keys(EXPENSE_COLUMNS), "participantChanges"]);
// Body of a re-creation (POST /api/expenses): every one of these keys, nothing else.
const RECREATE_FIELDS = Object.freeze(["id", "position", "payerId", "date", "description", "amountVnd", "participantIds"]);

// withPosition: the row's place in entry order too (re-creation answers; PUT answers and audit rows stay as they were).
function expenseReads(db, id, { withPosition = false } = {}) {
  return [
    db.prepare(`
      SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd,
             expense_date AS date,
             created_at AS createdAt, updated_at AS updatedAt${withPosition ? ", position" : ""}
      FROM expenses WHERE id = ?
    `).bind(id),
    db.prepare(`
      SELECT member_id AS memberId FROM expense_participants
      WHERE expense_id = ? ORDER BY member_id
    `).bind(id),
  ];
}

function expenseFromResults(expenseResult, participantsResult) {
  const [expense] = expenseResult.results;
  if (!expense) return null;
  return { ...expense, participantIds: participantsResult.results.map((row) => row.memberId) };
}

async function getExpense(db, id, options = {}) {
  if (id === null) return null;
  const [expense, participants] = await db.batch(expenseReads(db, id, options));
  return expenseFromResults(expense, participants);
}

// Áp thay đổi tick/bỏ tick lên danh sách hiện tại để nhiều máy cùng tick không ghi đè lẫn nhau.
function applyParticipantChanges(participantIds, changes) {
  const removed = new Set(changes.remove ?? []);
  const next = participantIds.filter((id) => !removed.has(id));
  for (const id of changes.add ?? []) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

// The value checks PUT and a re-creation share (each field only when sent).
function fieldProblem(body) {
  if (Object.hasOwn(body, "payerId") &&
      body.payerId !== null && body.payerId !== "" && !validId(body.payerId)) {
    return "Người chi không hợp lệ.";
  }
  if (Object.hasOwn(body, "date") && !validExpenseDate(body.date)) {
    return "Ngày phải có định dạng YYYY-MM-DD hợp lệ.";
  }
  if (Object.hasOwn(body, "description") &&
      (typeof body.description !== "string" || body.description.length > MAX_DESCRIPTION_LENGTH)) {
    return `Nội dung không được dài quá ${MAX_DESCRIPTION_LENGTH} ký tự.`;
  }
  if (Object.hasOwn(body, "amountVnd") && !validSignedAmount(body.amountVnd)) {
    return "Số tiền phải là số đồng nguyên trong giới hạn cho phép.";
  }
  return null;
}

async function validateExpensePatch(db, body) {
  const fields = Object.keys(body);
  if (fields.length === 0 || fields.some((field) => !PATCH_FIELDS.has(field))) {
    return "Không có trường khoản chi hợp lệ để lưu.";
  }
  const problem = fieldProblem(body);
  if (problem) return problem;
  if (Object.hasOwn(body, "participantChanges") && !validParticipantChanges(body.participantChanges)) {
    return "Danh sách người tham gia không hợp lệ.";
  }
  // The current payer and participants exist (ON DELETE CASCADE), so only ids sent now are checked.
  const memberIds = [...new Set([
    ...(body.payerId ? [body.payerId] : []),
    ...(body.participantChanges?.add ?? []),
  ])];
  if (memberIds.length > 0) {
    const result = await db.prepare(
      `SELECT COUNT(*) AS count FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`,
    ).bind(...memberIds).first();
    if (Number(result.count) !== memberIds.length) {
      return "Một hoặc nhiều thành viên không còn tồn tại.";
    }
  }
  return null;
}

function participantWrites(db, id, removeIds, addIds) {
  return [
    ...(removeIds.length ? [db.prepare(`
      DELETE FROM expense_participants
      WHERE expense_id = ? AND member_id IN (${removeIds.map(() => "?").join(",")})
    `).bind(id, ...removeIds)] : []),
    ...addIds.map((memberId) => db.prepare(`
      INSERT OR IGNORE INTO expense_participants (expense_id, member_id) VALUES (?, ?)
    `).bind(id, memberId)),
  ];
}

// POST /api/expenses: no body or {} (what "Add line" and the duplicate button send) adds an empty row at the end
// of entry order; the answer also says where (its position, from the INSERT itself). A body with every
// RECREATE_FIELDS key re-creates a deleted row (recreateExpense); anything else is refused.
export async function createExpense({ request, db, auditActor }) {
  const body = await readJson(request, { allowEmpty: true });
  if (Object.keys(body).length > 0) return recreateExpense(db, auditActor, body);
  const id = crypto.randomUUID();
  const expense = {
    id,
    payerId: null,
    date: null,
    description: "",
    amountVnd: 0,
    participantIds: [],
  };
  const [inserted] = await db.batch([
    db.prepare(`
      INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date, position)
      SELECT ?, NULL, '', 0, NULL, COALESCE(MAX(position), -1) + 1 FROM expenses
      RETURNING position
    `).bind(id),
    audit(db, auditActor, "create", "expense", id, null, expense),
  ]);
  return json({ expense: { ...expense, createdAt: null, updatedAt: null, position: inserted.results[0]?.position ?? null } }, 201);
}

function recreateProblem(body) {
  if (Object.keys(body).length !== RECREATE_FIELDS.length || !RECREATE_FIELDS.every((field) => Object.hasOwn(body, field))) {
    return "Dữ liệu khoản chi không hợp lệ.";
  }
  if (!validExpenseId(body.id)) return "Mã khoản chi không hợp lệ.";
  if (body.position !== null && !validPosition(body.position)) return "Vị trí khoản chi không hợp lệ.";
  if (!validIds(body.participantIds, { allowEmpty: true })) return "Danh sách người tham gia không hợp lệ.";
  return fieldProblem(body);
}

// Undo of a delete (or redo of an "Add line"/duplicate whose row was deleted): the row comes back under its old id
// with its old values, at its old position while no row has it (otherwise at the end, like a new row; null: at the
// end), in one atomic batch that also writes the participants and the audit row and reads the stored row back.
// A payer or participant deleted meanwhile is left out (the answer shows what was stored). Idempotent: when the
// row already exists (another tab, a later visit or a lost answer re-created it) nothing is written and the answer
// is that row, created: false. Costs one PK read more than a plain add, only on this rare path.
async function recreateExpense(db, auditActor, body) {
  const problem = recreateProblem(body);
  if (problem) return error(problem);
  const { id, position, participantIds } = body;
  const existing = await getExpense(db, id, { withPosition: true });
  if (existing) return json({ expense: existing, created: false });
  const date = body.date || null;
  const description = body.description.trim();
  // The audit row has the keys (and key order) of a plain add's and records what was stored: the payer and the
  // participants come from the inserted rows (a member deleted meanwhile is not in them), the rest is
  // JSON.stringify'd here like every other audit value.
  const auditHead = JSON.stringify({ id }).slice(0, -1);
  const auditMiddle = JSON.stringify({ date, description, amountVnd: body.amountVnd }).slice(1, -1);
  let results;
  try {
    results = await db.batch([
      db.prepare(`
        INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date, position)
        SELECT ?, (SELECT id FROM members WHERE id = ?), ?, ?, ?,
               CASE WHEN ? IS NULL THEN COALESCE(MAX(position), -1) + 1
                    WHEN MAX(position = ?) THEN MAX(position) + 1 ELSE ? END
        FROM expenses
      `).bind(id, body.payerId || null, description, body.amountVnd, date, position, position, position),
      ...(participantIds.length ? [db.prepare(`
        INSERT INTO expense_participants (expense_id, member_id)
        SELECT ?, id FROM members WHERE id IN (${participantIds.map(() => "?").join(",")})
      `).bind(id, ...participantIds)] : []),
      db.prepare(`
        INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
        SELECT ?, 'create', 'expense', id, NULL,
               ? || ',"payerId":' || json_quote(payer_id) || ',' || ? || ',"participantIds":' || (
                 SELECT json_group_array(member_id) FROM (
                   SELECT member_id FROM expense_participants WHERE expense_id = ? ORDER BY member_id
                 )
               ) || '}'
        FROM expenses WHERE id = ?
      `).bind(auditActor, auditHead, auditMiddle, id, id),
      ...expenseReads(db, id, { withPosition: true }),
    ]);
  } catch (caught) {
    // The same row re-created at the same time (two tabs): the other insert won.
    const raced = await getExpense(db, id, { withPosition: true });
    if (raced) return json({ expense: raced, created: false });
    throw caught;
  }
  return json({ expense: expenseFromResults(...results.slice(-2)), created: true }, 201);
}

export async function updateExpense({ request, db, params, auditActor }) {
  const id = decodePathParam(params[0]);
  const before = await getExpense(db, id);
  if (!before) return error(NOT_FOUND, 404);
  const body = await readJson(request);
  // Only pages loaded before participantChanges existed send the full list, which would undo ticks
  // made meanwhile on other devices.
  if (Object.hasOwn(body, "participantIds")) {
    return error("Trang đang dùng phiên bản cũ. Hãy tải lại trang rồi thử lại.", 409);
  }
  const problem = await validateExpensePatch(db, body);
  if (problem) return error(problem);
  const changes = body.participantChanges ?? {};
  const after = {
    ...before,
    payerId: Object.hasOwn(body, "payerId")
      ? body.payerId || null
      : before.payerId,
    date: Object.hasOwn(body, "date")
      ? body.date || null
      : before.date,
    description: Object.hasOwn(body, "description")
      ? body.description.trim()
      : before.description,
    amountVnd: Object.hasOwn(body, "amountVnd")
      ? body.amountVnd
      : before.amountVnd,
    participantIds: applyParticipantChanges(before.participantIds, changes),
  };
  const changedFields = Object.keys(EXPENSE_COLUMNS).filter((field) => before[field] !== after[field]);
  const previous = new Set(before.participantIds);
  const current = new Set(after.participantIds);
  const added = after.participantIds.filter((memberId) => !previous.has(memberId));
  const removed = before.participantIds.filter((memberId) => !current.has(memberId));
  if (changedFields.length === 0 && added.length === 0 && removed.length === 0) {
    return json({ expense: before });
  }

  // The client's ticks are applied as sent (not as the before/after diff), so ticks from several phones merge.
  const participantStatements = participantWrites(db, id, changes.remove ?? [], changes.add ?? []);
  const assignments = [...changedFields.map((field) => `${EXPENSE_COLUMNS[field]} = ?`), "updated_at = CURRENT_TIMESTAMP"];
  let results;
  try {
    results = await db.batch([
      db.prepare(`
        UPDATE expenses SET ${assignments.join(", ")}
        WHERE id = ?
      `).bind(...changedFields.map((field) => after[field]), id),
      ...participantStatements,
      ...changedFields.map((field) => audit(
        db,
        auditActor,
        "update",
        "expense",
        id,
        { field, value: before[field] },
        { field, value: after[field] },
      )),
      ...added.map((memberId) => audit(
        db,
        auditActor,
        "participant_add",
        "expense_participant",
        `${id}:${memberId}`,
        null,
        { expenseId: id, memberId },
      )),
      ...removed.map((memberId) => audit(
        db,
        auditActor,
        "participant_remove",
        "expense_participant",
        `${id}:${memberId}`,
        { expenseId: id, memberId },
        null,
      )),
      ...expenseReads(db, id),
    ]);
  } catch (caught) {
    // Deleted concurrently: inserting a participant then fails its foreign key.
    const found = await db.prepare("SELECT 1 AS found FROM expenses WHERE id = ?").bind(id).first();
    if (!found) return error(NOT_FOUND, 404);
    throw caught;
  }
  const expense = expenseFromResults(...results.slice(-2));
  if (!expense) return error(NOT_FOUND, 404);
  return json({ expense });
}

export async function deleteExpense({ db, params, auditActor }) {
  const id = decodePathParam(params[0]);
  const before = await getExpense(db, id);
  if (!before) return error(NOT_FOUND, 404);
  await db.batch([
    db.prepare("DELETE FROM expenses WHERE id = ?").bind(id),
    audit(db, auditActor, "delete", "expense", id, before, null),
  ]);
  return json({ deleted: true });
}
