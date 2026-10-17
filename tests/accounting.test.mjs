import assert from "node:assert/strict";
import test from "node:test";
import { calculateBalances, parseThousandInput, splitEvenly } from "../public/accounting.mjs";

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
