import assert from "node:assert/strict";
import test from "node:test";
import { calculateBalances } from "../public/accounting.mjs";
import { buildSummaryDiff, cellKey, summarizeSnapshot, transfersFromPayments } from "../public/js/summary-diff.js";

const members = [
  { id: "a", name: "An", position: 0, groupId: "g1" },
  { id: "b", name: "Bình", position: 1, groupId: "g1" },
  { id: "c", name: "Chi", position: 2, groupId: null },
];
const groups = [{ id: "g1", name: "Nhà Vải", position: 0, memberIds: ["a", "b"] }];
const lunch = { id: "e1", payerId: "a", description: "Ăn trưa", amountVnd: 90_000, date: "2026-10-01", position: 0, participantIds: ["a", "b", "c"] };
const snapshot = (overrides = {}) => ({ members, groups, expenses: [lunch], transfers: [], ...overrides });

test("a snapshot's Summary equals calculateBalances with the same totals, and groups form one segment", () => {
  const transfers = [{ memberId: "b", paidToAdminVnd: 30_000, refundedVnd: 0 }, { memberId: "c", paidToAdminVnd: 0, refundedVnd: 5_000 }];
  const summary = summarizeSnapshot(snapshot(), transfers);
  const expected = calculateBalances(members, [lunch], [
    { memberId: "b", direction: "member_to_admin", amountVnd: 30_000, status: "confirmed" },
    { memberId: "c", direction: "admin_to_member", amountVnd: 5_000, status: "confirmed" },
  ]);
  assert.deepEqual(summary.members, expected);
  assert.deepEqual(summary.segments.map((segment) => [segment.key, segment.members.map((member) => member.id), segment.balanceVnd]), [
    ["group:g1", ["a", "b"], (30_000 - 90_000) + (30_000 - 30_000)],
    ["member:c", ["c"], 30_000 + 5_000],
  ]);
});

test("transfersFromPayments sums confirmed payments and adjustments per member like the worker", () => {
  assert.deepEqual(transfersFromPayments([
    { memberId: "a", direction: "member_to_admin", amountVnd: 10_000, status: "confirmed" },
    { memberId: "a", direction: "member_to_admin", amountVnd: -4_000, status: "confirmed", adjustment: true },
    { memberId: "a", direction: "admin_to_member", amountVnd: 2_000, status: "confirmed" },
    { memberId: "b", direction: "member_to_admin", amountVnd: 99_000, status: "pending" },
  ]), [{ memberId: "a", paidToAdminVnd: 6_000, refundedVnd: 2_000 }]);
});

test("a transfer change marks the transfer, balance and group cells on both sides and nothing else", () => {
  const diff = buildSummaryDiff({
    before: snapshot(),
    after: snapshot({ transfers: [{ memberId: "b", paidToAdminVnd: 30_000, refundedVnd: 0 }] }),
  });
  assert.deepEqual([...diff.changes.after.keys()].sort(), [cellKey("balanceVnd", "b"), cellKey("paidToAdminVnd", "b"), "segment:group:g1"].sort());
  assert.deepEqual([...diff.changes.before.keys()].sort(), [...diff.changes.after.keys()].sort());
  assert.equal(diff.changes.after.get(cellKey("paidToAdminVnd", "b")), "modified");
  assert.deepEqual(diff.rows.map((row) => row.label), ["Tiền phải chịu", "Đã chi", "Đã chuyển khoản", "Số dư"], "no refund: the optional row is hidden");
  assert.equal(diff.note, "");
});

test("an expense edit changes shares and balances; added and deleted members are marked as columns", () => {
  const dang = { id: "d", name: "Đăng", position: 3, groupId: null };
  const diff = buildSummaryDiff({
    before: snapshot(),
    after: snapshot({
      members: [...members.filter((member) => member.id !== "c"), dang],
      expenses: [{ ...lunch, amountVnd: 120_000, participantIds: ["a", "b", "d"] }],
    }),
  });
  assert.equal(diff.changes.before.get("member:c"), "deleted");
  assert.equal(diff.changes.after.get("member:d"), "added");
  assert.equal(diff.changes.after.get(cellKey("shareVnd", "a")), "modified");
  assert.equal(diff.changes.after.get(cellKey("paidExpenseVnd", "a")), "modified");
  assert.equal(diff.changes.after.get("segment:member:d"), "added");
  assert.equal(diff.changes.before.get("segment:member:c"), "deleted");
});

test("the refund row appears when any member has a refund; old snapshots without transfers borrow the other side's", () => {
  const withRefund = buildSummaryDiff({ before: snapshot({ transfers: [{ memberId: "c", paidToAdminVnd: 0, refundedVnd: 5_000 }] }), after: snapshot({ transfers: [{ memberId: "c", paidToAdminVnd: 0, refundedVnd: 5_000 }] }) });
  assert.ok(withRefund.rows.some((row) => row.label === "Admin đã hoàn"));
  assert.equal(withRefund.changes.after.size, 0);

  const { transfers, ...legacy } = snapshot();
  const oneSide = buildSummaryDiff({ before: legacy, after: snapshot({ transfers: [{ memberId: "b", paidToAdminVnd: 30_000, refundedVnd: 0 }] }) });
  assert.equal(oneSide.changes.after.size, 0, "the missing side uses the other side's totals, so transfers do not look changed");
  assert.match(oneSide.note, /trước khi nhật ký lưu chuyển khoản/);

  const live = [{ memberId: "a", direction: "member_to_admin", amountVnd: 7_000, status: "confirmed" }];
  const neither = buildSummaryDiff({ before: legacy, after: { ...legacy, expenses: [] } }, live);
  assert.equal(neither.before.members.find((member) => member.id === "a").paidToAdminVnd, 7_000, "current totals on both sides");
  assert.equal(neither.after.members.find((member) => member.id === "a").paidToAdminVnd, 7_000);
  assert.match(neither.note, /tổng chuyển khoản hiện tại/);
  assert.equal(transfers.length, 0);
});
