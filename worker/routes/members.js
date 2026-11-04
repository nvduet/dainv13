import { MAX_MEMBERS, MAX_NAME_LENGTH } from "../../public/shared/constants.mjs";
import { audit } from "../audit.js";
import { decodePathParam, error, json, readJson } from "../http.js";
import { validName } from "../validation.js";

const NAME_MESSAGE = `Tên thành viên cần có từ 1 đến ${MAX_NAME_LENGTH} ký tự.`;
const DUPLICATE_MESSAGE = "Tên thành viên này đã có trong danh sách.";

function findDuplicate(db, name, exceptId = null) {
  return exceptId === null
    ? db.prepare("SELECT id FROM members WHERE name = ?").bind(name).first()
    : db.prepare("SELECT id FROM members WHERE name = ? AND id <> ?").bind(name, exceptId).first();
}

// The member limit and the unique name are checked inside the INSERT, so concurrent adds cannot
// exceed the limit or duplicate a name. The audit row is written only for the inserted row; its JSON
// is JSON.stringify's output with the position appended in SQL, so it stays byte-identical even for
// names that are not well-formed UTF-16 (json_object would re-encode them).
export async function createMember({ request, db, auditActor }) {
  const body = await readJson(request);
  if (!validName(body.name)) return error(NAME_MESSAGE);
  const id = crypto.randomUUID();
  const name = body.name.trim();
  const auditJsonStart = `${JSON.stringify({ id, name }).slice(0, -1)},"position":`;
  const [inserted] = await db.batch([
    db.prepare(`
      INSERT INTO members (id, name, position)
      SELECT ?, ?, next FROM (
        SELECT COALESCE(MAX(position), -1) + 1 AS next, COUNT(*) AS total FROM members
      ) WHERE total < ${MAX_MEMBERS}
      ON CONFLICT DO NOTHING
      RETURNING position
    `).bind(id, name),
    db.prepare(`
      INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
      SELECT ?, 'create', 'member', id, NULL, ? || position || '}'
      FROM members WHERE id = ?
    `).bind(auditActor, auditJsonStart, id),
  ]);
  const [row] = inserted.results;
  if (!row) {
    if (await findDuplicate(db, name)) return error(DUPLICATE_MESSAGE, 409);
    return error(`Danh sách đã đạt giới hạn ${MAX_MEMBERS} thành viên.`);
  }
  return json({ member: { id, name, position: Number(row.position) } }, 201);
}

async function findMember(db, id) {
  if (id === null) return null;
  return db.prepare(`
    SELECT id, name, position FROM members WHERE id = ?
  `).bind(id).first();
}

export async function renameMember({ request, db, params, auditActor }) {
  const id = decodePathParam(params[0]);
  const before = await findMember(db, id);
  if (!before) return error("Không tìm thấy thành viên.", 404);
  const body = await readJson(request);
  if (!validName(body.name)) return error(NAME_MESSAGE);
  const after = { ...before, name: body.name.trim() };
  if (await findDuplicate(db, after.name, id)) return error(DUPLICATE_MESSAGE, 409);
  try {
    await db.batch([
      db.prepare("UPDATE members SET name = ? WHERE id = ?").bind(after.name, id),
      audit(db, auditActor, "rename", "member", id, before, after),
    ]);
  } catch (caught) {
    // A concurrent rename can take the name between the check and the update.
    if (await findDuplicate(db, after.name, id)) return error(DUPLICATE_MESSAGE, 409);
    throw caught;
  }
  return json({ member: after });
}

export async function deleteMember({ db, params, auditActor }) {
  const id = decodePathParam(params[0]);
  const before = await findMember(db, id);
  if (!before) return error("Không tìm thấy thành viên.", 404);
  const impact = await db.prepare(`
    SELECT COUNT(*) AS count FROM expenses
    WHERE payer_id = ? OR id IN (
      SELECT expense_id FROM expense_participants WHERE member_id = ?
    )
  `).bind(id, id).first();
  await db.batch([
    db.prepare(`
      DELETE FROM expenses
      WHERE payer_id = ? OR id IN (
        SELECT expense_id FROM expense_participants WHERE member_id = ?
      )
    `).bind(id, id),
    db.prepare("DELETE FROM members WHERE id = ?").bind(id),
    db.prepare(`
      DELETE FROM member_groups
      WHERE id NOT IN (
        SELECT group_id FROM member_group_members
        GROUP BY group_id HAVING COUNT(*) >= 2
      )
    `),
    audit(
      db,
      auditActor,
      "hard_delete",
      "member",
      id,
      { ...before, impactedExpenses: Number(impact.count) },
      null,
    ),
  ]);
  return json({ deleted: true, impactedExpenses: Number(impact.count) });
}
