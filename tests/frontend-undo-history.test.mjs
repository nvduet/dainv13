import assert from "node:assert/strict";
import test from "node:test";
import {
  COALESCE_MS,
  createUndoHistory,
  describeEntry,
  diffSavedExpense,
  DELETE_SETTLE_MS,
  HISTORY_LIMIT,
  planHistoryStep,
  planTransferStep,
  pruneHistory,
  sameValue,
  stacksToStore,
} from "../public/js/undo-history.js";

const transfer = (memberId, before, after, label = "An") => ({ kind: "transfer", memberId, before, after, label });

test("transfer totals: one entry per member, saves within 3 s coalesce keeping the oldest total, back to the start cancels", () => {
  const { history, advance } = setup();
  history.record(transfer("m1", 100_000, 120_000));
  advance(1000);
  history.record(transfer("m1", 120_000, 150_000));
  assert.equal(history.sizes.undo, 1);
  assert.deepEqual([history.peekUndo().before, history.peekUndo().after], [100_000, 150_000]);
  advance(1000);
  history.record(transfer("m1", 150_000, 100_000));
  assert.equal(history.sizes.undo, 0, "edited back to the first total: nothing left to undo");

  history.record(transfer("m1", 0, 50_000));
  history.record(transfer("m2", 0, 70_000, "Bình"));
  assert.equal(history.sizes.undo, 2, "another member is another entry");
  advance(COALESCE_MS + 1);
  history.record(transfer("m2", 70_000, 80_000, "Bình"));
  assert.equal(history.sizes.undo, 3, "after 3 s a new entry");
  history.record(transfer("m3", 5_000, 5_000, "Chi"));
  assert.equal(history.sizes.undo, 3, "an unchanged total is not an entry");

  history.pushRedo(transfer("m1", 1, 2));
  history.record(transfer("m1", 50_000, 60_000));
  assert.equal(history.sizes.redo, 0, "a new change clears redo");
});

test("planTransferStep restores a total only while it is still the one the entry set", () => {
  const entry = transfer("m1", 100_000, 120_000);
  assert.equal(planTransferStep(entry, 120_000, "undo"), 100_000);
  assert.equal(planTransferStep(entry, 100_000, "redo"), 120_000);
  assert.equal(planTransferStep(entry, 130_000, "undo"), null, "changed elsewhere since");
  assert.equal(planTransferStep(entry, 120_000, "redo"), null);
});

test("describeEntry names the member and both totals, reversed after an undo", () => {
  const entry = transfer("m1", 100_000, 120_000, "An cũ");
  assert.equal(describeEntry(entry, { memberName: (id) => names.get(id) }), "Đã chuyển khoản 'An' 100.000đ → 120.000đ");
  assert.equal(describeEntry(entry, { memberName: (id) => names.get(id), inverse: true }), "Đã chuyển khoản 'An' 120.000đ → 100.000đ");
  assert.equal(describeEntry(entry), "Đã chuyển khoản 'An cũ' 100.000đ → 120.000đ", "a deleted member keeps the recorded name");
});

function setup() {
  let now = 1000;
  let changes = 0;
  const history = createUndoHistory({ now: () => now, onChange: () => { changes += 1; } });
  return { history, advance: (ms) => { now += ms; }, changes: () => changes };
}

const edit = (expenseId, fields, { added = [], removed = [], session = null, label = "Ăn trưa" } = {}) => ({
  kind: "edit",
  expenseId,
  fields: Object.fromEntries(Object.entries(fields).map(([field, [before, after]]) => [field, { before, after }])),
  added,
  removed,
  session,
  label,
});

const names = new Map([["m1", "An"], ["m2", "Bình"], ["m3", "Chi"]]);
const memberName = (id) => names.get(id) ?? null;

test("a saved change is undone to its previous value and redone to the new one", () => {
  const { history, changes } = setup();
  assert.equal(history.peekUndo(), null);
  history.record(edit("e1", { amountVnd: [360000, 999000] }));
  assert.equal(changes(), 1);
  const entry = history.takeUndo();
  assert.equal(describeEntry(entry, { memberName }), "Chi phí 'Ăn trưa' 360 → 999");
  const undo = planHistoryStep(entry, { amountVnd: 999000, participantIds: [] }, "undo");
  assert.deepEqual(undo.fields, { amountVnd: 360000 });
  assert.equal(undo.skipped, 0);
  assert.equal(undo.empty, false);
  history.pushRedo(undo.applied);
  assert.equal(history.peekUndo(), null);
  const redoEntry = history.takeRedo();
  const redo = planHistoryStep(redoEntry, { amountVnd: 360000, participantIds: [] }, "redo");
  assert.deepEqual(redo.fields, { amountVnd: 999000 });
  history.pushUndo(redo.applied);
  assert.deepEqual(history.sizes, { undo: 1, redo: 0 });
});

test("saves of the same expense and field within 3 s coalesce into one entry keeping the oldest value", () => {
  const { history, advance } = setup();
  history.record(edit("e1", { amountVnd: [360000, 3000] }));
  advance(1000);
  history.record(edit("e1", { amountVnd: [3000, 36000] }));
  advance(COALESCE_MS);
  history.record(edit("e1", { amountVnd: [36000, 360500] }));
  assert.deepEqual(history.sizes, { undo: 1, redo: 0 });
  assert.deepEqual(history.peekUndo().fields, { amountVnd: { before: 360000, after: 360500 } });
  advance(COALESCE_MS + 1);
  history.record(edit("e1", { amountVnd: [360500, 1000] }));
  assert.equal(history.sizes.undo, 2, "more than 3 s later: a new entry");
});

test("saves made during one focus of a cell coalesce even when they are more than 3 s apart", () => {
  const { history, advance } = setup();
  history.record(edit("e1", { description: ["Ăn", "Ăn tr"] }, { session: 7 }));
  advance(10_000);
  history.record(edit("e1", { description: ["Ăn tr", "Ăn trưa"] }, { session: 7 }));
  assert.equal(history.sizes.undo, 1);
  assert.deepEqual(history.peekUndo().fields.description, { before: "Ăn", after: "Ăn trưa" });
  advance(10_000);
  history.record(edit("e1", { description: ["Ăn trưa", "Ăn tối"] }, { session: 8 }));
  assert.equal(history.sizes.undo, 2, "another focus of the cell: a new entry");
});

test("other fields, other expenses and entries in between do not coalesce", () => {
  const { history } = setup();
  history.record(edit("e1", { amountVnd: [1000, 2000] }));
  history.record(edit("e1", { date: ["2026-10-01", "2026-10-02"] }));
  history.record(edit("e2", { date: ["2026-10-01", "2026-10-02"] }));
  history.record(edit("e1", { date: ["2026-10-02", "2026-10-03"] }));
  assert.equal(history.sizes.undo, 4);
});

test("typing a value back to where it started leaves nothing to undo", () => {
  const { history } = setup();
  history.record(edit("e1", { amountVnd: [360000, 999000] }));
  history.record(edit("e1", { amountVnd: [999000, 360000] }));
  assert.equal(history.peekUndo(), null);
});

test("participant ticks coalesce as add/remove sets; ticking and unticking someone cancels out", () => {
  const { history } = setup();
  history.record(edit("e1", {}, { added: ["m1"] }));
  history.record(edit("e1", {}, { added: ["m2"] }));
  history.record(edit("e1", {}, { removed: ["m3"] }));
  assert.deepEqual([history.peekUndo().added, history.peekUndo().removed], [["m1", "m2"], ["m3"]]);
  history.record(edit("e1", {}, { removed: ["m1"] }));
  history.record(edit("e1", {}, { added: ["m3"] }));
  assert.deepEqual([history.peekUndo().added, history.peekUndo().removed], [["m2"], []]);
  history.record(edit("e1", {}, { removed: ["m2"] }));
  assert.equal(history.peekUndo(), null);
});

test("a new change clears the redo stack; the stack keeps the last 50 entries", () => {
  const { history, advance } = setup();
  history.record(edit("e1", { amountVnd: [1, 2] }));
  history.pushRedo(history.takeUndo());
  assert.equal(history.sizes.redo, 1);
  history.record({ kind: "add", expenseId: "e9", duplicate: false, label: "" });
  assert.equal(history.sizes.redo, 0);
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
    advance(COALESCE_MS + 1);
    history.record(edit(`x${index}`, { amountVnd: [index, index + 1] }));
  }
  assert.equal(history.sizes.undo, HISTORY_LIMIT);
  assert.equal(history.peekUndo().expenseId, `x${HISTORY_LIMIT + 4}`);
});

test("entries of an expense can be removed from both stacks", () => {
  const { history } = setup();
  history.record({ kind: "add", expenseId: "e1", duplicate: false, label: "" });
  history.record(edit("e2", { amountVnd: [1, 2] }));
  history.record({ kind: "delete", expenseId: "e1", label: "Ăn trưa" });
  history.pushRedo(history.takeUndo());
  assert.equal(history.remove((entry) => entry.expenseId === "e1"), 2);
  assert.deepEqual(history.sizes, { undo: 1, redo: 0 });
  assert.equal(history.remove(() => false), 0);
});

test("a field changed again by someone else is skipped; the rest is applied", () => {
  const entry = edit("e1", { amountVnd: [360000, 999000], date: ["2026-10-01", "2026-10-02"] });
  const plan = planHistoryStep(entry, { amountVnd: 500000, date: "2026-10-02", participantIds: [] }, "undo");
  assert.deepEqual(plan.fields, { date: "2026-10-01" });
  assert.equal(plan.skipped, 1);
  assert.deepEqual(Object.keys(plan.applied.fields), ["date"]);
  const blocked = planHistoryStep(entry, { amountVnd: 500000, date: "2026-10-05", participantIds: [] }, "undo");
  assert.equal(blocked.empty, true);
  assert.equal(blocked.skipped, 2);
  const redo = planHistoryStep(entry, { amountVnd: 360000, date: "2026-10-09", participantIds: [] }, "redo");
  assert.deepEqual(redo.fields, { amountVnd: 999000 });
});

test("participant undo removes who was added and adds back who was removed, unless that changed meanwhile", () => {
  const entry = edit("e1", {}, { added: ["m1", "m2"], removed: ["m3"] });
  const members = new Set(["m1", "m2", "m3"]);
  const plan = planHistoryStep(entry, { participantIds: ["m1", "m2"] }, "undo", members);
  assert.deepEqual([plan.add, plan.remove, plan.skipped], [["m3"], ["m1", "m2"], 0]);
  const partly = planHistoryStep(entry, { participantIds: ["m1", "m3"] }, "undo", members);
  assert.deepEqual([partly.add, partly.remove, partly.skipped], [[], ["m1"], 2]);
  const redo = planHistoryStep(entry, { participantIds: ["m3"] }, "redo", members);
  assert.deepEqual([redo.add, redo.remove], [["m1", "m2"], ["m3"]]);
  const gone = planHistoryStep(entry, { participantIds: ["m1", "m2"] }, "undo", new Set(["m1"]));
  assert.deepEqual([gone.add, gone.remove, gone.skipped], [[], ["m1"], 2], "deleted members are skipped");
});

test("an undo never sets a payer who is no longer a member", () => {
  const entry = edit("e1", { payerId: ["m9", "m1"] });
  const plan = planHistoryStep(entry, { payerId: "m1", participantIds: [] }, "undo", new Set(["m1"]));
  assert.equal(plan.empty, true);
  const cleared = planHistoryStep(edit("e1", { payerId: [null, "m1"] }), { payerId: "m1", participantIds: [] }, "undo", new Set(["m1"]));
  assert.deepEqual(cleared.fields, { payerId: null });
});

test("values compare like the table shows them", () => {
  assert.equal(sameValue("description", " Phở ", "Phở"), true);
  assert.equal(sameValue("payerId", "", null), true);
  assert.equal(sameValue("date", null, undefined), true);
  assert.equal(sameValue("amountVnd", 0, null), true);
  assert.equal(sameValue("amountVnd", -90000, 90000), false);
});

test("entries are described in Vietnamese for the buttons and notices", () => {
  const describe = (entry, description) => describeEntry(entry, { description, memberName });
  assert.equal(describe({ kind: "add", expenseId: "e1", duplicate: false }, ""), "Thêm dòng mới");
  assert.equal(describe({ kind: "add", expenseId: "e1", duplicate: false }, "Taxi"), "Thêm dòng 'Taxi'");
  assert.equal(describe({ kind: "add", expenseId: "e1", duplicate: true }, "Taxi"), "Nhân bản 'Taxi'");
  assert.equal(describe({ kind: "add", expenseId: "e1", duplicate: true }, " "), "Nhân bản dòng chưa có nội dung");
  assert.equal(describe({ kind: "delete", expenseId: "e1" }, "Taxi"), "Xóa 'Taxi'");
  assert.equal(describe({ kind: "delete", expenseId: "e1" }, ""), "Xóa dòng chưa có nội dung");
  assert.equal(describe(edit("e1", { amountVnd: [0, 5000] }), ""), "Chi phí (dòng chưa có nội dung) 0 → 5");
  assert.equal(describe(edit("e1", { description: ["Ăn", "Ăn trưa"] }), "Ăn trưa"), "Nội dung 'Ăn' → 'Ăn trưa'");
  assert.equal(describe(edit("e1", { payerId: [null, "m1"] }), "Taxi"), "Người chi 'Taxi' (trống) → An");
  assert.equal(describe(edit("e1", { date: ["2026-10-01", null] }), "Taxi"), "Ngày 'Taxi' 01/10/2026 → (trống)");
  assert.equal(describe(edit("e1", { amountVnd: [-90000, 360500] }), "Taxi"), "Chi phí 'Taxi' -90 → 360.5");
  assert.equal(describe(edit("e1", {}, { added: ["m1"], removed: ["m2"] }), "Taxi"), "Người tham gia 'Taxi' +An, −Bình");
  assert.equal(describe(edit("e1", { payerId: ["m1", "m2"], amountVnd: [1000, 2000] }), "Taxi"), "'Taxi': Người chi An → Bình; Chi phí 1 → 2");
  assert.equal(describe(edit("e1", { amountVnd: [1000, 2000] }), "x".repeat(60)), `Chi phí '${"x".repeat(39)}…' 1 → 2`);
  assert.equal(describe(edit("e1", { payerId: ["m9", null] }), "Taxi"), "Người chi 'Taxi' (thành viên đã xóa) → (trống)");
  assert.equal(describeEntry(edit("e1", { amountVnd: [1000, 2000] }, { label: "Cũ" })), "Chi phí 'Cũ' 1 → 2", "falls back to the recorded label");
});

test("after an undo the notice describes the result: values and ticks the other way round", () => {
  const describe = (entry) => describeEntry(entry, { description: "Taxi", memberName, inverse: true });
  assert.equal(describe(edit("e1", { amountVnd: [100000, 120000] })), "Chi phí 'Taxi' 120 → 100");
  assert.equal(describe(edit("e1", {}, { added: ["m1"], removed: ["m2"] })), "Người tham gia 'Taxi' +Bình, −An");
  assert.equal(describe({ kind: "delete", expenseId: "e1" }), "Xóa 'Taxi'");
});

const write = (fields = {}, toggles = []) => ({ fields: new Map(Object.entries(fields)), toggles: new Map(toggles) });
const saved = (overrides = {}) => ({ payerId: "m1", date: "2026-10-01", description: "Ăn trưa", amountVnd: 360000, participantIds: ["m1", "m2"], ...overrides });

test("a save becomes an edit entry with the fields and ticks the user changed", () => {
  const sent = { fields: { amountVnd: 999000, description: "Ăn trưa " }, toggles: new Map([["m3", true], ["m2", false]]) };
  const after = saved({ amountVnd: 999000, participantIds: ["m1", "m3"] });
  const { change, keys } = diffSavedExpense("e1", saved(), after, sent);
  assert.deepEqual(change.fields, { amountVnd: { before: 360000, after: 999000 } }, "a description only padded is not a change");
  assert.deepEqual([change.added, change.removed], [["m3"], ["m2"]]);
  assert.deepEqual(keys, ["amountVnd", "participants"]);
  assert.equal(change.label, "Ăn trưa");
  // A tick another device had already made is not this user's change.
  const already = diffSavedExpense("e1", saved(), saved(), { fields: {}, toggles: new Map([["m1", true]]) });
  assert.deepEqual([already.change.added, already.keys], [[], []]);
});

test("the values an undo (or a duplicate's fill) wrote are not recorded as a change, and are crossed off the write", () => {
  const pending = write({ amountVnd: 360000, payerId: "m2" }, [["m3", true]]);
  const sent = { fields: { amountVnd: 360000, date: "2026-10-02" }, toggles: new Map([["m3", true]]) };
  const { change, keys } = diffSavedExpense("e1", saved({ amountVnd: 999000 }), saved({ date: "2026-10-02", participantIds: ["m1", "m2", "m3"] }), sent, pending);
  assert.deepEqual(keys, ["date"], "only the user's own date change is recorded");
  assert.deepEqual(change.fields, { date: { before: "2026-10-01", after: "2026-10-02" } });
  assert.deepEqual([...pending.fields], [["payerId", "m2"]], "the payer is still waiting to be saved");
  assert.equal(pending.toggles.size, 0);
  // A value the user typed over the undo is the user's change, not the undo's.
  const other = write({ amountVnd: 360000 });
  const typed = diffSavedExpense("e1", saved({ amountVnd: 999000 }), saved({ amountVnd: 500000 }), { fields: { amountVnd: 500000 }, toggles: new Map() }, other);
  assert.deepEqual(typed.keys, ["amountVnd"]);
  assert.equal(other.fields.size, 1);
});

// ---------- Lịch sử lưu trên thiết bị, dùng chung giữa các tab ----------

const snap = (extra = {}) => ({
  payerId: "m1", date: "2026-10-01", description: "Ăn trưa", amountVnd: 360000, participantIds: ["m1"], position: 1, deleted: true, sentAt: 90,
  confirmed: true, ...extra,
});

function pageHistory(origin, clock = { now: 1000 }) {
  let id = 0;
  return createUndoHistory({ origin, now: () => clock.now, newId: () => `${origin}-${(id += 1)}` });
}

test("entries carry an id, the recording page and time; a step moves them to this page", () => {
  const clock = { now: 1000 };
  const history = pageHistory("A", clock);
  history.record(edit("e1", { amountVnd: [1, 2] }, { session: 3 }));
  const entry = history.peekUndo();
  assert.deepEqual([entry.id, entry.origin, entry.at, entry.time, entry.session], ["A-1", "A", 1000, 1000, 3]);
  const other = pageHistory("B", clock);
  other.replace({ undo: [{ ...history.takeUndo() }], redo: [] });
  clock.now = 5000;
  const moved = other.takeUndo();
  other.pushRedo(moved);
  assert.deepEqual([moved.origin, moved.at, moved.session, moved.time], ["B", 5000, null, 1000], "another page's session means nothing here; time stays for coalescing");
  other.pushUndo({ ...moved });
  assert.deepEqual(other.sizes, { undo: 1, redo: 0 }, "one entry is in one place only (same id)");
});

test("a change never coalesces with an entry another page (another tab, an earlier visit) recorded", () => {
  const history = pageHistory("A");
  history.replace({ undo: [{ ...edit("e1", { amountVnd: [1, 2] }, { session: 7 }), id: "old", origin: "B", time: 1000, at: 1000 }], redo: [] });
  history.record(edit("e1", { amountVnd: [2, 3] }, { session: 7 }));
  assert.equal(history.sizes.undo, 2);
  history.record(edit("e1", { amountVnd: [3, 4] }, { session: 7 }));
  assert.equal(history.sizes.undo, 2, "this page's own entries still coalesce");
  history.replace({ undo: [{ ...transfer("m1", 1, 2), id: "t", session: null, origin: "B", time: 1000, at: 1000 }], redo: [] });
  history.record(transfer("m1", 2, 3));
  assert.equal(history.sizes.undo, 2);
});

test("snapshots are updated in place; replace() and entries() do not count as changes", () => {
  let changes = 0;
  const history = createUndoHistory({ origin: "A", onChange: () => { changes += 1; } });
  history.record({ kind: "delete", expenseId: "e1", label: "", snapshot: snap({ deleted: false, position: null }) });
  history.record({ kind: "add", expenseId: "e9", duplicate: false, label: "" });
  changes = 0;
  const marked = history.update((entry) => entry.kind === "delete", (entry) => {
    entry.snapshot = { ...entry.snapshot, deleted: true, position: 4 };
    return true;
  });
  assert.deepEqual([marked, changes, history.peekUndo().kind], [1, 1, "add"]);
  assert.deepEqual(history.entries().undo[0].snapshot, snap({ position: 4 }));
  history.replace({ undo: [], redo: history.entries().undo });
  assert.deepEqual([history.sizes, changes], [{ undo: 0, redo: 2 }, 1]);
});

test("steps waiting for the server are stored back on the stack they came from", () => {
  const a = edit("e1", { amountVnd: [1, 2] });
  const b = edit("e2", { amountVnd: [1, 2] });
  const stored = stacksToStore({ undo: [a], redo: [] }, [{ entry: b, direction: "undo" }, { entry: transfer("m1", 1, 2), direction: "redo" }]);
  assert.deepEqual([stored.undo.map((entry) => entry.expenseId), stored.redo.length], [["e1", "e2"], 1]);
});

test("pruning keeps what can still be applied to the data the page just loaded", () => {
  const entry = (kind, expenseId, extra = {}) => ({ kind, expenseId, id: `${kind}-${expenseId}-${extra.tag ?? ""}`, origin: "old-page", at: 100, time: 100, label: "", ...extra });
  const undo = [
    entry("edit", "gone", { fields: { amountVnd: { before: 1, after: 2 } }, added: [], removed: [] }),
    entry("edit", "shown", { fields: { amountVnd: { before: 1, after: 2 } }, added: [], removed: [] }),
    entry("edit", "deleted", { fields: { amountVnd: { before: 1, after: 2 } }, added: [], removed: [] }),
    entry("add", "deleted"),
    entry("delete", "deleted", { snapshot: snap() }),
    entry("delete", "came-back", { snapshot: snap() }),
    // DELETE sent (by another tab, or by a page closed meanwhile) but not answered: the row may still be there.
    entry("delete", "sent-recently", { snapshot: snap({ confirmed: false, sentAt: 500 - DELETE_SETTLE_MS + 1 }) }),
    entry("delete", "sent-long-ago", { snapshot: snap({ confirmed: false, sentAt: 500 - DELETE_SETTLE_MS }) }),
    entry("delete", "sent-elsewhere", { snapshot: snap({ confirmed: false, sentAt: 400 }) }),
    entry("delete", "waiting-elsewhere", { snapshot: snap({ deleted: false, position: null, sentAt: null, confirmed: false }) }),
    entry("delete", "restored-here", { origin: "A", snapshot: snap({ deleted: false, position: null }) }),
    entry("delete", "waiting-here", { origin: "A", snapshot: snap({ deleted: false, position: null }) }),
    { kind: "transfer", memberId: "m1", id: "t1", origin: "old-page", at: 100, before: 1, after: 2 },
    { kind: "transfer", memberId: "m9", id: "t9", origin: "old-page", at: 100, before: 1, after: 2 },
    entry("edit", "new-elsewhere", { at: 9999, fields: { date: { before: null, after: "2026-10-01" } }, added: [], removed: [] }),
  ];
  const redo = [
    entry("edit", "undone-add", { fields: { description: { before: "", after: "Taxi" } }, added: [], removed: [] }),
    entry("add", "undone-add", { snapshot: snap() }),
    entry("add", "plain-gone"),
    entry("add", "shown"),
    entry("delete", "shown", { tag: "redo", snapshot: snap({ deleted: false }) }),
    entry("delete", "gone", { tag: "redo", snapshot: snap({ deleted: false }) }),
  ];
  const kept = pruneHistory({ undo, redo }, {
    expenseIds: new Set(["shown", "came-back", "sent-recently", "sent-long-ago", "waiting-elsewhere", "restored-here"]),
    memberIds: new Set(["m1"]),
    deletingIds: new Set(["waiting-here"]),
    origin: "A",
    loadedAt: 500,
  });
  assert.deepEqual(kept.undo.map((item) => item.id), [
    "edit-shown-",
    "edit-deleted-",
    "add-deleted-",
    "delete-deleted-",
    "delete-sent-recently-",
    "delete-sent-elsewhere-",
    "delete-waiting-elsewhere-",
    "delete-waiting-here-",
    "t1",
    "edit-new-elsewhere-",
  ]);
  assert.deepEqual(kept.redo.map((item) => item.id), ["edit-undone-add-", "add-undone-add-", "add-shown-", "delete-shown-redo"]);
  assert.equal(kept.removed, 7, "a confirmed delete whose row is back, and an unanswered one past the settle window, are dropped");
  const history = createUndoHistory({ origin: "A" });
  history.replace({ undo, redo });
  // Nothing shown any more (e.g. a restore point emptied the ledger): only rows that can be re-created and their
  // older entries stay, with what another page recorded after the load.
  assert.equal(history.prune({ expenseIds: new Set(), memberIds: new Set(), loadedAt: 500 }), 10);
  assert.deepEqual(history.entries().undo.map((item) => item.id),
    ["edit-deleted-", "add-deleted-", "delete-deleted-", "delete-came-back-", "delete-sent-recently-", "delete-sent-long-ago-",
      "delete-sent-elsewhere-", "delete-waiting-elsewhere-", "edit-new-elsewhere-"]);
  assert.deepEqual(history.entries().redo.map((item) => item.id), ["edit-undone-add-", "add-undone-add-"]);
});

test("pruning keeps a redo chain an undone add can re-create, rows being re-created and attempted re-creations", () => {
  const entry = (kind, expenseId, extra = {}) => ({ kind, expenseId, id: `${kind}-${expenseId}`, origin: "A", at: 100, time: 100, label: "", ...extra });
  const edit = (expenseId) => entry("edit", expenseId, { fields: { description: { before: "", after: "N" } }, added: [], removed: [] });
  const context = (extra = {}) => ({ expenseIds: new Set(), memberIds: new Set(), origin: "A", loadedAt: 500, ...extra });
  // Undo went back through "delete N" (re-created), "edit N" and "add N" (deleted again): redo is [delete, edit, add].
  const chain = pruneHistory({ undo: [], redo: [entry("delete", "n", { snapshot: snap({ deleted: false }) }), edit("n"), entry("add", "n", { snapshot: snap() })] }, context());
  assert.deepEqual(chain.redo.map((item) => item.kind), ["delete", "edit", "add"]);
  // A row this page is re-creating right now (POST out): its older steps stay although the load does not list it.
  const busy = pruneHistory({ undo: [edit("r"), entry("add", "r")], redo: [] }, context({ recreatingIds: new Set(["r"]) }));
  assert.equal(busy.removed, 0);
  // A re-creation whose POST went out without an answer: kept whether or not the row is back (step() finishes it).
  for (const listed of [true, false]) {
    const attempted = pruneHistory({
      undo: [entry("delete", "x", { snapshot: snap({ attemptedAt: 400 }) })],
      redo: [entry("add", "y", { snapshot: snap({ attemptedAt: 400 }) })],
    }, context({ expenseIds: new Set(listed ? ["x", "y"] : []) }));
    assert.equal(attempted.removed, 0, `row listed: ${listed}`);
  }
});
