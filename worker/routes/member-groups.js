import { audit } from "../audit.js";
import { decodePathParam, error, json, readJson } from "../http.js";
import { validIds, validName } from "../validation.js";

function validGroupBody(body) {
  return validName(body.name) && validIds(body.memberIds) && body.memberIds.length >= 2;
}

// The group's name and members must be free; groupId excludes the group being edited.
// Also re-run after a failed write, because a concurrent request may have taken them.
async function groupConflict(db, name, memberIds, groupId = null) {
  const duplicate = groupId === null
    ? await db.prepare("SELECT id FROM member_groups WHERE name = ?").bind(name).first()
    : await db.prepare("SELECT id FROM member_groups WHERE name = ? AND id <> ?").bind(name, groupId).first();
  if (duplicate) return error("Tên nhóm đã tồn tại.", 409);
  const placeholders = memberIds.map(() => "?").join(",");
  const [memberCount, conflicts] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM members WHERE id IN (${placeholders})`)
      .bind(...memberIds).first(),
    groupId === null
      ? db.prepare(`SELECT member_id AS memberId FROM member_group_members WHERE member_id IN (${placeholders})`)
        .bind(...memberIds).all()
      : db.prepare(`
          SELECT member_id AS memberId FROM member_group_members
          WHERE group_id <> ? AND member_id IN (${placeholders})
        `).bind(groupId, ...memberIds).all(),
  ]);
  if (Number(memberCount.count) !== memberIds.length) {
    return error("Một hoặc nhiều thành viên không tồn tại.", 404);
  }
  if (conflicts.results.length) {
    return error("Một thành viên không thể thuộc hai nhóm.");
  }
  return null;
}

async function writeGroup(db, statements, name, memberIds, groupId = null) {
  try {
    await db.batch(statements);
    return null;
  } catch (caught) {
    const conflict = await groupConflict(db, name, memberIds, groupId);
    if (conflict) return conflict;
    throw caught;
  }
}

function insertMemberships(db, groupId, memberIds) {
  return memberIds.map((memberId) => db.prepare(
    "INSERT INTO member_group_members (member_id, group_id) VALUES (?, ?)",
  ).bind(memberId, groupId));
}

export async function createGroup({ request, db, auditActor }) {
  const body = await readJson(request);
  if (!validGroupBody(body)) return error("Nhóm cần tên hợp lệ và ít nhất hai thành viên.");
  const name = body.name.trim();
  const conflict = await groupConflict(db, name, body.memberIds);
  if (conflict) return conflict;
  const position = await db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM member_groups").first();
  const group = {
    id: crypto.randomUUID(),
    name,
    position: Number(position.next),
    memberIds: body.memberIds,
  };
  const failure = await writeGroup(db, [
    db.prepare("INSERT INTO member_groups (id, name, position) VALUES (?, ?, ?)")
      .bind(group.id, group.name, group.position),
    ...insertMemberships(db, group.id, group.memberIds),
    audit(db, auditActor, "create", "member_group", group.id, null, group),
  ], name, body.memberIds);
  return failure || json({ group }, 201);
}

async function findGroup(db, id) {
  if (id === null) return null;
  const group = await db.prepare(
    "SELECT id, name, position FROM member_groups WHERE id = ?",
  ).bind(id).first();
  if (!group) return null;
  const members = await db.prepare(
    "SELECT member_id AS memberId FROM member_group_members WHERE group_id = ? ORDER BY member_id",
  ).bind(id).all();
  return { ...group, memberIds: members.results.map(({ memberId }) => memberId) };
}

export async function updateGroup({ request, db, params, auditActor }) {
  const id = decodePathParam(params[0]);
  const before = await findGroup(db, id);
  if (!before) return error("Không tìm thấy nhóm.", 404);
  const body = await readJson(request);
  if (!validGroupBody(body)) return error("Nhóm cần tên hợp lệ và ít nhất hai thành viên.");
  const name = body.name.trim();
  const conflict = await groupConflict(db, name, body.memberIds, id);
  if (conflict) return conflict;
  const after = { ...before, name, memberIds: body.memberIds };
  const failure = await writeGroup(db, [
    db.prepare("UPDATE member_groups SET name = ? WHERE id = ?").bind(name, id),
    db.prepare("DELETE FROM member_group_members WHERE group_id = ?").bind(id),
    ...insertMemberships(db, id, body.memberIds),
    audit(db, auditActor, "update", "member_group", id, before, after),
  ], name, body.memberIds, id);
  return failure || json({ group: after });
}

export async function deleteGroup({ db, params, auditActor }) {
  const id = decodePathParam(params[0]);
  const before = await findGroup(db, id);
  if (!before) return error("Không tìm thấy nhóm.", 404);
  await db.batch([
    db.prepare("DELETE FROM member_groups WHERE id = ?").bind(id),
    audit(db, auditActor, "delete", "member_group", id, before, null),
  ]);
  return json({ deleted: true });
}
