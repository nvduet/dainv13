import { AUDIT_SESSION_IDLE_MINUTES, MAX_AUDIT_SESSIONS } from "../public/shared/constants.mjs";

// Stored audit_log.actor values: the column has CHECK (actor IN ('public', 'admin')), so they must not
// change. "guest" exists only as the audit_sessions guest_seen flag and in the audit API's actors list.
export const AUDIT_ACTOR = Object.freeze({ ADMIN: "admin", GUEST: "public" });

// D1 rejects values over 2 MB; stay below it with room for the rest of the row.
const MAX_STORED_JSON_BYTES = 1_900_000;
const encoder = new TextEncoder();

export function exceedsStoredJsonLimit(text) {
  if (text.length > MAX_STORED_JSON_BYTES) return true;
  if (text.length * 3 <= MAX_STORED_JSON_BYTES) return false;
  return encoder.encode(text).byteLength > MAX_STORED_JSON_BYTES;
}

export function audit(db, actor, action, entity, entityId, before, after) {
  return db.prepare(`
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    actor,
    action,
    entity,
    String(entityId),
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  );
}

// Shared verbatim by GET /api/state and the Detail snapshot.
export const MEMBERS_SQL = "SELECT id, name, position FROM members ORDER BY position, name COLLATE NOCASE";
export const MEMBER_GROUPS_SQL = "SELECT id, name, position FROM member_groups ORDER BY position, name COLLATE NOCASE";
export const MEMBER_GROUP_MEMBERS_SQL = "SELECT member_id AS memberId, group_id AS groupId FROM member_group_members";

export function groupParticipantsByExpense(rows) {
  const participantsByExpense = new Map();
  for (const { expenseId, memberId } of rows) {
    const list = participantsByExpense.get(expenseId) || [];
    list.push(memberId);
    participantsByExpense.set(expenseId, list);
  }
  return participantsByExpense;
}

// Members of a group are listed together, groups in their own order, ungrouped members last.
export function orderMembersByGroup(memberRows, groupRows, groupMemberRows) {
  const groupByMember = new Map(groupMemberRows.map(({ memberId, groupId }) => [memberId, groupId]));
  const groups = groupRows.map((group) => ({ ...group, memberIds: [] }));
  const groupPositions = new Map(groups.map((group) => [group.id, group.position]));
  const members = memberRows
    .map((member) => ({ ...member, groupId: groupByMember.get(member.id) || null }))
    .sort((left, right) => {
      const leftPosition = left.groupId ? groupPositions.get(left.groupId) : Number.MAX_SAFE_INTEGER;
      const rightPosition = right.groupId ? groupPositions.get(right.groupId) : Number.MAX_SAFE_INTEGER;
      return leftPosition - rightPosition || left.position - right.position ||
        left.name.localeCompare(right.name);
    });
  for (const group of groups) {
    group.memberIds = members.filter((member) => member.groupId === group.id).map((member) => member.id);
  }
  return { members, groups };
}

// The Detail snapshot (members, groups, expenses) as JSON, read in one batch. With probeAnchor the
// batch also reports whether audit_session_anchor already holds the baseline snapshot.
export async function readDetailSnapshot(db, { probeAnchor = false } = {}) {
  const results = await db.batch([
    db.prepare(MEMBERS_SQL),
    db.prepare(`SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd,
        expense_date AS date, position FROM expenses ORDER BY position, created_at, id`),
    db.prepare("SELECT expense_id AS expenseId, member_id AS memberId FROM expense_participants ORDER BY expense_id, member_id"),
    db.prepare(MEMBER_GROUPS_SQL),
    db.prepare(MEMBER_GROUP_MEMBERS_SQL),
    ...(probeAnchor ? [db.prepare("SELECT 1 AS hasAnchor FROM audit_session_anchor WHERE id = 1")] : []),
  ]);
  const [members, expenses, participants, groups, groupMembers, anchor] = results.map((result) => result.results);
  const participantsByExpense = groupParticipantsByExpense(participants);
  const ordered = orderMembersByGroup(members, groups, groupMembers);
  const snapshot = {
    members: ordered.members,
    groups: ordered.groups,
    expenses: expenses.map((expense) => ({
      ...expense,
      participantIds: participantsByExpense.get(expense.id) || [],
    })),
  };
  return { json: JSON.stringify(snapshot), hasAnchor: anchor === undefined || anchor.length > 0 };
}

// Changes within AUDIT_SESSION_IDLE_MINUTES of the latest activity join that session; only the newest
// MAX_AUDIT_SESSIONS sessions are kept and the anchor holds the snapshot before the oldest kept one.
export async function recordDetailSession(db, isAdmin, before, after) {
  const bound = before.hasAnchor ? [after.json] : [before.json, after.json];
  if (bound.some(exceedsStoredJsonLimit)) {
    console.warn("Detail audit session skipped: snapshot exceeds the D1 value limit");
    return;
  }
  await db.batch([
    ...(before.hasAnchor ? [] : [db.prepare(`
      INSERT OR IGNORE INTO audit_session_anchor (id, snapshot_json)
      VALUES (1, ?)
    `).bind(before.json)]),
    db.prepare(`
      INSERT INTO audit_sessions (id, admin_seen, guest_seen, after_json)
      VALUES (COALESCE((SELECT id FROM audit_sessions
                        WHERE last_activity >= datetime('now', '-${AUDIT_SESSION_IDLE_MINUTES} minutes')
                        ORDER BY last_activity DESC, rowid DESC LIMIT 1), ?), ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET last_activity = CURRENT_TIMESTAMP,
        after_json = excluded.after_json,
        admin_seen = MAX(admin_seen, excluded.admin_seen),
        guest_seen = MAX(guest_seen, excluded.guest_seen)
    `).bind(crypto.randomUUID(), isAdmin ? 1 : 0, isAdmin ? 0 : 1, after.json),
    db.prepare(`
      UPDATE audit_session_anchor SET snapshot_json = (
          SELECT after_json FROM audit_sessions
          WHERE rowid <= (SELECT MAX(rowid) FROM audit_sessions) - ${MAX_AUDIT_SESSIONS}
          ORDER BY rowid DESC LIMIT 1)
      WHERE EXISTS (SELECT 1 FROM audit_sessions
                    WHERE rowid <= (SELECT MAX(rowid) FROM audit_sessions) - ${MAX_AUDIT_SESSIONS})
    `),
    db.prepare(`DELETE FROM audit_sessions WHERE rowid <= (SELECT MAX(rowid) FROM audit_sessions) - ${MAX_AUDIT_SESSIONS}`),
  ]);
}
