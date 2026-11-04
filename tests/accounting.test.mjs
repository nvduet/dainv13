import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBalances,
  evaluateThousandExpression,
  isPlainThousandInput,
  memberBreakdown,
  parseThousandInput,
  splitEvenly,
} from "../public/accounting.mjs";

test("converts thousand-VND input to whole VND with half-up rounding", () => {
  assert.equal(parseThousandInput("671,2380952"), 671238);
  assert.equal(parseThousandInput("671.2385"), 671239);
  assert.equal(parseThousandInput("0.0005"), 1);
});

test("parses signed amounts and rejects invalid, zero, and excessive amounts", () => {
  assert.equal(parseThousandInput("-165"), -165_000);
  assert.equal(parseThousandInput("-0.0005"), -1);
  for (const input of ["0", "-0.0004", "1,2,3", "text", "1000000001", "-1000000001"]) {
    assert.throws(() => parseThousandInput(input));
  }
});

test("allowZero turns amounts that round to 0 đồng into 0 and still rejects invalid text", () => {
  for (const input of ["0", "-0", "0,0", "0.0004", "-0.0004", " 00 ", "0.000"]) {
    assert.ok(Object.is(parseThousandInput(input, { allowZero: true }), 0), input);
    assert.throws(() => parseThousandInput(input), input);
  }
  assert.equal(parseThousandInput("0.0005", { allowZero: true }), 1);
  assert.equal(parseThousandInput("-165", { allowZero: true }), -165_000);
  for (const input of ["", "abc", "1,2,3", "1000000001"]) {
    assert.throws(() => parseThousandInput(input, { allowZero: true }), input);
  }
});

test("distributes indivisible dong in stable participant order", () => {
  const shares = splitEvenly(10, ["first", "second", "third"]);
  assert.deepEqual([...shares.values()], [4, 3, 3]);
  assert.equal([...shares.values()].reduce((sum, amount) => sum + amount, 0), 10);
});

test("distributes negative expenses evenly with stable participant order", () => {
  const shares = splitEvenly(-10, ["first", "second", "third"]);
  assert.deepEqual([...shares.values()], [-4, -3, -3]);
  assert.equal([...shares.values()].reduce((sum, amount) => sum + amount, 0), -10);
});

test("rejects invalid or duplicate participants", () => {
  assert.throws(() => splitEvenly(100, []));
  assert.throws(() => splitEvenly(100, ["same", "same"]));
  assert.throws(() => splitEvenly(0, ["member"]));
});

test("calculates balances through the admin and ignores unconfirmed payments", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const expenses = [{ payerId: "a", description: "Meal", amountVnd: 10, participantIds: ["a", "b", "c"] }];
  const payments = [
    { memberId: "b", direction: "member_to_admin", amountVnd: 2, status: "confirmed" },
    { memberId: "b", direction: "member_to_admin", amountVnd: 1, status: "pending" },
    { memberId: "a", direction: "admin_to_member", amountVnd: 1, status: "confirmed" },
  ];
  const balances = calculateBalances(members, expenses, payments);
  assert.deepEqual(balances.map((member) => member.balanceVnd), [-5, 1, 3]);
  assert.equal(balances.reduce((sum, member) => sum + member.balanceVnd, 0), -1);
});

test("signed settlement target makes balance zero for positive and negative amounts", () => {
  const members = [
    { id: "member-1", name: "A" },
    { id: "member-2", name: "B" },
    { id: "member-3", name: "C" },
  ];
  const expenses = [{
    id: "expense-1",
    payerId: "member-2",
    description: "Expense 1",
    amountVnd: 30_000,
    participantIds: ["member-1"],
  }, {
    id: "expense-2",
    payerId: "member-1",
    description: "Expense 2",
    amountVnd: 50_000,
    participantIds: ["member-3"],
  }];
  const before = calculateBalances(members, expenses, []);
  const doneAmounts = before.map((member) => ({
    memberId: member.id,
    amountVnd: member.shareVnd - member.paidExpenseVnd,
  }));
  const after = calculateBalances(members, expenses, doneAmounts.map(({ memberId, amountVnd }) => ({
    memberId,
    direction: "member_to_admin",
    amountVnd,
    status: "confirmed",
  })));

  assert.deepEqual(doneAmounts.map(({ amountVnd }) => amountVnd), [-20_000, -30_000, 50_000]);
  assert.deepEqual(after.map((member) => member.balanceVnd), [0, 0, 0]);
});

test("partial expense drafts update payer and participant balances independently", () => {
  const members = [{ id: "member-1" }, { id: "member-2" }, { id: "member-3" }];
  const expenses = [
    { payerId: null, description: "", amountVnd: 0, participantIds: [] },
    { payerId: null, description: "", amountVnd: 100, participantIds: ["member-2", "member-3"] },
    { payerId: "member-1", description: "", amountVnd: 50, participantIds: [] },
  ];
  const balances = calculateBalances(members, expenses, []);
  assert.deepEqual(balances.map(({ shareVnd, paidExpenseVnd, balanceVnd }) => ({
    shareVnd,
    paidExpenseVnd,
    balanceVnd,
  })), [
    { shareVnd: 0, paidExpenseVnd: 50, balanceVnd: -50 },
    { shareVnd: 50, paidExpenseVnd: 0, balanceVnd: 50 },
    { shareVnd: 50, paidExpenseVnd: 0, balanceVnd: 50 },
  ]);
});

test("a missing amount is treated as zero while selected participants remain valid", () => {
  const members = [{ id: "member-1" }, { id: "member-2" }];
  const expenses = [
    { payerId: "member-1", description: "", amountVnd: 0, participantIds: ["member-2"] },
  ];
  assert.deepEqual(
    calculateBalances(members, expenses, []).map(({ shareVnd, paidExpenseVnd, balanceVnd }) => ({
      shareVnd,
      paidExpenseVnd,
      balanceVnd,
    })),
    [
      { shareVnd: 0, paidExpenseVnd: 0, balanceVnd: 0 },
      { shareVnd: 0, paidExpenseVnd: 0, balanceVnd: 0 },
    ],
  );
});

test("negative expenses reduce shares and the payer's net paid amount", () => {
  const members = [{ id: "a" }, { id: "b" }];
  const expenses = [{
    payerId: "a",
    description: "Refund",
    amountVnd: -10,
    participantIds: ["a", "b"],
  }];
  const balances = calculateBalances(members, expenses, []);
  assert.deepEqual(balances.map(({ shareVnd, paidExpenseVnd, balanceVnd }) => ({
    shareVnd,
    paidExpenseVnd,
    balanceVnd,
  })), [
    { shareVnd: -5, paidExpenseVnd: -10, balanceVnd: 5 },
    { shareVnd: -5, paidExpenseVnd: 0, balanceVnd: -5 },
  ]);
});

// ---------- Phase 6: member detail (F6-5) ----------

// Deterministic pseudo-random numbers (mulberry32) so a failing case can be replayed.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLedger(seed) {
  const next = random(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const members = Array.from({ length: 1 + Math.floor(next() * 7) }, (_, index) => ({ id: `m${index}`, name: `M${index}` }));
  // Ids that are not (or no longer) members: a deleted payer or participant is ignored like in calculateBalances.
  const ids = [...members.map((member) => member.id), "gone-1", "gone-2"];
  const amounts = [0, 1, -1, 2, -2, 10, -10, 999, 100_000, -90_000, 360_500, 1_000_000_000_000, -1_000_000_000_000, 1.5, Number.NaN];
  const expenses = Array.from({ length: Math.floor(next() * 12) }, (_, index) => ({
    id: `e${index}`,
    date: next() < 0.8 ? `2026-10-${String(1 + Math.floor(next() * 28)).padStart(2, "0")}` : null,
    description: next() < 0.9 ? `Khoản ${index}` : "",
    payerId: next() < 0.85 ? pick(ids) : null,
    amountVnd: next() < 0.5 ? pick(amounts) : Math.round((next() - 0.3) * 1_000_000),
    participantIds: [...new Set(Array.from({ length: Math.floor(next() * (ids.length + 1)) }, () => pick(ids)))],
  }));
  const payments = Array.from({ length: Math.floor(next() * 6) }, (_, index) => ({
    id: next() < 0.5 ? `p${index}` : `adjustment-${index}`,
    memberId: pick(ids),
    direction: pick(["member_to_admin", "member_to_admin", "admin_to_member", "other"]),
    amountVnd: Math.round((next() - 0.4) * 500_000),
    status: next() < 0.85 ? "confirmed" : "pending",
    createdAt: `2026-10-0${1 + Math.floor(next() * 9)} 10:00:00`,
    adjustment: next() < 0.5,
  }));
  return { members, expenses, payments };
}

test("memberBreakdown totals and balance equal calculateBalances for every member of random ledgers", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const { members, expenses, payments } = randomLedger(seed);
    const balances = calculateBalances(members, expenses, payments);
    for (const balance of balances) {
      const detail = memberBreakdown(members, expenses, payments, balance.id);
      const label = `seed ${seed} member ${balance.id}`;
      for (const field of ["shareVnd", "paidExpenseVnd", "paidToAdminVnd", "refundedVnd", "balanceVnd"]) {
        assert.equal(detail[field], balance[field], `${label} ${field}`);
      }
      // The listed rows add up to the totals they explain.
      assert.equal(detail.expenses.reduce((sum, row) => sum + row.shareVnd, 0), balance.shareVnd, `${label} shares`);
      assert.equal(detail.expenses.filter((row) => row.payer).reduce((sum, row) => sum + row.amountVnd, 0), balance.paidExpenseVnd, `${label} paid`);
      const transfers = (direction) => detail.transfers.filter((row) => row.direction === direction).reduce((sum, row) => sum + row.amountVnd, 0);
      assert.equal(transfers("member_to_admin"), balance.paidToAdminVnd, `${label} transfers`);
      assert.equal(transfers("admin_to_member"), balance.refundedVnd, `${label} refunds`);
      // Every expense that involves the member is listed once, in the ledger's order.
      const involved = expenses.filter((expense) => Number.isSafeInteger(expense.amountVnd) &&
        (expense.payerId === balance.id || expense.participantIds.includes(balance.id)));
      assert.deepEqual(detail.expenses.map((row) => row.id), involved.map((expense) => expense.id), `${label} rows`);
    }
  }
});

test("memberBreakdown gives each member the share calculateBalances allocates (remainder in member order)", () => {
  // Participants listed out of member order: the extra đồng still goes to the earliest members of the list.
  const members = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  const expenses = [
    { id: "x", date: "2026-10-01", description: "Ăn trưa", payerId: "c", amountVnd: 100, participantIds: ["c", "b", "a"] },
    { id: "y", date: null, description: "Hoàn", payerId: "b", amountVnd: -101, participantIds: ["c", "a"] },
    { id: "z", date: null, description: "Không liên quan", payerId: "a", amountVnd: 50, participantIds: ["a", "gone"] },
  ];
  const shareOf = (memberId) => memberBreakdown(members, expenses, [], memberId).expenses.map((row) => [row.id, row.shareVnd]);
  assert.deepEqual(shareOf("a"), [["x", 34], ["y", -51], ["z", 50]]);
  assert.deepEqual(shareOf("b"), [["x", 33], ["y", 0]]);
  assert.deepEqual(shareOf("c"), [["x", 33], ["y", -50]]);
  const c = memberBreakdown(members, expenses, [], "c");
  assert.deepEqual(c.expenses.map(({ id, payer, participant, participantCount, date, description, amountVnd }) =>
    ({ id, payer, participant, participantCount, date, description, amountVnd })), [
    { id: "x", payer: true, participant: true, participantCount: 3, date: "2026-10-01", description: "Ăn trưa", amountVnd: 100 },
    { id: "y", payer: false, participant: true, participantCount: 2, date: null, description: "Hoàn", amountVnd: -101 },
  ]);
  // A payer who is not a participant is listed with a zero share; a deleted participant is not counted.
  const b = memberBreakdown(members, expenses, [], "b");
  assert.deepEqual(b.expenses[1], { id: "y", date: null, description: "Hoàn", amountVnd: -101, payer: true, participant: false, participantCount: 2, shareVnd: 0 });
  assert.equal(memberBreakdown(members, expenses, [], "a").expenses[2].participantCount, 1);
});

test("memberBreakdown lists the confirmed transfers and adjustments of that member only", () => {
  const members = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const payments = [
    { id: "adjustment-2", memberId: "a", direction: "member_to_admin", amountVnd: -20_000, status: "confirmed", createdAt: "2026-10-03 08:00:00", adjustment: true },
    { id: "p1", memberId: "a", direction: "member_to_admin", amountVnd: 120_000, status: "confirmed", createdAt: "2026-10-02 08:00:00" },
    { id: "p2", memberId: "a", direction: "admin_to_member", amountVnd: 5_000, status: "confirmed", createdAt: "2026-10-01 08:00:00" },
    { id: "p3", memberId: "a", direction: "member_to_admin", amountVnd: 999, status: "pending", createdAt: "2026-10-01 07:00:00" },
    { id: "p4", memberId: "b", direction: "member_to_admin", amountVnd: 7_000, status: "confirmed", createdAt: "2026-10-01 06:00:00" },
  ];
  const detail = memberBreakdown(members, [], payments, "a");
  assert.deepEqual(detail.transfers, [
    { id: "adjustment-2", createdAt: "2026-10-03 08:00:00", direction: "member_to_admin", adjustment: true, amountVnd: -20_000 },
    { id: "p1", createdAt: "2026-10-02 08:00:00", direction: "member_to_admin", adjustment: false, amountVnd: 120_000 },
    { id: "p2", createdAt: "2026-10-01 08:00:00", direction: "admin_to_member", adjustment: false, amountVnd: 5_000 },
  ]);
  assert.deepEqual([detail.paidToAdminVnd, detail.refundedVnd, detail.balanceVnd], [100_000, 5_000, -95_000]);
  assert.equal(detail.member.name, "A");
});

test("memberBreakdown returns null for a member that no longer exists", () => {
  assert.equal(memberBreakdown([{ id: "a" }], [], [], "b"), null);
});

// ---------- Phase 6: arithmetic in the Chi phí cell (F6-7) ----------

const INVALID = "Nhập chi phí bằng nghìn đồng, có thể là số âm, ví dụ 360 hoặc -165.";
const OUT_OF_RANGE = "Số tiền sau khi đổi sang đồng phải khác 0 và nằm trong giới hạn cho phép.";
const exact = (text) => {
  const { numerator, denominator } = evaluateThousandExpression(text);
  return `${numerator}/${denominator}`;
};

test("evaluateThousandExpression follows operator precedence, parentheses and unary signs exactly", () => {
  for (const [text, expected] of [
    ["120+45", "165/1"], ["300/2", "150/1"], ["2+3*4", "14/1"], ["(2+3)*4", "20/1"], ["2*3+4*5", "26/1"],
    ["10-4-3", "3/1"], ["100/5/2", "10/1"], ["2*(3+(4-1))/3", "4/1"], ["8/2*4", "16/1"],
    ["-90+10", "-80/1"], ["-(2+3)", "-5/1"], ["3*-2", "-6/1"], ["--5", "5/1"], ["+7", "7/1"], ["5--5", "10/1"],
    ["100/3", "100/3"], ["1/3+1/6", "1/2"], ["-1/4", "-1/4"], ["2/-4", "-1/2"], ["0*-3", "0/1"],
    ["1,5*3", "9/2"], ["1.5*3", "9/2"], ["1,5+1.25", "11/4"], ["0,001/2", "1/2000"], ["360,", "360/1"],
    [" 12 + 3 * ( 4 - 1 ) ", "21/1"], ["120−45", "75/1"], ["6×7", "42/1"], ["9÷4", "9/4"],
  ]) {
    assert.equal(exact(text), expected, text);
  }
});

test("evaluateThousandExpression rejects garbage with the invalid-amount message", () => {
  for (const text of [
    "", "   ", "abc", "1+", "+", "-", "*2", "2*", "(1", "1)", "()", "1 2", "2(3)", "(2)(3)", "1e3", "0x10", ".5", "1,2,3",
    "1.2.3", "1..2", "=1+1", "1+1;", "Infinity", "NaN", "1/", "1//2", "1**2", "１２", "1,0000000001",
    `${"(".repeat(60)}1${")".repeat(60)}`, `1${"+1".repeat(300)}`,
  ]) {
    assert.throws(() => evaluateThousandExpression(text), { message: INVALID }, JSON.stringify(text));
  }
  // Up to 9 decimals and 50 nested levels are fine.
  assert.equal(exact("1,123456789*1"), "1123456789/1000000000");
  assert.equal(exact(`${"(".repeat(49)}1${")".repeat(49)}`), "1/1");
});

test("division by zero is reported, not evaluated", () => {
  for (const text of ["1/0", "1/(2-2)", "5/0,000", "0/0", "3/(1-1)*2"]) {
    assert.throws(() => evaluateThousandExpression(text), { message: "Không thể chia cho 0." }, text);
    assert.throws(() => parseThousandInput(text, { allowZero: true }), { message: "Không thể chia cho 0." }, text);
  }
});

test("parseThousandInput turns an expression into whole đồng with today's half-up rounding and limits", () => {
  for (const [text, expected] of [
    ["120+45", 165_000], ["300/2", 150_000], ["1,5*3", 4_500], ["-90+10", -80_000], ["100/3", 33_333], ["200/3", 66_667],
    ["-200/3", -66_667], ["2,001/2", 1_001], ["-2,001/2", -1_001], ["0,001/2", 1], ["-0,001/2", -1], ["0,0009/2", 0],
    ["1/3000", 0], ["1/1999", 1], ["999999999+1", 1_000_000_000_000], ["-1000000000*1", -1_000_000_000_000],
  ]) {
    if (expected === 0) {
      assert.ok(Object.is(parseThousandInput(text, { allowZero: true }), 0), text);
      assert.throws(() => parseThousandInput(text), { message: OUT_OF_RANGE }, text);
    } else {
      assert.equal(parseThousandInput(text), expected, text);
    }
  }
  for (const text of ["1000000000+0,001", "-1000000000-0,001", "999999999999*999999", "2-2", "0*5"]) {
    assert.throws(() => parseThousandInput(text), { message: OUT_OF_RANGE }, text);
  }
  assert.ok(Object.is(parseThousandInput("2-2", { allowZero: true }), 0));
  assert.ok(Object.is(parseThousandInput("-(0)", { allowZero: true }), 0));
  for (const text of ["abc", "1+", "(", "1 2"]) {
    assert.throws(() => parseThousandInput(text, { allowZero: true }), { message: INVALID }, text);
  }
});

// Copy of parseThousandInput before Phase 6: plain numbers must keep their exact results and error messages.
function previousParseThousandInput(value, { allowZero = false } = {}) {
  const normalized = String(value).trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d{0,9})?$/.test(normalized)) {
    throw new Error("Nhập chi phí bằng nghìn đồng, có thể là số âm, ví dụ 360 hoặc -165.");
  }
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = (negative ? normalized.slice(1) : normalized).split(".");
  let amount = BigInt(whole) * 1000n + BigInt((fraction + "000").slice(0, 3));
  if (fraction.length > 3 && Number(fraction[3]) >= 5) amount += 1n;
  if (amount === 0n && allowZero) return 0;
  if (amount === 0n || amount > BigInt(1_000_000_000_000)) {
    throw new Error("Số tiền sau khi đổi sang đồng phải khác 0 và nằm trong giới hạn cho phép.");
  }
  return Number(negative ? -amount : amount);
}

test("plain numbers parse exactly as before Phase 6 (results and error messages)", () => {
  const next = random(2026);
  const inputs = ["0", "-0", "360", "360,5", "360.5", "360,", "-165", " 75.5 ", "671,2380952", "0.0005", "-0.0005", "0.0004",
    "1000000000", "1000000001", "-1000000000", "00012", "1,123456789", "1,1234567891", "", "-", "1,2,3", "abc", "1.5e3"];
  for (let index = 0; index < 2000; index += 1) {
    const whole = String(Math.floor(next() * 10 ** Math.floor(next() * 13)));
    const decimals = Math.floor(next() * 11);
    const fraction = Array.from({ length: decimals }, () => Math.floor(next() * 10)).join("");
    const separator = next() < 0.5 ? "," : ".";
    inputs.push(`${next() < 0.3 ? "-" : ""}${whole}${decimals || next() < 0.1 ? separator : ""}${fraction}`);
  }
  for (const input of inputs) {
    for (const options of [{}, { allowZero: true }]) {
      let expected;
      let actual;
      try { expected = previousParseThousandInput(input, options); } catch (caught) { expected = caught.message; }
      try { actual = parseThousandInput(input, options); } catch (caught) { actual = caught.message; }
      assert.ok(Object.is(actual, expected), `${JSON.stringify(input)} ${JSON.stringify(options)}: ${actual} vs ${expected}`);
    }
  }
  for (const plain of ["360", "-165", "360,5", " 75.5 ", "360,", "0"]) assert.equal(isPlainThousandInput(plain), true, plain);
  for (const expression of ["120+45", "(360)", "+5", "-", "", "1,2,3", "abc", "1-"]) assert.equal(isPlainThousandInput(expression), false, expression);
});

test("the expression limits are exactly 500 characters and 50 nested levels", () => {
  const sum500 = `1${"+1".repeat(248)}+10`;
  assert.equal(sum500.length, 500);
  assert.equal(exact(sum500), "259/1");
  assert.throws(() => evaluateThousandExpression(`${sum500}0`), { message: INVALID }, "501 characters");
  assert.equal(exact(`${"(".repeat(50)}1${")".repeat(50)}`), "1/1");
  assert.throws(() => evaluateThousandExpression(`${"(".repeat(51)}1${")".repeat(51)}`), { message: INVALID });
  assert.equal(exact(`${"-".repeat(50)}1`), "1/1");
  assert.throws(() => evaluateThousandExpression(`${"-".repeat(51)}1`), { message: INVALID });
});

test("memberBreakdown ignores payments with an unknown direction, like calculateBalances", () => {
  const members = [{ id: "a", name: "An" }];
  const payments = [
    { id: "x", memberId: "a", direction: "sideways", amountVnd: 7_000, status: "confirmed" },
    { id: "p", memberId: "a", direction: "member_to_admin", amountVnd: 1_000, status: "confirmed" },
  ];
  const detail = memberBreakdown(members, [], payments, "a");
  assert.deepEqual(detail.transfers.map((transfer) => transfer.id), ["p"]);
  assert.equal(detail.balanceVnd, calculateBalances(members, [], payments)[0].balanceVnd);
});
