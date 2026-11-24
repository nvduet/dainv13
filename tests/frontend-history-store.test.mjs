import assert from "node:assert/strict";
import test from "node:test";
import {
  browserStorage,
  forgetStoredHistory,
  historyStorageKey,
  parseStoredHistory,
  readStoredHistory,
  serializeHistory,
  STORED_HISTORY_LIMIT,
  writeStoredHistory,
} from "../public/js/history-store.js";

// Bộ nhớ giả như localStorage; quota: số ký tự tối đa của một giá trị (vượt thì QuotaExceededError).
function fakeStorage({ quota = Infinity, blocked = false } = {}) {
  const items = new Map();
  const refuse = (name) => Object.assign(new Error(name), { name });
  return {
    items,
    getItem(key) {
      if (blocked) throw refuse("SecurityError");
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      if (blocked) throw refuse("SecurityError");
      if (String(value).length > quota) throw refuse("QuotaExceededError");
      items.set(key, String(value));
    },
    removeItem(key) {
      if (blocked) throw refuse("SecurityError");
      items.delete(key);
    },
  };
}

const base = (id, extra = {}) => ({ id, label: "Ăn trưa", time: 1000, session: 4, origin: "page-a", at: 1000, ...extra });
const edit = (id, extra = {}) => base(id, {
  kind: "edit",
  expenseId: "e1",
  fields: { amountVnd: { before: 360000, after: 999000 }, date: { before: null, after: "2026-10-01" } },
  added: ["m1"],
  removed: [],
  ...extra,
});
const snapshot = (extra = {}) => ({
  payerId: "m1",
  date: "2026-10-01",
  description: "Ăn trưa",
  amountVnd: 360000,
  participantIds: ["m1", "m2"],
  position: 3,
  deleted: true,
  sentAt: 1500,
  confirmed: true,
  ...extra,
});
const sample = () => ({
  undo: [
    edit("h1"),
    base("h2", { kind: "add", expenseId: "e5", duplicate: true, label: "" }),
    base("h3", { kind: "delete", expenseId: "e4", snapshot: snapshot() }),
    base("h4", { kind: "transfer", memberId: "m1", before: 100000, after: -20000, label: "An" }),
  ],
  redo: [base("h5", { kind: "add", expenseId: "e6", duplicate: false, label: "", snapshot: snapshot({ position: null, sentAt: 1800, confirmed: false }) })],
});

test("the key is per ledger, like the stored sort", () => {
  assert.equal(historyStorageKey("chill-guys"), "so-chi:hoan-tac:chill-guys");
  assert.equal(historyStorageKey("da-lat-2026"), "so-chi:hoan-tac:da-lat-2026");
});

test("a history round-trips through storage; the page-local session does not", () => {
  const storage = fakeStorage();
  const history = sample();
  assert.equal(writeStoredHistory(storage, "chill-guys", history, { ledger: "default" }), true);
  const stored = JSON.parse(storage.items.get("so-chi:hoan-tac:chill-guys"));
  assert.deepEqual([stored.v, stored.ledger, stored.undo.length], [1, "default", 4]);
  const read = readStoredHistory(storage, "chill-guys", { ledger: "default" });
  const withoutSession = (entry) => ({ ...entry, session: null });
  assert.deepEqual(read, { undo: history.undo.map(withoutSession), redo: history.redo.map(withoutSession) });
  assert.deepEqual(readStoredHistory(storage, "other", { ledger: "default" }), { undo: [], redo: [] }, "another ledger has its own (empty) history");
  writeStoredHistory(storage, "chill-guys", { undo: [], redo: [] }, { ledger: "default" });
  assert.equal(storage.items.has("so-chi:hoan-tac:chill-guys"), false, "an empty history removes the key");
  writeStoredHistory(storage, "chill-guys", history, { ledger: "default" });
  forgetStoredHistory(storage, "chill-guys");
  assert.equal(storage.items.size, 0);
});

test("a history written for another ledger with the same slug (deleted, re-created) reads as empty and is dropped", () => {
  const storage = fakeStorage();
  const oldLedger = "a".repeat(32);
  const newLedger = "b".repeat(32);
  writeStoredHistory(storage, "da-lat", sample(), { ledger: oldLedger });
  const text = storage.items.get("so-chi:hoan-tac:da-lat");
  assert.deepEqual(parseStoredHistory(text, { ledger: newLedger }), { undo: [], redo: [], foreign: true });
  assert.equal(parseStoredHistory(text, { ledger: oldLedger }).undo.length, 4);
  assert.deepEqual(readStoredHistory(storage, "da-lat", { ledger: newLedger }), { undo: [], redo: [] });
  assert.equal(storage.items.has("so-chi:hoan-tac:da-lat"), false, "the old ledger's history is removed");
  // No ledger recorded (or a wrong type): not this ledger's history either.
  for (const ledger of [undefined, null, 7]) {
    storage.items.set("so-chi:hoan-tac:da-lat", JSON.stringify({ v: 1, ledger, undo: sample().undo, redo: [] }));
    assert.deepEqual(readStoredHistory(storage, "da-lat", { ledger: newLedger }), { undo: [], redo: [] }, String(ledger));
    assert.equal(storage.items.size, 0);
  }
});

test("malformed or unknown entries are dropped one by one; a wrong version or broken JSON reads as empty", () => {
  const good = sample().undo;
  const bad = [
    null,
    "edit",
    { ...edit("x1"), kind: "rename" },
    { ...edit("x2"), id: undefined },
    { ...edit("x3"), time: "now" },
    { ...edit("x4"), expenseId: "" },
    { ...edit("x5"), fields: { amountVnd: { before: 1.5, after: 2 } } },
    { ...edit("x6"), fields: { colour: { before: "a", after: "b" } } },
    { ...edit("x7"), fields: { constructor: { before: 1, after: 2 } } },
    { ...edit("x8"), fields: { date: { before: "01/10/2026", after: null } } },
    { ...edit("x9"), fields: {}, added: [], removed: [] },
    { ...edit("x10"), added: ["m1", "m1"] },
    { ...edit("x11"), fields: { description: { before: "x".repeat(201), after: "" } } },
    base("x12", { kind: "delete", expenseId: "e4" }),
    base("x13", { kind: "delete", expenseId: "e4", snapshot: snapshot({ position: -1 }) }),
    base("x14", { kind: "delete", expenseId: "e4", snapshot: snapshot({ amountVnd: 2_000_000_000_000 }) }),
    base("x15", { kind: "add", expenseId: "e4", snapshot: snapshot({ deleted: "yes" }) }),
    base("x15b", { kind: "delete", expenseId: "e4", snapshot: snapshot({ sentAt: "now" }) }),
    base("x15c", { kind: "delete", expenseId: "e4", snapshot: snapshot({ confirmed: 1 }) }),
    base("x16", { kind: "transfer", memberId: "m1", before: 5, after: 5 }),
    base("x17", { kind: "transfer", memberId: "m1", before: 5, after: Number.MAX_SAFE_INTEGER }),
    { ...edit("h1"), label: "trùng id" },
  ];
  const text = JSON.stringify({ v: 1, undo: [...good, ...bad], redo: "not a list" });
  const read = parseStoredHistory(text);
  assert.deepEqual(read.undo.map((entry) => entry.id), ["h1", "h2", "h3", "h4"]);
  assert.deepEqual(read.redo, []);
  assert.equal(read.undo[0].label, "Ăn trưa", "a repeated id keeps the first entry");
  const loose = parseStoredHistory(JSON.stringify({ v: 1, undo: [{ ...edit("y1"), label: 7, origin: 3, at: "x", session: 9 }] })).undo[0];
  assert.deepEqual([loose.label, loose.origin, loose.at, loose.session], ["", "", 1000, null], "optional fields fall back");
  const bare = parseStoredHistory(JSON.stringify({ v: 1, undo: [base("z1", { kind: "delete", expenseId: "e4", snapshot: { description: "Kem", nextId: "e9" } })] })).undo[0];
  assert.deepEqual(bare.snapshot, {
    payerId: null, date: null, description: "Kem", amountVnd: 0, participantIds: [], position: null, deleted: false, sentAt: null, confirmed: false,
  }, "snapshot fields fall back; unknown ones are dropped");
  for (const text of ["{oops", "null", "[]", JSON.stringify({ v: 2, undo: good }), JSON.stringify({ undo: good })]) {
    assert.deepEqual(parseStoredHistory(text), { undo: [], redo: [] }, text);
  }
});

test("each stack keeps at most the 50 newest entries, on write and on read", () => {
  const many = Array.from({ length: 60 }, (_, index) => edit(`h${index}`));
  const storage = fakeStorage();
  writeStoredHistory(storage, "s", { undo: many, redo: many.map((entry) => ({ ...entry, id: `r${entry.id}` })) });
  const stored = JSON.parse(storage.items.get("so-chi:hoan-tac:s"));
  assert.equal(STORED_HISTORY_LIMIT, 50);
  assert.deepEqual([stored.undo.length, stored.redo.length], [50, 50]);
  assert.equal(stored.undo[0].id, "h10", "the oldest go first");
  const read = parseStoredHistory(JSON.stringify({ v: 1, undo: many, redo: [] }));
  assert.deepEqual([read.undo.length, read.undo.at(-1).id], [50, "h59"]);
  assert.equal(serializeHistory({ undo: many, redo: [] }).length < JSON.stringify(many).length, true);
});

test("a full storage keeps the newer half after one retry; still full means memory only, never an error", () => {
  const entries = Array.from({ length: 40 }, (_, index) => edit(`h${index}`));
  const full = JSON.stringify({ v: 1, undo: entries, redo: [] }).length;
  const half = fakeStorage({ quota: full - 1 });
  assert.equal(writeStoredHistory(half, "s", { undo: entries, redo: [] }), true);
  const kept = JSON.parse(half.items.get("so-chi:hoan-tac:s")).undo;
  assert.deepEqual([kept.length, kept[0].id, kept.at(-1).id], [25, "h15", "h39"]);
  const tiny = fakeStorage({ quota: 10 });
  assert.equal(writeStoredHistory(tiny, "s", { undo: entries, redo: [] }), false);
  assert.equal(tiny.items.size, 0);
});

test("blocked storage (private mode, site data off) reads as unavailable and writes nothing, without throwing", () => {
  const blocked = fakeStorage({ blocked: true });
  assert.equal(readStoredHistory(blocked, "s"), null);
  assert.equal(writeStoredHistory(blocked, "s", sample()), false);
  assert.doesNotThrow(() => forgetStoredHistory(blocked, "s"));
  assert.equal(readStoredHistory(null, "s"), null);
  assert.equal(writeStoredHistory(null, "s", sample()), false);
  assert.doesNotThrow(() => forgetStoredHistory(null, "s"));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
  try {
    assert.equal(browserStorage(), null);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("an attempted re-creation (attemptedAt) survives storage; bad values and positions past the cap are dropped", () => {
  const storage = fakeStorage();
  writeStoredHistory(storage, "chill-guys", { undo: [base("a1", { kind: "delete", expenseId: "e4", snapshot: snapshot({ attemptedAt: 2000 }) })], redo: [] }, { ledger: "default" });
  assert.equal(readStoredHistory(storage, "chill-guys", { ledger: "default" }).undo[0].snapshot.attemptedAt, 2000);
  const read = parseStoredHistory(JSON.stringify({ v: 1, ledger: "default", undo: [
    base("a2", { kind: "delete", expenseId: "e4", snapshot: snapshot({ attemptedAt: "soon" }) }),
    base("a3", { kind: "delete", expenseId: "e4", snapshot: snapshot({ position: 1_000_000_001 }) }),
    base("a4", { kind: "delete", expenseId: "e4", snapshot: snapshot() }),
  ], redo: [] }), { ledger: "default" });
  assert.deepEqual(read.undo.map((entry) => entry.id), ["a4"]);
  assert.equal(Object.hasOwn(read.undo[0].snapshot, "attemptedAt"), false);
});
