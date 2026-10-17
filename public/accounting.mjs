export function splitEvenly(amountVnd, participantIds) {
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0) {
    throw new Error("Khoản chi phải là số đồng nguyên dương.");
  }
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    throw new Error("Khoản chi cần ít nhất một người tham gia.");
  }
  const uniqueIds = [...new Set(participantIds)];
  if (uniqueIds.length !== participantIds.length) {
    throw new Error("Danh sách người tham gia bị trùng.");
  }
  const each = Math.floor(amountVnd / uniqueIds.length);
  const remainder = amountVnd % uniqueIds.length;
  return new Map(uniqueIds.map((id, index) => [id, each + (index < remainder ? 1 : 0)]));
}

export function parseThousandInput(value) {
  const normalized = String(value).trim().replace(",", ".");
  if (!/^\d+(?:\.\d{0,9})?$/.test(normalized)) {
    throw new Error("Nhập chi phí bằng nghìn đồng, ví dụ 360 hoặc 671,238.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  let amount = BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
  if (fraction.length > 3 && Number(fraction[3]) >= 5) amount += 1n;
  if (amount <= 0n || amount > 1_000_000_000_000n) {
    throw new Error("Số tiền sau khi đổi sang đồng phải lớn hơn 0 và không vượt giới hạn.");
  }
  return Number(amount);
}

export function calculateBalances(members, expenses, payments) {
  const balances = new Map(members.map((member) => [member.id, {
    ...member,
    shareVnd: 0,
    paidExpenseVnd: 0,
    paidToAdminVnd: 0,
    refundedVnd: 0,
  }]));

  for (const expense of expenses) {
    const payer = balances.get(expense.payerId);
    if (payer) payer.paidExpenseVnd += expense.amountVnd;
    const participants = members.filter((member) => expense.participantIds.includes(member.id));
    if (participants.length === 0) continue;
    const shares = splitEvenly(expense.amountVnd, participants.map((member) => member.id));
    for (const participant of participants) {
      const member = balances.get(participant.id);
      if (member) member.shareVnd += shares.get(participant.id) || 0;
    }
  }

  for (const payment of payments) {
    if (payment.status !== "confirmed") continue;
    const member = balances.get(payment.memberId);
    if (!member) continue;
    if (payment.direction === "member_to_admin") member.paidToAdminVnd += payment.amountVnd;
    if (payment.direction === "admin_to_member") member.refundedVnd += payment.amountVnd;
  }

  return [...balances.values()].map((member) => ({
    ...member,
    balanceVnd: member.shareVnd - member.paidExpenseVnd -
      member.paidToAdminVnd + member.refundedVnd,
  }));
}
