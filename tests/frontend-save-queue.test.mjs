import assert from "node:assert/strict";
import test from "node:test";
import { createSaveQueue } from "../public/js/save-queue.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= now).sort((left, right) => left[1].at - right[1].at);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.callback();
        await settle();
      }
    },
    get count() {
      return timers.size;
    },
  };
}

function setup(options = {}) {
  const timers = fakeTimers();
  const calls = [];
  const events = [];
  const queue = createSaveQueue({
    send: (id, body, options) => new Promise((resolve, reject) => calls.push({ id, body, options, resolve, reject })),
    onSaved: (id, response, details) => events.push({
      type: "saved",
      id,
      response,
      settled: details.settled,
      unloading: details.unloading,
      pending: { ...details.pending },
      toggles: [...details.participantToggles],
    }),
    onFailed: (id, error, details) => events.push({ type: "failed", id, message: error.message, unloading: details.unloading }),
    onChange: () => events.push({ type: "change" }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...options,
  });
  return { queue, timers, calls, events, saved: () => events.filter((event) => event.type === "saved") };
}

// Like the errors thrown by api(): status 0 means no response arrived.
function apiError(message, status, retryAfter = null) {
  return Object.assign(new Error(message), { status, retryAfter });
}

test("debounces edits per expense and sends only the latest values", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "P", 400);
  await timers.advance(300);
  queue.update("e1", "description", "Phở", 400);
  queue.update("e2", "payerId", "m1", 100);
  assert.equal(queue.status().state, "pending");
  await timers.advance(100);
  assert.deepEqual(calls.map(({ id, body }) => [id, body]), [["e2", { payerId: "m1" }]]);
  await timers.advance(300);
  assert.deepEqual(calls.map(({ id, body }) => [id, body]), [["e2", { payerId: "m1" }], ["e1", { description: "Phở" }]]);
  assert.equal(calls[1].options.keepalive, false);
  assert.equal(queue.status().state, "saving");
});

test("edits made while a save is in flight are saved right after it, never concurrently", async () => {
  const { queue, timers, calls, saved } = setup();
  queue.update("e1", "description", "A", 400);
  await timers.advance(400);
  queue.update("e1", "description", "AB", 400);
  queue.update("e1", "amountVnd", 5000, 400);
  await timers.advance(400);
  assert.equal(calls.length, 1, "no second PUT while the first is in flight");
  calls[0].resolve({ expense: { id: "e1", description: "A" } });
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { description: "AB", amountVnd: 5000 });
  assert.equal(saved()[0].settled, false);
  assert.deepEqual(saved()[0].pending, { description: "AB", amountVnd: 5000 });
  calls[1].resolve({ expense: { id: "e1", description: "AB", amountVnd: 5000 } });
  await settle();
  assert.equal(saved()[1].settled, true);
  assert.equal(queue.status().state, "saved");
  assert.equal(queue.get("e1"), null, "idle entries are forgotten");
});

test("a value typed back to what was sent is acknowledged by Object.is", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "amountVnd", 0, 400);
  await timers.advance(400);
  queue.update("e1", "amountVnd", -0, 0);
  queue.update("e1", "description", "x", 400);
  queue.update("e1", "description", "", 400);
  calls[0].resolve({ expense: {} });
  await settle();
  // P6-0d: the rest waits for its debounce timer, still running when the first PUT came back.
  await timers.advance(400);
  assert.deepEqual(calls[1].body, { amountVnd: -0, description: "" }, "-0 is not Object.is-equal to 0");
  calls[1].resolve({ expense: {} });
  await settle();
  queue.update("e1", "payerId", "m1", 100);
  await timers.advance(100);
  queue.update("e1", "payerId", "m1", 100);
  calls[2].resolve({ expense: {} });
  await settle();
  await timers.advance(100);
  assert.equal(calls.length, 3, "the same value typed again during the flight needs no new PUT");
  assert.equal(queue.status().state, "saved");
});

test("participant ticks are sent as participantChanges and merge per member", async () => {
  const { queue, timers, calls, saved } = setup();
  queue.toggleParticipant("e1", "m1", true, 100);
  queue.toggleParticipant("e1", "m2", false, 100);
  await timers.advance(100);
  assert.deepEqual(calls[0].body, { participantChanges: { add: ["m1"], remove: ["m2"] } });
  queue.toggleParticipant("e1", "m3", true, 100);
  queue.toggleParticipant("e1", "m1", false, 100);
  await timers.advance(100);
  calls[0].resolve({ expense: { id: "e1", participantIds: ["m1", "m4"] } });
  await settle();
  assert.deepEqual(saved()[0].toggles, [["m1", false], ["m3", true]], "newer toggles stay pending for the merge");
  assert.deepEqual(calls[1].body, { participantChanges: { add: ["m3"], remove: ["m1"] } });
  assert.equal("participantIds" in calls[1].body, false);
});

test("a failed save shows its error until the next edit and blocks flush", async () => {
  const { queue, timers, calls, events } = setup();
  queue.update("e1", "description", "Taxi", 400);
  await timers.advance(400);
  calls[0].reject(new Error("Đã vượt giới hạn."));
  await settle();
  assert.deepEqual(queue.status(), { state: "error", message: "Đã vượt giới hạn." });
  assert.deepEqual(events.filter((event) => event.type === "failed"), [{ type: "failed", id: "e1", message: "Đã vượt giới hạn.", unloading: false }]);
  assert.equal(await queue.flush(), false);
  assert.equal(calls.length, 1, "flush does not retry a failed row");
  queue.update("e1", "amountVnd", 1000, 400);
  assert.equal(queue.status().state, "pending");
  const flushed = queue.flush();
  await settle();
  assert.deepEqual(calls[1].body, { description: "Taxi", amountVnd: 1000 }, "the retry carries every unsaved field");
  calls[1].resolve({ expense: {} });
  assert.equal(await flushed, true);
  assert.equal(queue.status().state, "saved");
});

test("an edit during a failing flight retries right away", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 0);
  await timers.advance(0);
  queue.update("e1", "description", "AB", 0);
  await timers.advance(0);
  calls[0].reject(new Error("offline"));
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { description: "AB" });
  assert.equal(queue.status().state, "error", "the failure stays visible until a save succeeds");
  calls[1].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "saved");
});

test("an invalid field counts as the row's error until it becomes valid or empty", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "amountVnd", 12_000, 400);
  queue.rejectField("e1", "amountVnd", "Nhập chi phí bằng nghìn đồng.");
  assert.deepEqual(queue.status(), { state: "error", message: "Nhập chi phí bằng nghìn đồng." });
  queue.update("e1", "description", "Ăn", 400);
  await timers.advance(400);
  assert.deepEqual(calls[0].body, { description: "Ăn" }, "the invalid amount is not sent");
  calls[0].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "error", "a successful save of other fields keeps the parse error");
  queue.update("e1", "amountVnd", 0, 400);
  assert.equal(queue.status().state, "pending");
});

test("flush refuses while an amount cannot be parsed, even when nothing else is pending", async () => {
  const { queue, calls } = setup();
  queue.rejectField("e1", "amountVnd", "Nhập chi phí bằng nghìn đồng.");
  assert.equal(queue.hasWork("e1"), false);
  assert.equal(await queue.flush(), false);
  assert.equal(calls.length, 0);
  queue.update("e1", "amountVnd", 0, 400);
  const flushed = queue.flush();
  await settle();
  assert.deepEqual(calls[0].body, { amountVnd: 0 });
  calls[0].resolve({ expense: {} });
  assert.equal(await flushed, true);
});

test("status reports error, then in-flight, then pending, then saved", async () => {
  const { queue, timers, calls } = setup();
  assert.deepEqual(queue.status(), { state: "saved" });
  queue.update("e1", "description", "x", 400);
  assert.equal(queue.status().state, "pending");
  await timers.advance(400);
  queue.update("e2", "description", "y", 400);
  assert.equal(queue.status().state, "saving");
  queue.rejectField("e3", "amountVnd", "Sai");
  assert.deepEqual(queue.status(), { state: "error", message: "Sai" });
  queue.discard("e3");
  calls[0].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "pending");
  await timers.advance(400);
  calls[1].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "saved");
});

test("status shows the newest error when several rows fail", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 0);
  queue.update("e2", "description", "B", 0);
  await timers.advance(0);
  calls[0].reject(new Error("Lỗi dòng 1"));
  await settle();
  calls[1].reject(new Error("Lỗi dòng 2"));
  await settle();
  assert.deepEqual(queue.status(), { state: "error", message: "Lỗi dòng 2" });
  queue.update("e1", "description", "AB", 0);
  await timers.advance(0);
  calls[2].reject(new Error("Lỗi dòng 1 lần 2"));
  await settle();
  assert.deepEqual(queue.status(), { state: "error", message: "Lỗi dòng 1 lần 2" });
  queue.rejectField("e3", "amountVnd", "Sai số tiền");
  assert.deepEqual(queue.status(), { state: "error", message: "Sai số tiền" });
});

test("hasWork is true only with pending values or a scheduled save", async () => {
  const { queue, timers, calls } = setup();
  assert.equal(queue.hasWork("e1"), false);
  queue.update("e1", "description", "x", 400);
  assert.equal(queue.hasWork("e1"), true);
  await timers.advance(400);
  calls[0].resolve({ expense: {} });
  await settle();
  assert.equal(queue.hasWork("e1"), false, "focus/blur after an autosave must not schedule anything");
  queue.rejectField("e2", "amountVnd", "Sai");
  assert.notEqual(queue.get("e2"), null);
  assert.equal(queue.hasWork("e2"), false, "an invalid amount alone has nothing to send");
});

test("retainMembers drops ticks and payers of deleted members so the rest of the row saves again", async () => {
  const { queue, timers, calls } = setup();
  const remaining = new Set(["m1", "m2", "m3"]);
  queue.toggleParticipant("e1", "m4", true, 100);
  queue.update("e1", "description", "Phở gà", 100);
  queue.update("e2", "payerId", "m4", 100);
  queue.update("e3", "description", "Taxi", 100);
  await timers.advance(100);
  calls.forEach((call) => call.reject(new Error("Tạm thời lỗi.")));
  await settle();
  assert.equal(await queue.flush(), false);
  queue.retainMembers(remaining);
  assert.equal(queue.get("e2"), null, "a row whose only change pointed at the deleted member is forgotten");
  assert.equal(queue.get("e1").error, null);
  assert.equal(queue.get("e3").error, "Tạm thời lỗi.", "rows without deleted members keep their error");
  await timers.advance(0);
  assert.deepEqual(calls.slice(3).map((call) => [call.id, call.body]), [["e1", { description: "Phở gà" }]]);
  calls[3].resolve({ expense: {} });
  await settle();
  assert.deepEqual(queue.status(), { state: "error", message: "Tạm thời lỗi." });

  queue.update("e4", "payerId", null, 100);
  queue.toggleParticipant("e4", "m4", true, 100);
  queue.toggleParticipant("e4", "m2", false, 100);
  await timers.advance(100);
  queue.retainMembers(remaining);
  calls[4].reject(new Error("Một hoặc nhiều thành viên không còn tồn tại."));
  await settle();
  assert.deepEqual(calls[5].body, { payerId: null, participantChanges: { add: [], remove: ["m2"] } },
    "an in-flight row retries at once without the deleted member; a cleared payer stays pending");
});

test("discard clears pending edits, returns the in-flight PUT and ignores its late result", async () => {
  const { queue, timers, calls, events } = setup();
  queue.update("e1", "description", "A", 400);
  await timers.advance(400);
  queue.update("e1", "description", "AB", 400);
  const inFlight = queue.discard("e1");
  assert.equal(queue.status().state, "saved");
  calls[0].resolve({ expense: { id: "e1", description: "A" } });
  assert.deepEqual(await inFlight, { expense: { id: "e1", description: "A" } });
  await timers.advance(1000);
  assert.equal(calls.length, 1);
  assert.equal(events.some((event) => event.type === "saved"), false);
  assert.equal(await queue.discard("missing"), null);
});

test("retain drops entries of expenses that no longer exist", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "x", 400);
  queue.update("e2", "description", "y", 400);
  queue.retain(new Set(["e2"]));
  await timers.advance(400);
  assert.deepEqual(calls.map((call) => call.id), ["e2"]);
});

test("visibilitychange saves idle rows with keepalive and never doubles an in-flight PUT", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 400);
  await timers.advance(400);
  queue.update("e1", "description", "AB", 400);
  queue.update("e2", "amountVnd", 1000, 400);
  queue.saveAllNow();
  assert.equal(timers.count, 0, "debounce timers are cleared");
  assert.deepEqual(calls.map((call) => [call.id, call.options.keepalive]), [["e1", false], ["e2", true]]);
  calls[0].resolve({ expense: {} });
  await settle();
  assert.deepEqual(calls.map((call) => [call.id, call.options.keepalive]), [["e1", false], ["e2", true], ["e1", true]]);
  assert.deepEqual(calls[2].body, { description: "AB" });
});

test("pagehide sends one keepalive PUT per changed row, including rows mid-save, without UI updates", async () => {
  const { queue, timers, calls, events } = setup();
  queue.update("e1", "description", "Lẩu", 400);
  await timers.advance(400);
  queue.update("e1", "description", "Lẩu Thái", 400);
  queue.toggleParticipant("e2", "m1", true, 100);
  const changesBefore = events.filter((event) => event.type === "change").length;
  queue.saveAllForUnload();
  assert.deepEqual(calls.slice(1).map((call) => [call.id, call.body, call.options.keepalive]), [
    ["e1", { description: "Lẩu Thái" }, true],
    ["e2", { participantChanges: { add: ["m1"], remove: [] } }, true],
  ]);
  calls[1].resolve({ expense: {} });
  calls[2].reject(new Error("offline"));
  await settle();
  assert.equal(events.filter((event) => event.type === "change").length, changesBefore, "no status refresh while unloading");
  assert.deepEqual(events.filter((event) => event.unloading).map((event) => event.type), ["saved", "failed"]);
  await timers.advance(1000);
  assert.equal(calls.length, 3, "nothing is rescheduled");
});

test("pagehide resends a row whose normal PUT is in flight with the same values (navigation aborts it)", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "Phở Lẩu", 400);
  await timers.advance(400);
  assert.deepEqual(calls.map((call) => call.options.keepalive), [false]);
  queue.saveAllForUnload();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.equal(calls[1].options.keepalive, true);
});

test("pagehide skips a row whose keepalive PUT already carries the latest values", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 400);
  queue.saveAllNow();
  queue.saveAllForUnload();
  assert.equal(calls.length, 1);
  queue.update("e1", "description", "AB", 400);
  queue.saveAllForUnload();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { description: "AB" });
  await timers.advance(400);
  assert.equal(calls.length, 2);
});

test("after pagehide, an aborted in-flight PUT and visibilitychange do not resend the same values", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 400);
  await timers.advance(400);
  queue.update("e1", "description", "AB", 400);
  queue.saveAllForUnload();
  calls[0].reject(new Error("aborted by navigation"));
  await settle();
  queue.saveAllNow();
  await timers.advance(1000);
  assert.deepEqual(calls.map((call) => [call.body.description, call.options.keepalive]), [["A", false], ["AB", true]]);
  calls[1].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "saved", "the pagehide PUT acknowledges the values and clears the abort error");
});

test("flush waits for an outstanding pagehide PUT instead of sending it again", async () => {
  const { queue, calls } = setup();
  queue.update("e1", "description", "A", 400);
  queue.saveAllForUnload();
  let flushed = null;
  const flushing = queue.flush().then((result) => {
    flushed = result;
  });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(flushed, null);
  calls[0].resolve({ expense: {} });
  await flushing;
  assert.equal(flushed, true);
});

test("flush waits for in-flight saves and saves scheduled edits immediately", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 400);
  await timers.advance(400);
  queue.update("e2", "description", "B", 400);
  let done = false;
  const flushed = queue.flush().then((result) => {
    done = result;
  });
  await settle();
  assert.deepEqual(calls.map((call) => call.id), ["e1", "e2"]);
  calls[1].resolve({ expense: {} });
  await settle();
  assert.equal(done, false, "still waiting for e1");
  calls[0].resolve({ expense: {} });
  await flushed;
  assert.equal(done, true);
});

test("a 429 keeps the edits, pauses every expense save until Retry-After plus jitter, then sends one merged PUT per expense", async () => {
  const { queue, timers, calls, events } = setup({ random: () => 0.5 });
  const limited = "Đã vượt giới hạn thao tác. Hãy thử lại sau.";
  queue.update("e1", "description", "Phở", 0);
  queue.update("e2", "amountVnd", 5000, 0);
  await timers.advance(0);
  calls[0].reject(apiError(limited, 429, 10));
  await settle();
  assert.deepEqual(queue.status(), { state: "error", message: limited });
  assert.deepEqual(events.filter((event) => event.type === "failed").map((event) => event.message), [limited]);
  calls[1].resolve({ expense: {} });
  await settle();

  queue.update("e1", "amountVnd", 12_000, 400);
  queue.toggleParticipant("e2", "m1", true, 100);
  queue.toggleParticipant("e3", "m2", true, 100);
  await timers.advance(400);
  assert.equal(calls.length, 2, "nothing is sent while paused");
  assert.equal(queue.status().state, "pending");
  assert.equal(await queue.flush(), false, "Store/restore/Done refuse while saves are paused");
  // Retry-After 10 s plus 0.5 × 3 s of jitter, counted from the 429.
  await timers.advance(11_500 - 400 - 1);
  assert.equal(calls.length, 2);
  await timers.advance(1);
  assert.deepEqual(calls.slice(2).map(({ id, body }) => [id, body]), [
    ["e1", { description: "Phở", amountVnd: 12_000 }],
    ["e2", { participantChanges: { add: ["m1"], remove: [] } }],
    ["e3", { participantChanges: { add: ["m2"], remove: [] } }],
  ]);
  calls.slice(2).forEach((call) => call.resolve({ expense: {} }));
  await settle();
  assert.equal(queue.status().state, "saved");
});

test("a 429 without Retry-After pauses for 60 s; a later 429 restarts the pause", async () => {
  const { queue, timers, calls } = setup({ random: () => 0 });
  queue.update("e1", "description", "A", 0);
  await timers.advance(0);
  calls[0].reject(apiError("Máy chủ trả về dữ liệu không đọc được (HTTP 429).", 429));
  await settle();
  queue.update("e1", "description", "AB", 0);
  await timers.advance(59_999);
  assert.equal(calls.length, 1);
  await timers.advance(1);
  assert.deepEqual(calls[1].body, { description: "AB" });
  calls[1].reject(apiError("Đã vượt giới hạn thao tác. Hãy thử lại sau.", 429, 5));
  await settle();
  await timers.advance(4_999);
  assert.equal(calls.length, 2);
  await timers.advance(1);
  assert.equal(calls.length, 3);
});

test("a rejected fetch or 502/503/504 is retried after 2, 5, 15 and 30 s, then waits for the user", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "Lẩu", 0);
  await timers.advance(0);
  calls[0].reject(apiError("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.", 0));
  await settle();
  const failures = [502, 503, 504, 0];
  for (const [attempt, delay] of [2000, 5000, 15_000, 30_000].entries()) {
    await timers.advance(delay - 1);
    assert.equal(calls.length, attempt + 1, `nothing before ${delay} ms`);
    await timers.advance(1);
    assert.equal(calls.length, attempt + 2, `retry after ${delay} ms`);
    assert.deepEqual(calls.at(-1).body, { description: "Lẩu" });
    assert.equal(queue.status().state, "error", "the row error stays visible while retrying");
    calls.at(-1).reject(apiError(`HTTP ${failures[attempt]}`, failures[attempt]));
    await settle();
  }
  await timers.advance(60 * 60_000);
  assert.equal(calls.length, 5, "at most 4 timed retries per episode");
  assert.deepEqual(queue.status(), { state: "error", message: "HTTP 0" });
  assert.equal(await queue.flush(), false);

  // Back online after a longer outage (or the page shown again): one more try, no new schedule.
  queue.retryNow();
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[5].body, { description: "Lẩu" });
  calls[5].reject(apiError("HTTP 0", 0));
  await settle();
  await timers.advance(60 * 60_000);
  assert.equal(calls.length, 6, "the extra try starts no timed retries");

  // Leaving the row (focusout schedules a save) or editing it starts a new episode.
  assert.equal(queue.hasWork("e1"), true);
  queue.schedule("e1", 0);
  await timers.advance(0);
  assert.equal(calls.length, 7);
  calls[6].reject(apiError("HTTP 503", 503));
  await settle();
  await timers.advance(2000);
  assert.equal(calls.length, 8);
  calls[7].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "saved");
});

test("online after the timed retries ran out saves the row", async () => {
  let online = false;
  const timers = fakeTimers();
  const sent = [];
  const queue = createSaveQueue({
    send: (id) => {
      sent.push(id);
      return online ? Promise.resolve({ expense: {} }) : Promise.reject(apiError("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.", 0));
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  queue.update("e1", "description", "Phở", 0);
  for (let second = 0; second < 60; second += 1) await timers.advance(1000);
  assert.equal(sent.length, 5, "a minute offline uses the first try and the 4 timed retries");
  assert.equal(queue.status().state, "error");
  online = true;
  queue.retryNow();
  await settle();
  assert.equal(sent.length, 6);
  assert.equal(queue.status().state, "saved");
});

test("a retry that falls due during a 429 pause, or is asked for by online, is sent when the pause ends", async () => {
  const { queue, timers, calls } = setup({ random: () => 0 });
  const limited = "Đã vượt giới hạn thao tác. Hãy thử lại sau.";
  queue.update("e1", "description", "A", 0);
  queue.update("e2", "description", "B", 0);
  queue.update("e3", "description", "C", 0);
  await timers.advance(0);
  calls[1].reject(apiError(limited, 429, 10));
  calls[0].reject(apiError("offline", 0));
  await settle();
  await timers.advance(2000);
  assert.equal(calls.length, 3, "e1's retry falls due during the pause and waits");
  calls[2].reject(apiError("HTTP 503", 503));
  await settle();
  await timers.advance(1000);
  queue.retryNow();
  assert.equal(calls.length, 3, "online during the pause sends nothing yet");
  assert.equal(await queue.flush(), false);

  await timers.advance(7000);
  assert.deepEqual(calls.slice(3).map(({ id, body }) => [id, body]), [
    ["e1", { description: "A" }],
    ["e2", { description: "B" }],
    ["e3", { description: "C" }],
  ], "one merged PUT per expense: the held retries and the row refused with 429");
  // The held retry was e1's first of four: its next one comes 5 s after this failure.
  calls[3].reject(apiError("offline", 0));
  calls[4].resolve({ expense: {} });
  calls[5].resolve({ expense: {} });
  await settle();
  await timers.advance(4999);
  assert.equal(calls.length, 6);
  await timers.advance(1);
  assert.deepEqual(calls.slice(6).map(({ id }) => id), ["e1"]);
  calls[6].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "saved");
});

test("when a 429 pause ends, rows that failed with a 4xx or a 500 or ran out of retries are not resent", async () => {
  const { queue, timers, calls } = setup({ random: () => 0 });
  queue.update("capped", "description", "A", 0);
  await timers.advance(0);
  calls[0].reject(apiError("offline", 0));
  await settle();
  for (const delay of [2000, 5000, 15_000, 30_000]) {
    await timers.advance(delay);
    calls.at(-1).reject(apiError("offline", 0));
    await settle();
  }
  assert.equal(calls.length, 5);
  queue.update("e400", "payerId", "deleted-member", 0);
  queue.update("e404", "description", "B", 0);
  queue.update("e500", "description", "C", 0);
  queue.update("limited", "description", "D", 0);
  await timers.advance(0);
  calls[5].reject(apiError("Một hoặc nhiều thành viên không còn tồn tại.", 400));
  calls[6].reject(apiError("Không tìm thấy khoản chi.", 404));
  calls[7].reject(apiError("Đã xảy ra lỗi máy chủ. Hãy thử lại; nếu vẫn tiếp diễn, liên hệ Admin.", 500));
  calls[8].reject(apiError("Đã vượt giới hạn thao tác. Hãy thử lại sau.", 429, 5));
  await settle();
  await timers.advance(5000);
  assert.deepEqual(calls.slice(9).map(({ id }) => id), ["limited"]);
  calls[9].resolve({ expense: {} });
  await settle();
  await timers.advance(60 * 60_000);
  assert.equal(calls.length, 10);
  assert.equal(queue.status().state, "error", "the other rows keep their errors until the user acts");
});

test("retries wait while the page is hidden; online or becoming visible retries once at once", async () => {
  let visible = true;
  const { queue, timers, calls } = setup({ isVisible: () => visible });
  queue.update("e1", "description", "A", 0);
  queue.update("e2", "description", "B", 0);
  await timers.advance(0);
  calls[0].reject(apiError("offline", 0));
  calls[1].reject(apiError("offline", 0));
  await settle();
  queue.retryNow();
  assert.deepEqual(calls.slice(2).map(({ id }) => id), ["e1", "e2"], "online: retried at once");
  calls[2].reject(apiError("offline", 0));
  calls[3].resolve({ expense: {} });
  await settle();

  visible = false;
  await timers.advance(5000);
  assert.equal(calls.length, 4, "a retry that falls due while hidden waits");
  queue.retryNow();
  assert.equal(calls.length, 4, "nothing is retried while hidden");
  visible = true;
  queue.retryNow();
  assert.equal(calls.length, 5, "visibilitychange to visible sends the waiting retry once");
  assert.deepEqual(calls[4].body, { description: "A" });
  queue.retryNow();
  assert.equal(calls.length, 5);
  calls[4].resolve({ expense: {} });
  await settle();
  assert.equal(queue.status().state, "saved");
});

test("a 4xx other than 429, a 500 or an error without a status is never retried automatically", async () => {
  for (const failure of [
    apiError("Một hoặc nhiều thành viên không còn tồn tại.", 400),
    apiError("Không tìm thấy khoản chi.", 404),
    apiError("Trang đang dùng phiên bản cũ. Hãy tải lại trang rồi thử lại.", 409),
    apiError("Đã xảy ra lỗi máy chủ. Hãy thử lại; nếu vẫn tiếp diễn, liên hệ Admin.", 500),
    new Error("Lỗi khác"),
  ]) {
    const { queue, timers, calls } = setup();
    queue.update("e1", "payerId", "m1", 0);
    await timers.advance(0);
    calls[0].reject(failure);
    await settle();
    queue.retryNow();
    await timers.advance(60 * 60_000);
    assert.equal(calls.length, 1, failure.message);
    assert.deepEqual(queue.status(), { state: "error", message: failure.message });
  }
});

// Xóa có thể hoàn tác: dòng chờ xóa giữ thay đổi chưa lưu nhưng không gửi gì; hoàn tác thì lưu tiếp, xóa thật thì bỏ.
test("a suspended row (deleted, still undoable) keeps its unsaved values but sends nothing", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "amountVnd", -90000, 400);
  queue.update("e2", "description", "Phở", 400);
  assert.equal(queue.hasWork("e1"), true);
  await queue.suspend("e1");
  assert.equal(queue.hasWork("e1"), false);
  assert.equal(queue.busy("e1"), false);
  await timers.advance(1000);
  assert.deepEqual(calls.map((call) => call.id), ["e2"], "the debounce of the suspended row is stopped");
  calls[0].resolve({ expense: { id: "e2" } });
  await settle();
  assert.deepEqual(queue.status(), { state: "saved" }, "a suspended row does not count as unsaved");
  queue.saveAllNow();
  queue.saveAllForUnload();
  queue.retryNow();
  assert.equal(await queue.flush(), true);
  queue.schedule("e1", 0);
  assert.equal(timers.count, 0, "no timer is armed for a suspended row");
  await timers.advance(0);
  assert.equal(calls.length, 1, "page hide, unload, retry, flush and schedule send nothing for it");
  queue.retain(new Set(["e2"]));
  assert.deepEqual(queue.get("e1").pending, { amountVnd: -90000 }, "a re-render keeps it");
  assert.equal(await queue.discard("e1"), null);
  assert.equal(queue.get("e1"), null);
});

test("resuming a suspended row saves its kept values once", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "amountVnd", -90000, 400);
  queue.toggleParticipant("e1", "m1", true, 100);
  queue.suspend("e1");
  await timers.advance(1000);
  assert.equal(calls.length, 0);
  queue.resume("e1");
  assert.equal(queue.status().state, "pending");
  await timers.advance(0);
  assert.deepEqual(calls.map((call) => call.body), [{ amountVnd: -90000, participantChanges: { add: ["m1"], remove: [] } }]);
  queue.resume("e1");
  calls[0].resolve({ expense: { id: "e1" } });
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(queue.status().state, "saved");
  queue.suspend("unknown");
  queue.resume("unknown");
  queue.suspend("e1");
  queue.resume("e1");
  assert.equal(queue.get("e1"), null, "nothing kept: resume forgets the row");
});

test("a PUT running when the row is suspended finishes, but its follow-up waits for resume", async () => {
  const { queue, timers, calls, saved } = setup();
  queue.update("e1", "description", "A", 0);
  await timers.advance(0);
  queue.update("e1", "description", "AB", 400);
  const inFlight = queue.suspend("e1");
  calls[0].resolve({ expense: { id: "e1", description: "A" } });
  assert.deepEqual(await inFlight, { expense: { id: "e1", description: "A" } });
  await settle();
  assert.equal(saved().length, 1, "the page still hears about the finished PUT");
  await timers.advance(1000);
  assert.equal(calls.length, 1, "no follow-up PUT while suspended");
  queue.resume("e1");
  await timers.advance(0);
  assert.deepEqual(calls[1].body, { description: "AB" });
});

test("a PUT failure while suspended is not retried until resume", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 0);
  await timers.advance(0);
  queue.suspend("e1");
  calls[0].reject(apiError("offline", 0));
  await settle();
  assert.equal(timers.count, 0, "no retry is scheduled while suspended");
  await timers.advance(60_000);
  assert.equal(calls.length, 1);
  assert.deepEqual(queue.status(), { state: "saved" });
  queue.resume("e1");
  await timers.advance(0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { description: "A" });
});

test("onSaved tells which fields and ticks the save carried", async () => {
  const sent = [];
  const { queue, timers, calls } = setup({ onSaved: (id, response, details) => sent.push(details.sent) });
  queue.update("e1", "amountVnd", 5000, 0);
  queue.toggleParticipant("e1", "m2", false, 0);
  await timers.advance(0);
  queue.update("e1", "amountVnd", 6000, 400);
  calls[0].resolve({ expense: { id: "e1" } });
  await settle();
  assert.deepEqual(sent.map(({ fields, toggles }) => [fields, [...toggles]]), [[{ amountVnd: 5000 }, [["m2", false]]]]);
  assert.equal(queue.busy("e1"), true, "the newer amount still waits");
});

test("P6-0d: typing during an in-flight PUT gives one PUT after the debounce, not one per completion", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "amountVnd", 3000, 400);
  await timers.advance(400);
  assert.deepEqual(calls.map((call) => call.body), [{ amountVnd: 3000 }]);
  // "3" was saved; the user keeps typing "36" while the PUT is out, so the 400 ms debounce restarts.
  queue.update("e1", "amountVnd", 36000, 400);
  await timers.advance(50);
  calls[0].resolve({ expense: { id: "e1", amountVnd: 3000 } });
  await settle();
  assert.equal(calls.length, 1, "the partial value is not sent the moment the first PUT completes");
  queue.update("e1", "amountVnd", 360500, 400);
  await timers.advance(399);
  assert.equal(calls.length, 1, "still typing: nothing sent before the debounce ends");
  await timers.advance(1);
  assert.deepEqual(calls.map((call) => call.body), [{ amountVnd: 3000 }, { amountVnd: 360500 }]);
  calls[1].resolve({ expense: { id: "e1", amountVnd: 360500 } });
  await settle();
  assert.equal(queue.status().state, "saved");
});

test("P6-0d: leaving the cell or a flush during the flight still saves right after it", async () => {
  const { queue, timers, calls } = setup();
  queue.update("e1", "description", "A", 400);
  await timers.advance(400);
  queue.update("e1", "description", "AB", 400);
  // Focus leaves the cell: expenses.js reschedules the row with no delay; the timer fires during the flight.
  queue.schedule("e1", 0);
  await timers.advance(0);
  calls[0].resolve({ expense: { id: "e1", description: "A" } });
  await settle();
  assert.deepEqual(calls.map((call) => call.body), [{ description: "A" }, { description: "AB" }]);
  calls[1].resolve({ expense: { id: "e1", description: "AB" } });
  await settle();

  queue.update("e2", "description", "X", 400);
  await timers.advance(400);
  queue.update("e2", "description", "XY", 400);
  const flushed = queue.flush();
  calls[2].resolve({ expense: { id: "e2", description: "X" } });
  await settle();
  assert.deepEqual(calls[3]?.body, { description: "XY" }, "flush sends the newer value right after the flight");
  assert.equal(timers.count, 0, "the debounce timer is not left behind");
  calls[3].resolve({ expense: { id: "e2", description: "XY" } });
  assert.equal(await flushed, true);
  assert.equal(queue.status().state, "saved");
});

test("a suspended row with an unparsable amount does not block flush", async () => {
  const { queue } = setup();
  queue.rejectField("e1", "amountVnd", "Nhập chi phí bằng nghìn đồng.");
  queue.suspend("e1");
  assert.equal(await queue.flush(), true, "a row waiting to be deleted is not the user's unsaved work");
  assert.deepEqual(queue.status(), { state: "saved" });
  queue.resume("e1");
  assert.equal(await queue.flush(), false, "back in the table, the invalid amount blocks again");
});
