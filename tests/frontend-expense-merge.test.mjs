import assert from "node:assert/strict";
import test from "node:test";
import { mergeExpenseLists } from "../public/js/expense-merge.js";

const expense = (id, extra = {}) => ({ id, payerId: null, date: null, description: id, amountVnd: 0, participantIds: [], ...extra });

test("the server's list replaces the page's, in the server's order, with the page's placeholders kept at the end", () => {
  const local = [expense("a"), expense("b", { amountVnd: 1 }), expense("pending-1"), expense("gone")];
  const server = [expense("b", { amountVnd: 2 }), expense("a"), expense("c")];
  const result = mergeExpenseLists({ local, server });
  assert.deepEqual(result.expenses.map((item) => item.id), ["b", "a", "c", "pending-1"]);
  assert.equal(result.expenses[0].amountVnd, 2, "the server's copy wins by default");
  assert.deepEqual(result.dropped, ["gone"], "a row the server no longer has is dropped (placeholders never are)");
  assert.deepEqual([...result.serverIds], ["b", "a", "c"]);
});

test("rows the page saved or created while the GET was out keep the page's copy, even if the answer lacks them", () => {
  const local = [expense("a", { amountVnd: 5 }), expense("new", { description: "Bản sao" })];
  const server = [expense("a", { amountVnd: 1 })];
  const result = mergeExpenseLists({ local, server, preferLocal: new Set(["a", "new", "unknown"]) });
  assert.deepEqual(result.expenses.map((item) => [item.id, item.amountVnd]), [["a", 5], ["new", 0]]);
  assert.deepEqual(result.dropped, []);
});

test("a row deleted while the GET was out does not come back, and rows waiting to be deleted stay hidden", () => {
  const local = [expense("a"), expense("b")];
  const server = [expense("a"), expense("b"), expense("deleted"), expense("waiting", { amountVnd: 7 })];
  const result = mergeExpenseLists({
    local,
    server,
    preferLocal: new Set(["deleted"]),
    removed: new Set(["deleted"]),
    isDeleting: (id) => id === "waiting",
  });
  assert.deepEqual(result.expenses.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(result.deleting.map((item) => [item.id, item.amountVnd]), [["waiting", 7]], "its newest copy, for 'Hoàn tác'");
});
