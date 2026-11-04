// Làm mới khi quay lại trang: trang bị ẩn (đổi tab, khóa máy) hoặc cửa sổ mất focus từ 30 giây trở lên rồi quay lại
// thì tải dữ liệu một lần. Không hẹn giờ, không hỏi máy chủ định kỳ. Lần hiện/focus đầu tiên sau khi tải trang không
// tính là quay lại (trang chưa từng rời đi). Không phụ thuộc DOM (có kiểm thử node:test).
export const RETURN_AFTER_MS = 30_000;

export function createReturnWatcher({ onReturn, now = () => performance.now(), threshold = RETURN_AFTER_MS }) {
  let awaySince = null;
  return {
    // visibilitychange → hidden, hoặc cửa sổ mất focus: tính từ lần rời đi đầu tiên.
    away() {
      awaySince ??= now();
    },
    // visibilitychange → visible, hoặc cửa sổ có lại focus: true nếu đã gọi onReturn.
    back() {
      if (awaySince === null) return false;
      const elapsed = now() - awaySince;
      awaySince = null;
      if (elapsed < threshold) return false;
      onReturn();
      return true;
    },
  };
}

const sortedBy = (list, key) => [...list].sort((left, right) => String(left[key]).localeCompare(String(right[key])));

// Dữ liệu trang đang hiển thị, để biết lần làm mới có đổi gì không (thứ tự trả về và các trường phụ không tính).
export function ledgerSignature({ ledger, members, groups, expenses, payments, isAdmin, settings }) {
  return JSON.stringify({
    ledger: [ledger?.slug, ledger?.name],
    isAdmin: Boolean(isAdmin),
    members: sortedBy(members, "id").map((member) => [member.id, member.name, member.groupId ?? null, member.position ?? null]),
    groups: sortedBy(groups, "id").map((group) => [group.id, group.name, [...(group.memberIds ?? [])].sort()]),
    expenses: sortedBy(expenses, "id").map((expense) => [
      expense.id,
      expense.payerId || null,
      expense.date || null,
      String(expense.description ?? "").trim(),
      expense.amountVnd,
      [...(expense.participantIds ?? [])].sort(),
    ]),
    payments: sortedBy(payments, "id").map((payment) => [payment.id, payment.memberId, payment.direction, payment.status, payment.amountVnd]),
    settings: settings ?? null,
  });
}
