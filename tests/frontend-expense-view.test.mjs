import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeExpenseView,
  DEFAULT_SORT,
  EMPTY_FILTER,
  hasActiveFilter,
  isDefaultView,
  isIncompleteExpense,
  isSortKey,
  matchesFilter,
  normalizeSearchText,
  panelBadgeCount,
  panelFilterCount,
  searchTokens,
  SORTS,
  viewSummary,
} from "../public/js/expense-view.js";

const complete = { payerId: "a", date: "2026-10-01", description: "Ăn trưa", amountVnd: 360_000, participantIds: ["a", "b"] };
const filter = (changes) => ({ ...EMPTY_FILTER, ...changes });
const ITEMS = [
  { id: "e0", position: 0, payerId: "a", date: "2026-10-02", description: "Ăn trưa", amountVnd: 360_000, participantIds: ["a", "b", "c"] },
  { id: "e1", position: 1, payerId: "c", date: "2026-10-01", description: "Hoàn tiền vé", amountVnd: -90_000, participantIds: ["c", "d"] },
  { id: "e2", position: 2, payerId: "d", date: null, description: "Taxi sân bay", amountVnd: 100_000, participantIds: ["d", "a"] },
  { id: "e3", position: 3, payerId: null, date: "2026-10-02", description: "", amountVnd: 0, participantIds: [] },
  { id: "e4", position: 4, payerId: "a", date: "2026-10-05", description: "an sáng", amountVnd: 100_000, participantIds: ["b"] },
  { id: "e5", position: 5, payerId: "b", date: "2026-09-30", description: "Bánh mì", amountVnd: 75_500, participantIds: ["a"] },
];
const ids = (view) => view.order.filter((id) => view.visible.has(id));

test("search text ignores case, diacritics and đ, and collapses spaces", () => {
  assert.equal(normalizeSearchText("Ăn trưa"), "an trua");
  assert.equal(normalizeSearchText("  ĐÀ   LẠT\t2026 "), "da lat 2026");
  assert.equal(normalizeSearchText("Cà phê đá"), "ca phe da");
  // Precomposed (NFC) and decomposed (NFD) input give the same text.
  assert.equal(normalizeSearchText("Phở".normalize("NFD")), normalizeSearchText("Phở".normalize("NFC")));
  assert.equal(normalizeSearchText(null), "");
  assert.deepEqual(searchTokens("  an   TRƯA "), ["an", "trua"]);
  assert.deepEqual(searchTokens("   "), []);
});

test("the search box matches every word of the description, in any order", () => {
  const item = { ...complete, description: "Ăn trưa quán Đông" };
  for (const query of ["an trua", "ĂN TRƯA", "trua an", "dong", "quan", "  an  ", "Ăn"]) {
    assert.equal(matchesFilter(item, filter({ search: query })), true, query);
  }
  for (const query of ["an trua x", "sang", "trưa  tối"]) {
    assert.equal(matchesFilter(item, filter({ search: query })), false, query);
  }
  // Only the description is searched.
  assert.equal(matchesFilter({ ...item, description: "Taxi" }, filter({ search: "a" })), true);
  assert.equal(matchesFilter({ ...item, description: "Taxi" }, filter({ search: "an" })), false);
});

test("payer, participant and inclusive date range filters", () => {
  assert.equal(matchesFilter(complete, filter({ payerId: "a" })), true);
  assert.equal(matchesFilter(complete, filter({ payerId: "b" })), false);
  assert.equal(matchesFilter(complete, filter({ participantId: "b" })), true);
  assert.equal(matchesFilter(complete, filter({ participantId: "c" })), false);
  assert.equal(matchesFilter({ ...complete, participantIds: undefined }, filter({ participantId: "c" })), false);
  assert.equal(matchesFilter(complete, filter({ from: "2026-10-01" })), true);
  assert.equal(matchesFilter(complete, filter({ from: "2026-10-02" })), false);
  assert.equal(matchesFilter(complete, filter({ to: "2026-10-01" })), true);
  assert.equal(matchesFilter(complete, filter({ to: "2026-09-30" })), false);
  assert.equal(matchesFilter(complete, filter({ from: "2026-10-01", to: "2026-10-01" })), true);
  // A reversed range is read the right way round; rows without a date never match a range.
  assert.equal(matchesFilter(complete, filter({ from: "2026-10-05", to: "2026-09-01" })), true);
  assert.equal(matchesFilter({ ...complete, date: null }, filter({ from: "2026-01-01" })), false);
  assert.equal(matchesFilter({ ...complete, date: null }, filter({ to: "2027-01-01" })), false);
  assert.equal(matchesFilter({ ...complete, date: null }, EMPTY_FILTER), true);
  // Filters combine with AND.
  assert.equal(matchesFilter(complete, filter({ payerId: "a", participantId: "b", search: "trua", to: "2026-10-01" })), true);
  assert.equal(matchesFilter(complete, filter({ payerId: "a", participantId: "b", search: "trua", to: "2026-09-01" })), false);
});

test("'Thiếu thông tin' keeps the rows missing a payer, date, description, amount or participants", () => {
  assert.equal(isIncompleteExpense(complete), false);
  for (const missing of [{ payerId: null }, { payerId: "" }, { date: null }, { description: "   " }, { amountVnd: 0 }, { participantIds: [] }, { participantIds: undefined }]) {
    assert.equal(isIncompleteExpense({ ...complete, ...missing }), true, JSON.stringify(missing));
    assert.equal(matchesFilter({ ...complete, ...missing }, filter({ incomplete: true })), true, JSON.stringify(missing));
  }
  assert.equal(matchesFilter(complete, filter({ incomplete: true })), false);
  assert.equal(isIncompleteExpense({ ...complete, amountVnd: -1 }), false);
});

test("filter counters: the panel badge counts filters other than the always-visible search box", () => {
  assert.equal(panelFilterCount(EMPTY_FILTER), 0);
  assert.equal(panelFilterCount(filter({ search: "an" })), 0);
  assert.equal(panelFilterCount(filter({ payerId: "a", participantId: "b", incomplete: true })), 3);
  assert.equal(panelFilterCount(filter({ from: "2026-10-01", to: "2026-10-31" })), 1);
  assert.equal(panelFilterCount(filter({ to: "2026-10-31" })), 1);
  assert.equal(hasActiveFilter(EMPTY_FILTER), false);
  assert.equal(hasActiveFilter(filter({ search: "   " })), false);
  assert.equal(hasActiveFilter(filter({ search: "an" })), true);
  assert.equal(hasActiveFilter(filter({ incomplete: true })), true);
  assert.equal(isDefaultView(EMPTY_FILTER, DEFAULT_SORT), true);
  assert.equal(isDefaultView(EMPTY_FILTER, "amount-desc"), false);
  assert.equal(isDefaultView(filter({ payerId: "a" }), DEFAULT_SORT), false);
  assert.deepEqual(SORTS.map((sort) => sort.key), ["position", "date-desc", "date-asc", "amount-desc", "amount-asc", "description"]);
  assert.equal(SORTS[0].key, DEFAULT_SORT);
  assert.equal(isSortKey("amount-asc"), true);
  assert.equal(isSortKey("random"), false);
  // The phone's "Lọc & sắp xếp" badge also shows a remembered sort that is not the entry order.
  assert.equal(panelBadgeCount(EMPTY_FILTER, DEFAULT_SORT), 0);
  assert.equal(panelBadgeCount(EMPTY_FILTER, "date-desc"), 1);
  assert.equal(panelBadgeCount(filter({ payerId: "a", search: "x" }), "date-desc"), 2);
  assert.equal(panelBadgeCount(filter({ payerId: "a", from: "2026-01-01" })), 2);
});

test("the sort menu in index.html offers exactly SORTS, in order, with entry order first", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const select = html.match(/<select id="filter-sort">([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select, "missing #filter-sort");
  const options = [...select.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(([, key, label]) => ({ key, label }));
  assert.deepEqual(options, SORTS.map(({ key, label }) => ({ key, label })));
});

test("the default view is today's order with every row visible", () => {
  const shuffled = [ITEMS[3], ITEMS[0], ITEMS[5], ITEMS[1], ITEMS[4], ITEMS[2]];
  const view = computeExpenseView(shuffled);
  assert.deepEqual(view.order, ["e0", "e1", "e2", "e3", "e4", "e5"]);
  assert.equal(view.visible.size, 6);
  // Entry order is the position, not the id (UUIDs are random); ties of other sorts fall back to it too.
  const uuids = ["f3", "0a", "c7", "5e"].map((id, position) => ({ ...ITEMS[position], id, position, amountVnd: 100 }));
  assert.deepEqual(computeExpenseView([uuids[2], uuids[0], uuids[3], uuids[1]]).order, ["f3", "0a", "c7", "5e"]);
  assert.deepEqual(computeExpenseView(uuids, { sort: "amount-desc" }).order, ["f3", "0a", "c7", "5e"]);
});

test("every sort orders the rows, keeps ties in entry order and puts missing dates or descriptions last", () => {
  const order = (sort) => computeExpenseView(ITEMS, { sort }).order;
  assert.deepEqual(order("date-desc"), ["e4", "e0", "e3", "e1", "e5", "e2"]);
  assert.deepEqual(order("date-asc"), ["e5", "e1", "e0", "e3", "e4", "e2"]);
  assert.deepEqual(order("amount-desc"), ["e0", "e2", "e4", "e5", "e3", "e1"]);
  assert.deepEqual(order("amount-asc"), ["e1", "e3", "e5", "e2", "e4", "e0"]);
  // Vietnamese order: "an" < "Ăn" (ă is its own letter after a) < "Bánh" < "Hoàn" < "Taxi"; empty description last.
  assert.deepEqual(order("description"), ["e4", "e0", "e5", "e1", "e2", "e3"]);
  assert.deepEqual(order("position"), ["e0", "e1", "e2", "e3", "e4", "e5"]);
  assert.deepEqual(order("unknown"), ["e0", "e1", "e2", "e3", "e4", "e5"]);
});

test("filters hide rows without changing the order; pinned new rows stay visible at the end", () => {
  const byPayer = computeExpenseView(ITEMS, { filter: filter({ payerId: "a" }), sort: "amount-asc" });
  assert.deepEqual(byPayer.order, ["e1", "e3", "e5", "e2", "e4", "e0"]);
  assert.deepEqual(ids(byPayer), ["e4", "e0"]);
  const pinned = computeExpenseView(ITEMS, { filter: filter({ payerId: "a" }), sort: "amount-asc", pinned: ["e3", "e1", "missing", "e3"] });
  assert.deepEqual(pinned.order, ["e5", "e2", "e4", "e0", "e3", "e1"]);
  assert.deepEqual(ids(pinned), ["e4", "e0", "e3", "e1"]);
  const incomplete = computeExpenseView(ITEMS, { filter: filter({ incomplete: true }) });
  assert.deepEqual(ids(incomplete), ["e2", "e3"]);
  const searched = computeExpenseView(ITEMS, { filter: filter({ search: "AN" }), sort: "description" });
  assert.deepEqual(ids(searched), ["e4", "e0", "e5", "e1", "e2"]);
  assert.deepEqual(ids(computeExpenseView(ITEMS, { filter: filter({ search: "an sang" }) })), ["e4"]);
});

test("a re-render while a row is being edited keeps the previous order and visibility", () => {
  const previous = { order: ["e4", "e0", "e2", "e1"], hidden: new Set(["e2", "e1"]) };
  // e0 is focused and no longer matches the filter; e3 and e5 are new from the server.
  const items = ITEMS.map((item) => (item.id === "e0" ? { ...item, payerId: "z" } : item));
  const view = computeExpenseView(items, { filter: filter({ payerId: "a" }), sort: "date-desc", focusedId: "e0", previous });
  assert.deepEqual(view.order, ["e4", "e0", "e2", "e1", "e3", "e5"]);
  assert.deepEqual(ids(view), ["e4", "e0"]);
  // A focused row that was hidden before is shown; a fresh row that matches the filter is shown at the end.
  const fresh = computeExpenseView([...items, { ...ITEMS[4], id: "e6", position: 6 }], {
    filter: filter({ payerId: "a" }), sort: "date-desc", focusedId: "e2", previous,
  });
  assert.deepEqual(ids(fresh), ["e4", "e0", "e2", "e6"]);
  // Rows deleted meanwhile drop out of the previous order.
  const deleted = computeExpenseView(items.filter((item) => item.id !== "e4"), { filter: EMPTY_FILTER, focusedId: "e0", previous });
  assert.deepEqual(deleted.order, ["e0", "e2", "e1", "e3", "e5"]);
  // Without a focused row the view is computed from scratch.
  assert.deepEqual(computeExpenseView(items, { filter: filter({ payerId: "a" }), sort: "date-desc", previous }).order, ["e4", "e0", "e3", "e1", "e5", "e2"]);
});

test("the status line counts the visible rows and adds up their amounts", () => {
  assert.deepEqual(viewSummary([
    { amountVnd: 360_000, hidden: false },
    { amountVnd: -90_000, hidden: false },
    { amountVnd: 100_000, hidden: true },
    { amountVnd: 0, hidden: false },
  ]), { shown: 3, total: 4, subtotalVnd: 270_000 });
  assert.deepEqual(viewSummary([]), { shown: 0, total: 0, subtotalVnd: 0 });
});

test("A→Z uses Vietnamese order: ă and â are letters after a, đ after d", () => {
  const items = ["Ăn", "Anh", "Đá", "Dê", "Âm"].map((description, position) => ({ ...complete, id: `v${position}`, position, description }));
  const sorted = computeExpenseView(items, { sort: "description" }).order.map((id) => items.find((item) => item.id === id).description);
  assert.deepEqual(sorted, ["Anh", "Ăn", "Âm", "Dê", "Đá"]);
});
