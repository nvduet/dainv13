import { MAX_AMOUNT_VND } from "./shared/constants.mjs";

const MAX_AMOUNT = BigInt(MAX_AMOUNT_VND);
const INVALID_AMOUNT = "Nhập chi phí bằng nghìn đồng, có thể là số âm, ví dụ 360 hoặc -165.";
const AMOUNT_OUT_OF_RANGE = "Số tiền sau khi đổi sang đồng phải khác 0 và nằm trong giới hạn cho phép.";
const DIVISION_BY_ZERO = "Không thể chia cho 0.";
// Một số nghìn đồng như hôm nay: chữ số, có thể một dấu phẩy/chấm thập phân với tối đa 9 chữ số sau dấu.
const PLAIN_THOUSAND = /^-?\d+(?:[.,]\d{0,9})?$/;
// Phép tính trong ô Chi phí: giới hạn độ dài và độ lồng để chuỗi dán vào không làm treo trang.
const MAX_EXPRESSION_LENGTH = 500;
const MAX_EXPRESSION_DEPTH = 50;

export function splitEvenly(amountVnd, participantIds) {
  if (!Number.isSafeInteger(amountVnd) || amountVnd === 0) {
    throw new Error("Khoản chi phải là số đồng nguyên khác 0.");
  }
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    throw new Error("Khoản chi cần ít nhất một người tham gia.");
  }
  const uniqueIds = [...new Set(participantIds)];
  if (uniqueIds.length !== participantIds.length) {
    throw new Error("Danh sách người tham gia bị trùng.");
  }
  const each = Math.trunc(amountVnd / uniqueIds.length);
  const remainder = amountVnd - each * uniqueIds.length;
  const remainderSign = Math.sign(remainder);
  return new Map(uniqueIds.map((id, index) => [
    id,
    each + (index < Math.abs(remainder) ? remainderSign : 0),
  ]));
}

// Ô nhập là một số nghìn đồng (không phải phép tính): giữ nguyên cách đọc và thông báo lỗi như trước.
export function isPlainThousandInput(value) {
  return PLAIN_THOUSAND.test(String(value).trim());
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b) [a, b] = [b, a % b];
  return a;
}

function fraction(numerator, denominator) {
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator * sign) || 1n;
  return { numerator: (numerator * sign) / divisor, denominator: (denominator * sign) / divisor };
}

// Phép tính nghìn đồng trong ô Chi phí: + − * / (cũng nhận "−", "×", "÷"), ngoặc, dấu âm/dương đứng trước,
// số thập phân dùng dấu phẩy hoặc chấm. Tính đúng tuyệt đối bằng phân số BigInt (không dùng eval, không sai số
// dấu phẩy động), trả về { numerator, denominator } (mẫu số > 0) theo đơn vị nghìn đồng.
export function evaluateThousandExpression(value) {
  const text = String(value).trim();
  if (text.length === 0 || text.length > MAX_EXPRESSION_LENGTH) throw new Error(INVALID_AMOUNT);
  let index = 0;
  let depth = 0;
  const skipSpaces = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };
  const peek = () => {
    skipSpaces();
    const character = text[index];
    return character === "−" ? "-" : character === "×" ? "*" : character === "÷" ? "/" : character;
  };
  const isDigit = (character) => character >= "0" && character <= "9";
  const nest = (parse) => {
    depth += 1;
    if (depth > MAX_EXPRESSION_DEPTH) throw new Error(INVALID_AMOUNT);
    const result = parse();
    depth -= 1;
    return result;
  };

  function number() {
    const start = index;
    while (isDigit(text[index])) index += 1;
    if (index === start) throw new Error(INVALID_AMOUNT);
    const whole = text.slice(start, index);
    let digits = "";
    if (text[index] === "," || text[index] === ".") {
      index += 1;
      const fractionStart = index;
      while (isDigit(text[index])) index += 1;
      digits = text.slice(fractionStart, index);
      if (digits.length > 9) throw new Error(INVALID_AMOUNT);
    }
    return fraction(BigInt(whole + digits), 10n ** BigInt(digits.length));
  }

  function factor() {
    const character = peek();
    if (character === "+" || character === "-") {
      index += 1;
      const operand = nest(factor);
      return character === "-" ? { ...operand, numerator: -operand.numerator } : operand;
    }
    if (character === "(") {
      index += 1;
      const inner = nest(expression);
      if (peek() !== ")") throw new Error(INVALID_AMOUNT);
      index += 1;
      return inner;
    }
    return number();
  }

  function term() {
    let result = factor();
    for (let operator = peek(); operator === "*" || operator === "/"; operator = peek()) {
      index += 1;
      const right = factor();
      if (operator === "*") {
        result = fraction(result.numerator * right.numerator, result.denominator * right.denominator);
      } else {
        if (right.numerator === 0n) throw new Error(DIVISION_BY_ZERO);
        result = fraction(result.numerator * right.denominator, result.denominator * right.numerator);
      }
    }
    return result;
  }

  function expression() {
    let result = term();
    for (let operator = peek(); operator === "+" || operator === "-"; operator = peek()) {
      index += 1;
      const right = term();
      const sign = operator === "+" ? 1n : -1n;
      result = fraction(
        result.numerator * right.denominator + sign * right.numerator * result.denominator,
        result.denominator * right.denominator,
      );
    }
    return result;
  }

  const result = expression();
  if (peek() !== undefined) throw new Error(INVALID_AMOUNT);
  return result;
}

// allowZero: số làm tròn thành 0 đồng ("0", "-0", "0,0", "0.0004") trả về 0 thay vì báo lỗi.
// Ô cũng nhận phép tính nghìn đồng ("120+45", "300/2"): kết quả được làm tròn và giới hạn đúng như một số gõ tay
// (nhân 1.000, làm tròn nửa lên tới đồng theo trị tuyệt đối).
export function parseThousandInput(value, { allowZero = false } = {}) {
  let negative;
  let amount;
  if (isPlainThousandInput(value)) {
    const normalized = String(value).trim().replace(",", ".");
    negative = normalized.startsWith("-");
    const [whole, fraction = ""] = (negative ? normalized.slice(1) : normalized).split(".");
    amount = BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
    if (fraction.length > 3 && Number(fraction[3]) >= 5) amount += 1n;
  } else {
    const { numerator, denominator } = evaluateThousandExpression(value);
    negative = numerator < 0n;
    const scaled = (negative ? -numerator : numerator) * 1000n;
    amount = scaled / denominator;
    if ((scaled % denominator) * 2n >= denominator) amount += 1n;
  }
  if (amount === 0n && allowZero) return 0;
  if (amount === 0n || amount > MAX_AMOUNT) {
    throw new Error(AMOUNT_OUT_OF_RANGE);
  }
  return Number(negative ? -amount : amount);
}

// Phần chịu của từng người trong một khoản chi: chỉ thành viên còn trong danh sách, đồng dư chia theo thứ tự danh
// sách thành viên. calculateBalances và memberBreakdown dùng chung nên số liệu luôn khớp nhau.
function expenseShares(members, expense) {
  const participantIds = Array.isArray(expense.participantIds) ? expense.participantIds : [];
  const participants = members.filter((member) => participantIds.includes(member.id));
  if (expense.amountVnd === 0 || participants.length === 0) return new Map();
  return splitEvenly(expense.amountVnd, participants.map((member) => member.id));
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
    if (!Number.isSafeInteger(expense.amountVnd)) continue;
    const payer = balances.get(expense.payerId);
    if (payer) payer.paidExpenseVnd += expense.amountVnd;
    for (const [memberId, share] of expenseShares(members, expense)) {
      balances.get(memberId).shareVnd += share;
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

// Chi tiết một thành viên (bấm tên trong Summary): bốn khoản tổng và số dư đúng như calculateBalances, các khoản chi
// người đó trả và/hoặc tham gia (kèm phần chịu của chính họ) và các lần chuyển khoản (thanh toán + điều chỉnh).
// null nếu không còn thành viên này.
export function memberBreakdown(members, expenses, payments, memberId) {
  const member = members.find((item) => item.id === memberId);
  if (!member) return null;
  let shareVnd = 0;
  let paidExpenseVnd = 0;
  let paidToAdminVnd = 0;
  let refundedVnd = 0;
  const rows = [];
  for (const expense of expenses) {
    if (!Number.isSafeInteger(expense.amountVnd)) continue;
    const payer = expense.payerId === memberId;
    const participantIds = Array.isArray(expense.participantIds) ? expense.participantIds : [];
    const participant = participantIds.includes(memberId);
    if (!payer && !participant) continue;
    const shares = expenseShares(members, expense);
    const share = shares.get(memberId) ?? 0;
    if (payer) paidExpenseVnd += expense.amountVnd;
    shareVnd += share;
    rows.push({
      id: expense.id,
      date: expense.date ?? null,
      description: expense.description ?? "",
      amountVnd: expense.amountVnd,
      payer,
      participant,
      participantCount: members.filter((item) => participantIds.includes(item.id)).length,
      shareVnd: share,
    });
  }
  const transfers = [];
  for (const payment of payments) {
    if (payment.status !== "confirmed" || payment.memberId !== memberId) continue;
    if (payment.direction === "member_to_admin") paidToAdminVnd += payment.amountVnd;
    else if (payment.direction === "admin_to_member") refundedVnd += payment.amountVnd;
    else continue;
    transfers.push({
      id: payment.id,
      createdAt: payment.createdAt ?? null,
      direction: payment.direction,
      adjustment: Boolean(payment.adjustment),
      amountVnd: payment.amountVnd,
    });
  }
  return {
    member,
    shareVnd,
    paidExpenseVnd,
    paidToAdminVnd,
    refundedVnd,
    balanceVnd: shareVnd - paidExpenseVnd - paidToAdminVnd + refundedVnd,
    expenses: rows,
    transfers,
  };
}
