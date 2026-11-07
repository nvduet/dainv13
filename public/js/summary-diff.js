// Bảng Summary trong diff phiên nhật ký (admin.js): dựng lại Summary trước và sau phiên từ ảnh chụp của phiên (thành
// viên theo nhóm, khoản chi, tổng chuyển khoản từng người) bằng đúng calculateBalances, rồi đánh dấu ô đổi. Ảnh chụp
// ghi trước khi phiên lưu chuyển khoản không có "transfers": dùng tổng của phía còn lại, hoặc số hiện tại, và ghi chú.
import { calculateBalances } from "../accounting.mjs";

export const SUMMARY_DIFF_ROWS = Object.freeze([
  { key: "shareVnd", label: "Tiền phải chịu" },
  { key: "paidExpenseVnd", label: "Đã chi" },
  { key: "paidToAdminVnd", label: "Đã chuyển khoản" },
  // Chỉ hiện khi có khoản Admin hoàn (dữ liệu cũ); Số dư đã tính nó.
  { key: "refundedVnd", label: "Admin đã hoàn", optional: true },
  { key: "balanceVnd", label: "Số dư", balance: true },
]);

// Tổng từng người (như TRANSFERS_SQL của worker) từ danh sách thanh toán của trang (state.payments).
export function transfersFromPayments(payments) {
  const totals = new Map();
  for (const payment of payments) {
    if (payment.status !== "confirmed") continue;
    const total = totals.get(payment.memberId) || { memberId: payment.memberId, paidToAdminVnd: 0, refundedVnd: 0 };
    if (payment.direction === "member_to_admin") total.paidToAdminVnd += payment.amountVnd;
    if (payment.direction === "admin_to_member") total.refundedVnd += payment.amountVnd;
    totals.set(payment.memberId, total);
  }
  return [...totals.values()];
}

function transferPayments(transfers) {
  return transfers.flatMap(({ memberId, paidToAdminVnd = 0, refundedVnd = 0 }) => [
    { memberId, direction: "member_to_admin", amountVnd: paidToAdminVnd, status: "confirmed" },
    { memberId, direction: "admin_to_member", amountVnd: refundedVnd, status: "confirmed" },
  ]);
}

// Số dư từng người và các đoạn "Số dư nhóm" (thành viên cùng nhóm đứng liền nhau, như bảng Summary của trang).
export function summarizeSnapshot(snapshot, transfers) {
  const members = calculateBalances(snapshot.members || [], snapshot.expenses || [], transferPayments(transfers));
  const groupsById = new Map((snapshot.groups || []).map((group) => [group.id, group]));
  const segments = [];
  for (const member of members) {
    const group = member.groupId ? groupsById.get(member.groupId) : null;
    const last = segments.at(-1);
    if (group && last?.group?.id === group.id) last.members.push(member);
    else segments.push({ key: group ? `group:${group.id}` : `member:${member.id}`, group: group || null, members: [member] });
  }
  for (const segment of segments) {
    segment.balanceVnd = segment.members.reduce((total, member) => total + member.balanceVnd, 0);
  }
  return { members, segments };
}

export const cellKey = (rowKey, memberId) => `${rowKey}:${memberId}`;

// session: { before, after } của GET /api/admin/audit/:id; livePayments: state.payments (chỉ dùng khi cả hai ảnh chụp
// thiếu chuyển khoản). Trả về hai bảng, các hàng cần hiện, dấu đổi của ô, cột thành viên và đoạn nhóm, và ghi chú.
export function buildSummaryDiff(session, livePayments = []) {
  const hasBefore = Array.isArray(session.before?.transfers);
  const hasAfter = Array.isArray(session.after?.transfers);
  const fallback = hasAfter ? session.after.transfers
    : hasBefore ? session.before.transfers
    : transfersFromPayments(livePayments);
  const before = summarizeSnapshot(session.before || {}, hasBefore ? session.before.transfers : fallback);
  const after = summarizeSnapshot(session.after || {}, hasAfter ? session.after.transfers : fallback);
  const showRefunded = [...before.members, ...after.members].some((member) => member.refundedVnd !== 0);
  const rows = SUMMARY_DIFF_ROWS.filter((row) => !row.optional || showRefunded);

  const changes = { before: new Map(), after: new Map() };
  const beforeById = new Map(before.members.map((member) => [member.id, member]));
  const afterById = new Map(after.members.map((member) => [member.id, member]));
  for (const [id, member] of beforeById) {
    const other = afterById.get(id);
    if (!other) {
      changes.before.set(`member:${id}`, "deleted");
      continue;
    }
    if (member.name !== other.name) {
      changes.before.set(`member:${id}`, "modified");
      changes.after.set(`member:${id}`, "modified");
    }
    for (const row of rows) {
      if (member[row.key] !== other[row.key]) {
        changes.before.set(cellKey(row.key, id), "modified");
        changes.after.set(cellKey(row.key, id), "modified");
      }
    }
  }
  for (const id of afterById.keys()) {
    if (!beforeById.has(id)) changes.after.set(`member:${id}`, "added");
  }
  const segmentSignature = (segment) => JSON.stringify([segment.group?.name ?? null, segment.members.map((member) => member.id), segment.balanceVnd]);
  const beforeSegments = new Map(before.segments.map((segment) => [segment.key, segment]));
  const afterSegments = new Map(after.segments.map((segment) => [segment.key, segment]));
  for (const [key, segment] of beforeSegments) {
    const other = afterSegments.get(key);
    if (!other) changes.before.set(`segment:${key}`, "deleted");
    else if (segmentSignature(segment) !== segmentSignature(other)) {
      changes.before.set(`segment:${key}`, "modified");
      changes.after.set(`segment:${key}`, "modified");
    }
  }
  for (const key of afterSegments.keys()) {
    if (!beforeSegments.has(key)) changes.after.set(`segment:${key}`, "added");
  }

  const note = hasBefore && hasAfter ? ""
    : hasBefore || hasAfter ? "Một bên ảnh chụp được ghi trước khi nhật ký lưu chuyển khoản: hai bên dùng chung tổng chuyển khoản của bên còn lại."
    : "Phiên này được ghi trước khi nhật ký lưu chuyển khoản: hai bên dùng tổng chuyển khoản hiện tại, nên chỉ thấy thay đổi do khoản chi.";
  return { before, after, rows, changes, note };
}
