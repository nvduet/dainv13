import { DEFAULT_COLUMN_WIDTHS, FONT_SIZE, QR_SIZE } from "../../public/shared/constants.mjs";
import {
  MEMBER_GROUP_MEMBERS_SQL,
  MEMBER_GROUPS_SQL,
  MEMBERS_SQL,
  groupParticipantsByExpense,
  orderMembersByGroup,
} from "../audit.js";
import { json } from "../http.js";
import { operationsAuthorizationQuery } from "../operations-password.js";

// Everything the page needs, read in one batch (ledger tables and global settings share the database).
export async function state({ db, globalDB, ledger, adminSession }) {
  const results = await db.batch([
    db.prepare(MEMBERS_SQL),
    db.prepare(`
      SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd,
             expense_date AS date, created_at AS createdAt, updated_at AS updatedAt
      FROM expenses ORDER BY position, created_at, id
    `),
    db.prepare("SELECT expense_id AS expenseId, member_id AS memberId FROM expense_participants"),
    db.prepare(`
      SELECT id, member_id AS memberId, direction, amount_vnd AS amountVnd,
             status, created_at AS createdAt, confirmed_at AS confirmedAt
      FROM payments WHERE status = 'confirmed' ORDER BY created_at DESC, id DESC
    `),
    db.prepare(`
      SELECT id, member_id AS memberId, amount_delta_vnd AS amountVnd,
             created_at AS createdAt
      FROM payment_adjustments ORDER BY created_at DESC, id DESC
    `),
    db.prepare(MEMBER_GROUPS_SQL),
    db.prepare(MEMBER_GROUP_MEMBERS_SQL),
    globalDB.prepare("SELECT value_json AS valueJson FROM global_app_settings WHERE key = 'column-widths'"),
    globalDB.prepare("SELECT value_json AS valueJson FROM global_app_settings WHERE key = 'font-size'"),
    globalDB.prepare("SELECT value_json AS valueJson FROM global_app_settings WHERE key = 'qr-size'"),
    ...(adminSession ? [operationsAuthorizationQuery(globalDB, adminSession.sessionId)] : []),
  ]);
  const [members, expenses, participants, payments, adjustments, groups, groupMembers,
    [columnWidths], [fontSize], [qrSize], storeAuthorization = []] = results.map((result) => result.results);
  const participantsByExpense = groupParticipantsByExpense(participants);
  const ordered = orderMembersByGroup(members, groups, groupMembers);
  return json({
    ledger: { slug: ledger.slug, name: ledger.name },
    members: ordered.members,
    groups: ordered.groups,
    expenses: expenses.map((expense) => ({
      ...expense,
      participantIds: participantsByExpense.get(expense.id) || [],
    })),
    payments: [
      ...payments,
      ...adjustments.map((adjustment) => ({
        ...adjustment,
        id: `adjustment-${adjustment.id}`,
        direction: "member_to_admin",
        status: "confirmed",
        confirmedAt: adjustment.createdAt,
        adjustment: true,
      })),
    ].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
    isAdmin: Boolean(adminSession),
    storePasswordVerified: storeAuthorization.length > 0,
    columnWidths: columnWidths ? JSON.parse(columnWidths.valueJson) : DEFAULT_COLUMN_WIDTHS,
    fontSize: fontSize ? Number(fontSize.valueJson) : FONT_SIZE.default,
    qrSize: qrSize ? Number(qrSize.valueJson) : QR_SIZE.default,
  });
}
