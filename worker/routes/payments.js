import { error, json, readJson } from "../http.js";
import { validId, validSignedAmount } from "../validation.js";

// Adds the difference between the new total ?2 and member ?1's current paid-to-Admin total
// (confirmed member_to_admin payments plus every adjustment) as adjustment ?3. MATERIALIZED computes
// that total once; otherwise SQLite copies its sub-queries into every use of `total`.
const INSERT_ADJUSTMENT_SQL = `
  WITH paid AS MATERIALIZED (
    SELECT (SELECT COALESCE(SUM(amount_vnd), 0) FROM payments
            WHERE member_id = ?1 AND direction = 'member_to_admin' AND status = 'confirmed')
         + (SELECT COALESCE(SUM(amount_delta_vnd), 0) FROM payment_adjustments WHERE member_id = ?1) AS total
  )
  INSERT INTO payment_adjustments (id, member_id, amount_delta_vnd, created_by)
  SELECT ?3, ?1, CAST(?2 AS INTEGER) - total, 'admin' FROM paid
  WHERE CAST(?2 AS INTEGER) - total <> 0
  RETURNING id, amount_delta_vnd AS adjustmentVnd, created_at AS createdAt
`;

// Audits adjustment ?3 when it was inserted: the previous total is ?2 minus its delta. Integer
// arithmetic keeps the JSON identical to JSON.stringify (300000, not 300000.0).
const AUDIT_ADJUSTMENT_SQL = `
  INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
  SELECT ?4, 'reconcile', 'payment_total', ?1,
         json_object('memberId', ?1, 'paidToAdminVnd', CAST(?2 AS INTEGER) - amount_delta_vnd),
         json_object('memberId', ?1, 'paidToAdminVnd', CAST(?2 AS INTEGER), 'adjustmentVnd', amount_delta_vnd)
  FROM payment_adjustments WHERE id = ?3
`;

// One batch reads the total and writes both rows, so concurrent saves of the same total add one adjustment.
export async function reconcilePaymentTotal({ request, db, auditActor }) {
  const body = await readJson(request);
  if (!validId(body.memberId) || !validSignedAmount(body.amountVnd)) {
    return error("Chọn thành viên và nhập tổng tiền chuyển khoản hợp lệ.");
  }
  const member = await db.prepare("SELECT id, name FROM members WHERE id = ?")
    .bind(body.memberId).first();
  if (!member) return error("Thành viên không tồn tại.", 404);
  const adjustmentId = crypto.randomUUID();
  const [inserted] = await db.batch([
    db.prepare(INSERT_ADJUSTMENT_SQL).bind(body.memberId, body.amountVnd, adjustmentId),
    db.prepare(AUDIT_ADJUSTMENT_SQL).bind(body.memberId, body.amountVnd, adjustmentId, auditActor),
  ]);
  const [row] = inserted.results;
  if (!row) return json({ amountVnd: body.amountVnd, changed: false });
  const adjustmentVnd = Number(row.adjustmentVnd);
  return json({
    amountVnd: body.amountVnd,
    adjustmentVnd,
    adjustment: {
      id: `adjustment-${row.id}`,
      memberId: body.memberId,
      direction: "member_to_admin",
      amountVnd: adjustmentVnd,
      status: "confirmed",
      createdAt: row.createdAt,
      confirmedAt: row.createdAt,
      adjustment: true,
    },
  });
}
