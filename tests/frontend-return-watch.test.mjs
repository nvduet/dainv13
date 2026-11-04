import assert from "node:assert/strict";
import test from "node:test";
import { createReturnWatcher, ledgerSignature, RETURN_AFTER_MS } from "../public/js/return-watch.js";

function setup() {
  let now = 0;
  let returns = 0;
  const watcher = createReturnWatcher({ now: () => now, onReturn: () => { returns += 1; } });
  return { watcher, advance: (ms) => { now += ms; }, returns: () => returns };
}

test("the first focus or visibility change after load is not a return", () => {
  const { watcher, advance, returns } = setup();
  advance(10 * 60_000);
  assert.equal(watcher.back(), false);
  assert.equal(watcher.back(), false);
  assert.equal(returns(), 0);
});

test("coming back after 30 s away refreshes once, even when both visibility and focus come back", () => {
  const { watcher, advance, returns } = setup();
  watcher.away();
  advance(RETURN_AFTER_MS);
  assert.equal(watcher.back(), true);
  assert.equal(watcher.back(), false, "the second event of the same return");
  assert.equal(returns(), 1);
});

test("a short absence does not refresh, and the next absence starts again from zero", () => {
  const { watcher, advance, returns } = setup();
  watcher.away();
  advance(RETURN_AFTER_MS - 1);
  assert.equal(watcher.back(), false);
  advance(60_000);
  watcher.away();
  advance(5000);
  watcher.back();
  assert.equal(returns(), 0);
});

test("leaving twice (window blur, then the tab hidden) counts from the first", () => {
  const { watcher, advance, returns } = setup();
  watcher.away();
  advance(20_000);
  watcher.away();
  advance(15_000);
  assert.equal(watcher.back(), true);
  assert.equal(returns(), 1);
});

test("the signature ignores order and padding but sees every data change", () => {
  const base = {
    ledger: { slug: "chill-guys", name: "Chill guys" },
    isAdmin: false,
    members: [{ id: "m1", name: "An", groupId: null, position: 0 }, { id: "m2", name: "Bình", groupId: "g1", position: 1 }],
    groups: [{ id: "g1", name: "Nhà", memberIds: ["m2"] }],
    expenses: [
      { id: "e1", payerId: "m1", date: "2026-10-01", description: "Ăn trưa", amountVnd: 360000, participantIds: ["m1", "m2"] },
      { id: "e2", payerId: null, date: null, description: "", amountVnd: 0, participantIds: [] },
    ],
    payments: [{ id: "p1", memberId: "m1", direction: "member_to_admin", status: "confirmed", amountVnd: 1000 }],
    settings: { fontSize: 90, qrSize: 250 },
  };
  const same = {
    ...base,
    expenses: [{ ...base.expenses[1], payerId: "" }, { ...base.expenses[0], description: "Ăn trưa ", participantIds: ["m2", "m1"] }],
    payments: [...base.payments],
  };
  assert.equal(ledgerSignature(same), ledgerSignature(base));
  const changed = (patch) => ledgerSignature({ ...base, ...patch }) !== ledgerSignature(base);
  assert.ok(changed({ expenses: [{ ...base.expenses[0], amountVnd: 1 }, base.expenses[1]] }));
  assert.ok(changed({ expenses: [base.expenses[0]] }));
  assert.ok(changed({ members: [{ ...base.members[0], name: "An Mới" }, base.members[1]] }));
  assert.ok(changed({ groups: [] }));
  assert.ok(changed({ payments: [] }));
  assert.ok(changed({ isAdmin: true }));
  assert.ok(changed({ settings: { fontSize: 100, qrSize: 250 } }));
  assert.ok(changed({ ledger: { slug: "chill-guys", name: "Khác" } }));
});

test("the signature sees payment status and amount, member group and position, group members and expense dates", () => {
  const base = {
    ledger: { slug: "s", name: "S" },
    isAdmin: false,
    members: [{ id: "m1", name: "An", groupId: null, position: 0 }, { id: "m2", name: "Bình", groupId: "g1", position: 1 }],
    groups: [{ id: "g1", name: "Nhà", memberIds: ["m2"] }],
    expenses: [{ id: "e1", payerId: "m1", date: "2026-10-01", description: "Ăn trưa", amountVnd: 360000, participantIds: ["m1"] }],
    payments: [{ id: "p1", memberId: "m1", direction: "member_to_admin", status: "confirmed", amountVnd: 1000 }],
    settings: null,
  };
  const changed = (patch) => ledgerSignature({ ...base, ...patch }) !== ledgerSignature(base);
  assert.ok(changed({ payments: [{ ...base.payments[0], status: "pending" }] }), "payment status");
  assert.ok(changed({ payments: [{ ...base.payments[0], amountVnd: 2000 }] }), "payment amount");
  assert.ok(changed({ members: [{ ...base.members[0], groupId: "g1" }, base.members[1]] }), "member group");
  assert.ok(changed({ members: [{ ...base.members[0], position: 5 }, base.members[1]] }), "member position");
  assert.ok(changed({ groups: [{ ...base.groups[0], memberIds: ["m1", "m2"] }] }), "group members");
  assert.ok(changed({ expenses: [{ ...base.expenses[0], date: "2026-10-02" }] }), "expense date");
});
