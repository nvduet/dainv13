import assert from "node:assert/strict";
import test from "node:test";
import { calculateBalances, parseThousandInput, splitEvenly } from "../public/accounting.mjs";

test("converts thousand-VND input to whole VND with half-up rounding", () => {
  assert.equal(parseThousandInput("671,2380952"), 671238);
  assert.equal(parseThousandInput("671.2385"), 671239);
  assert.equal(parseThousandInput("0.0005"), 1);
});

test("rejects invalid, zero, negative, and excessive amounts", () => {
  for (const input of ["0", "-1", "1,2,3", "text", "1000000001"]) {
    assert.throws(() => parseThousandInput(input));
  }
});

test("distributes indivisible dong in stable participant order", () => {
  const shares = splitEvenly(10, ["first", "second", "third"]);
  assert.deepEqual([...shares.values()], [4, 3, 3]);
  assert.equal([...shares.values()].reduce((sum, amount) => sum + amount, 0), 10);
});

test("rejects invalid or duplicate participants", () => {
  assert.throws(() => splitEvenly(100, []));
  assert.throws(() => splitEvenly(100, ["same", "same"]));
  assert.throws(() => splitEvenly(0, ["member"]));
});

test("calculates balances through the admin and ignores unconfirmed payments", () => {
  const members = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const expenses = [{ payerId: "a", amountVnd: 10, participantIds: ["a", "b", "c"] }];
  const payments = [
    { memberId: "b", direction: "member_to_admin", amountVnd: 2, status: "confirmed" },
    { memberId: "b", direction: "member_to_admin", amountVnd: 1, status: "pending" },
    { memberId: "a", direction: "admin_to_member", amountVnd: 1, status: "confirmed" },
  ];
  const balances = calculateBalances(members, expenses, payments);
  assert.deepEqual(balances.map((member) => member.balanceVnd), [-5, 1, 3]);
  assert.equal(balances.reduce((sum, member) => sum + member.balanceVnd, 0), -1);
});
