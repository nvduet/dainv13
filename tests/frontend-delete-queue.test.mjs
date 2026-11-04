import assert from "node:assert/strict";
import test from "node:test";
import { createDeleteQueue } from "../public/js/delete-queue.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const calls = [];
  const events = [];
  const queue = createDeleteQueue({
    send: (id, options) => new Promise((resolve, reject) => calls.push({ id, options, resolve, reject })),
    onCommitted: (id, data) => events.push(["committed", id, data]),
    onFailed: (id, error, data) => events.push(["failed", id, error.message, data]),
  });
  return { queue, calls, events };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const apiError = (message, status) => Object.assign(new Error(message), { status });

test("a deleted row waits: nothing is sent until it is committed, and undo returns it without a call", async () => {
  const { queue, calls, events } = setup();
  assert.equal(queue.add("e1", { index: 2 }), true);
  assert.equal(queue.add("e1", { index: 9 }), false, "a row is queued once");
  assert.equal(queue.has("e1"), true);
  assert.equal(queue.isPending("e1"), true);
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(queue.restore("e1"), { index: 2 });
  assert.equal(queue.has("e1"), false);
  await queue.commitAll();
  assert.equal(calls.length, 0);
  assert.deepEqual(events, []);
});

test("several deletes coexist; committing sends one DELETE each and reports once", async () => {
  const { queue, calls, events } = setup();
  queue.add("e1", { n: 1 });
  queue.add("e2", { n: 2 });
  assert.deepEqual(queue.pendingIds(), ["e1", "e2"]);
  const first = queue.commit("e1");
  const again = queue.commit("e1");
  await settle();
  assert.deepEqual(calls.map((call) => [call.id, call.options.keepalive]), [["e1", false]]);
  assert.equal(queue.isPending("e1"), false);
  assert.deepEqual(queue.pendingIds(), ["e2"], "a row whose DELETE is on its way is not offered for undo");
  assert.equal(queue.restore("e1"), null, "too late to undo once the DELETE is on its way");
  calls[0].resolve({ deleted: true });
  assert.deepEqual(await Promise.all([first, again]), [true, true]);
  assert.deepEqual(events, [["committed", "e1", { n: 1 }]]);
  assert.deepEqual(queue.pendingIds(), ["e2"]);
  assert.equal(await queue.commit("unknown"), true);
});

test("the DELETE waits for the row's running PUT", async () => {
  const { queue, calls } = setup();
  queue.add("e1", {});
  const put = deferred();
  const done = queue.commit("e1", { wait: put.promise });
  await settle();
  assert.equal(calls.length, 0, "not while the PUT runs");
  assert.deepEqual(queue.pendingIds(), [], "committed: no longer undoable while it waits");
  assert.equal(queue.restore("e1"), null);
  assert.equal(queue.forget("e1"), false, "a delete already committed is not dropped by a reload");
  put.resolve({ expense: { id: "e1" } });
  await settle();
  assert.equal(calls.length, 1);
  calls[0].resolve({});
  assert.equal(await done, true);
});

test("a refused DELETE reports the error and the kept data once, so the row can come back", async () => {
  const { queue, calls, events } = setup();
  queue.add("e1", { index: 3 });
  const done = queue.commit("e1");
  await settle();
  calls[0].reject(apiError("Không kết nối được máy chủ.", 0));
  assert.equal(await done, false);
  assert.deepEqual(events, [["failed", "e1", "Không kết nối được máy chủ.", { index: 3 }]]);
  assert.equal(queue.has("e1"), false);
});

test("404 means the expense is already gone: counted as deleted", async () => {
  const { queue, calls, events } = setup();
  queue.add("e1", {});
  const done = queue.commit("e1");
  await settle();
  calls[0].reject(apiError("Không tìm thấy khoản chi.", 404));
  assert.equal(await done, true);
  assert.deepEqual(events.map(([type]) => type), ["committed"]);
});

test("page hide sends every waiting DELETE at once with keepalive, without waiting for a running PUT", async () => {
  const { queue, calls, events } = setup();
  queue.add("e1", {});
  queue.add("e2", {});
  queue.add("e3", {});
  const put = deferred();
  const waiting = queue.commit("e2", { wait: put.promise });
  queue.sendAllNow();
  assert.deepEqual(calls.map((call) => [call.id, call.options.keepalive]), [["e1", true], ["e2", true], ["e3", true]]);
  queue.sendAllNow();
  assert.equal(calls.length, 3, "never twice");
  put.resolve(null);
  await settle();
  assert.equal(calls.length, 3, "the waiting commit does not send again");
  for (const call of calls) call.resolve({});
  assert.equal(await waiting, true);
  assert.deepEqual(events.map(([, id]) => id), ["e1", "e2", "e3"]);
});

test("forget drops a row the server no longer has, without a DELETE", async () => {
  const { queue, calls, events } = setup();
  queue.add("e1", {});
  assert.equal(queue.forget("e1"), true);
  assert.equal(queue.forget("e1"), false);
  await queue.commitAll();
  assert.equal(calls.length, 0);
  assert.deepEqual(events, []);
});

test("a commit after the page-hide send waits for that DELETE instead of sending a second one", async () => {
  const { queue, calls, events } = setup();
  queue.add("e1", { index: 0 });
  queue.sendAllNow();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.keepalive, true);
  const committed = queue.commit("e1");
  await settle();
  assert.equal(calls.length, 1, "the keepalive DELETE is the only one");
  calls[0].resolve({});
  assert.equal(await committed, true);
  assert.deepEqual(events, [["committed", "e1", { index: 0 }]]);
});
