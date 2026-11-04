// Không nhận được phản hồi (status 0) hoặc 502/503/504: tự thử lại sau 2, 5, 15, 30 s, tối đa 4 lần mỗi đợt lỗi.
const RETRY_DELAYS = [2000, 5000, 15000, 30000];
const TRANSIENT_STATUSES = new Set([0, 502, 503, 504]);
// 429: dừng mọi lần lưu tới hết Retry-After cộng 0–3 s ngẫu nhiên (các máy không gửi lại cùng lúc).
const RETRY_JITTER = 3000;
const DEFAULT_RETRY_AFTER = 60;

// Hàng đợi tự lưu khoản chi, khóa theo id khoản chi (không giữ phần tử DOM).
// Không phụ thuộc DOM: hàm gửi, hẹn giờ, trạng thái hiển thị của trang và số ngẫu nhiên được truyền vào
// để kiểm thử bằng node:test.
export function createSaveQueue({
  send,
  onSaved = () => {},
  onFailed = () => {},
  onChange = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  isVisible = () => true,
  random = Math.random,
}) {
  const entries = new Map();
  let errorSequence = 0;
  let pauseTimer = null;

  function entryFor(id) {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        pending: {},
        participantToggles: new Map(),
        timer: null,
        inFlight: null,
        inFlightRequest: null,
        unloadRequest: null,
        rerun: false,
        rerunKeepalive: false,
        error: null,
        fieldError: null,
        errorOrder: 0,
        retries: 0,
        // Đang chờ lượt tự thử lại: đã hẹn giờ, hoặc tới hạn khi trang đang ẩn.
        retryWaiting: false,
        // Lần lưu gần nhất lỗi mạng hoặc 502/503/504: `online`/trang hiện lại thử lại cả khi đã hết lượt.
        transientFailure: false,
        // Lần lưu tới hạn trong lúc dừng sau 429 (hoặc chính lần bị 429): gửi khi hết thời gian chờ.
        heldByPause: false,
        // Dòng đang chờ xóa (còn hoàn tác được): giữ thay đổi chưa lưu nhưng không gửi gì, cho tới resume/discard.
        suspended: false,
      };
      entries.set(id, entry);
    }
    return entry;
  }

  function hasPending(entry) {
    return Object.keys(entry.pending).length > 0 || entry.participantToggles.size > 0;
  }

  function stopTimer(entry) {
    if (entry.timer === null) return;
    clearTimer(entry.timer);
    entry.timer = null;
  }

  function forgetIfIdle(id, entry) {
    if (entries.get(id) === entry && !hasPending(entry) && entry.timer === null && !entry.inFlight &&
        entry.error === null && entry.fieldError === null) {
      entries.delete(id);
    }
  }

  function setError(entry, message) {
    entry.error = message;
    entry.errorOrder = ++errorSequence;
  }

  function snapshot(entry) {
    const fields = { ...entry.pending };
    const toggles = new Map(entry.participantToggles);
    if (Object.keys(fields).length === 0 && toggles.size === 0) return null;
    const body = { ...fields };
    if (toggles.size) {
      const changes = [...toggles];
      body.participantChanges = {
        add: changes.filter(([, checked]) => checked).map(([memberId]) => memberId),
        remove: changes.filter(([, checked]) => !checked).map(([memberId]) => memberId),
      };
    }
    return { body, fields, toggles };
  }

  function sameRequest(left, right) {
    const fields = Object.keys(left.fields);
    return fields.length === Object.keys(right.fields).length &&
      fields.every((field) => Object.hasOwn(right.fields, field) && Object.is(left.fields[field], right.fields[field])) &&
      left.toggles.size === right.toggles.size &&
      [...left.toggles].every(([memberId, checked]) => right.toggles.get(memberId) === checked);
  }

  // Một PUT keepalive (vẫn tới máy chủ dù trang đã đóng) đang mang đúng các giá trị này: không gửi trùng.
  function carriedByKeepalive(entry, request) {
    return Boolean((entry.inFlightRequest?.keepalive && sameRequest(entry.inFlightRequest, request)) ||
      (entry.unloadRequest && sameRequest(entry.unloadRequest, request)));
  }

  // Chỉ bỏ những giá trị đã gửi mà người dùng chưa sửa tiếp trong lúc chờ phản hồi.
  function acknowledge(entry, request) {
    for (const [field, value] of Object.entries(request.fields)) {
      if (Object.hasOwn(entry.pending, field) && Object.is(entry.pending[field], value)) delete entry.pending[field];
    }
    for (const [memberId, checked] of request.toggles) {
      if (entry.participantToggles.get(memberId) === checked) entry.participantToggles.delete(memberId);
    }
  }

  // sent: các trường và tick vừa được lưu ({ fields, toggles }), để trang biết lần lưu này đổi những gì.
  function savedDetails(entry, request, extra) {
    return {
      pending: entry.pending,
      participantToggles: entry.participantToggles,
      fieldError: entry.fieldError,
      sent: { fields: request.fields, toggles: request.toggles },
      ...extra,
    };
  }

  function update(id, field, value, delay) {
    const entry = entryFor(id);
    entry.pending[field] = value;
    entry.error = null;
    if (entry.fieldError?.field === field) entry.fieldError = null;
    schedule(id, delay);
  }

  function toggleParticipant(id, memberId, checked, delay) {
    const entry = entryFor(id);
    entry.participantToggles.set(memberId, checked);
    entry.error = null;
    schedule(id, delay);
  }

  // Giá trị gõ chưa hợp lệ: không gửi trường đó và coi như lỗi của dòng cho tới khi sửa lại.
  function rejectField(id, field, message) {
    const entry = entryFor(id);
    delete entry.pending[field];
    entry.fieldError = { field, message };
    entry.errorOrder = ++errorSequence;
    onChange();
  }

  // Người dùng sửa hoặc rời ô: lưu theo lịch mới và bắt đầu lại số lần tự thử lại.
  function schedule(id, delay) {
    const entry = entries.get(id);
    if (!entry) return;
    stopTimer(entry);
    entry.retries = 0;
    entry.retryWaiting = false;
    if (!entry.suspended) {
      entry.timer = setTimer(() => {
        entry.timer = null;
        void save(id);
      }, delay);
    }
    onChange();
  }

  function save(id, { keepalive = false } = {}) {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(null);
    if (entry.suspended) return entry.inFlight ?? Promise.resolve(null);
    if (entry.inFlight) {
      entry.rerun = true;
      return entry.inFlight;
    }
    stopTimer(entry);
    const request = snapshot(entry);
    if (!request) {
      forgetIfIdle(id, entry);
      onChange();
      return Promise.resolve(null);
    }
    // PUT keepalive của pagehide đang mang đúng các giá trị này: chờ nó thay vì gửi trùng.
    if (entry.unloadRequest && sameRequest(entry.unloadRequest, request)) return entry.unloadRequest.done;
    // Đang dừng sau 429: giữ thay đổi, hết thời gian chờ sẽ gửi gộp một lần.
    if (pauseTimer !== null) {
      entry.heldByPause = true;
      entry.retryWaiting = false;
      onChange();
      return Promise.resolve(null);
    }
    entry.rerun = false;
    entry.rerunKeepalive = false;
    entry.retryWaiting = false;
    entry.transientFailure = false;
    entry.heldByPause = false;
    entry.inFlightRequest = { ...request, keepalive };
    entry.inFlight = run(id, entry, request, keepalive);
    onChange();
    return entry.inFlight;
  }

  async function run(id, entry, request, keepalive) {
    let response = null;
    let failure = null;
    try {
      response = await send(id, request.body, { keepalive });
    } catch (caught) {
      failure = caught;
    }
    entry.inFlight = null;
    entry.inFlightRequest = null;
    // 429 dừng mọi dòng, kể cả khi dòng này vừa bị xóa.
    if (failure?.status === 429) pauseSaves(failure.retryAfter);
    // Khoản chi đã bị xóa hoặc không còn trong dữ liệu: bỏ qua kết quả đến muộn.
    if (entries.get(id) !== entry) return failure ? null : response;
    if (failure) {
      setError(entry, failure.message);
      onFailed(id, failure, { unloading: false });
      entry.transientFailure = TRANSIENT_STATUSES.has(failure.status);
      if (failure.status === 429) entry.heldByPause = true;
      if (entry.rerun) void save(id, { keepalive: entry.rerunKeepalive });
      else if (entry.transientFailure) scheduleRetry(id, entry);
    } else {
      acknowledge(entry, request);
      entry.error = null;
      entry.retries = 0;
      const settled = !hasPending(entry) && entry.timer === null && !entry.rerun;
      onSaved(id, response, savedDetails(entry, request, { settled, unloading: false }));
      // Người dùng còn đang gõ (hẹn lưu chưa tới): chờ hẹn đó, không lưu giá trị gõ dở. Gửi ngay chỉ khi đã có lệnh
      // lưu trong lúc chờ phản hồi (hẹn đã tới, rời ô, flush, trang ẩn) hoặc thay đổi không có hẹn nào.
      if (hasPending(entry) && (entry.rerun || entry.timer === null)) void save(id, { keepalive: entry.rerunKeepalive });
    }
    forgetIfIdle(id, entry);
    onChange();
    return failure ? null : response;
  }

  // Hết lượt tự thử lại thì giữ trạng thái lỗi tới khi người dùng sửa hoặc rời ô (schedule).
  function scheduleRetry(id, entry) {
    if (entry.suspended || entry.timer !== null || entry.retries >= RETRY_DELAYS.length) return;
    entry.retryWaiting = true;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (isVisible()) retry(id, entry);
    }, RETRY_DELAYS[entry.retries]);
  }

  // Lượt bị hoãn vì đang dừng sau 429 vẫn được tính: nó được gửi khi hết thời gian chờ.
  function retry(id, entry) {
    entry.retries += 1;
    void save(id);
  }

  // `online` hoặc trang hiện lại: gửi ngay một lần các dòng lỗi mạng/máy chủ tạm thời. Dòng đang chờ tự thử lại
  // (kể cả lượt bị hoãn khi trang ẩn) dùng một lượt; dòng đã hết lượt được thử thêm một lần, không hẹn lại.
  function retryNow() {
    if (!isVisible()) return;
    for (const [id, entry] of entries) {
      if (entry.suspended) continue;
      if (entry.retryWaiting) {
        stopTimer(entry);
        retry(id, entry);
      } else if (entry.transientFailure && entry.timer === null && !entry.inFlight) {
        void save(id);
      }
    }
  }

  function pauseSaves(retryAfter) {
    const seconds = Number.isFinite(retryAfter) ? retryAfter : DEFAULT_RETRY_AFTER;
    if (pauseTimer !== null) clearTimer(pauseTimer);
    pauseTimer = setTimer(resumeSaves, seconds * 1000 + random() * RETRY_JITTER);
  }

  // Hết thời gian chờ: mỗi khoản chi có lần lưu bị hoãn gửi một PUT gộp (vẫn chỉ một PUT đang chạy cho mỗi id).
  // Dòng lỗi vì lý do khác (4xx, 500, hết lượt tự thử lại) vẫn chờ người dùng như khi không dừng.
  function resumeSaves() {
    pauseTimer = null;
    for (const [id, entry] of entries) {
      if (entry.heldByPause && entry.timer === null && !entry.suspended) void save(id);
    }
    onChange();
  }

  // visibilitychange → hidden: lưu ngay (fetch keepalive) các dòng chưa có PUT đang chạy;
  // dòng đang chạy sẽ tự lưu tiếp phần còn lại bằng keepalive khi PUT hiện tại xong.
  function saveAllNow() {
    for (const [id, entry] of entries) {
      if (entry.suspended) continue;
      if (entry.inFlight) {
        stopTimer(entry);
        entry.rerunKeepalive = true;
      } else if (entry.timer !== null || hasPending(entry)) {
        void save(id, { keepalive: true });
      }
    }
  }

  // pagehide: mỗi dòng còn thay đổi gửi đúng một PUT keepalive với giá trị mới nhất, kể cả dòng đang chạy
  // (fetch thường bị hủy khi rời trang). Không cập nhật giao diện và không hẹn lưu lại.
  function saveAllForUnload() {
    for (const [id, entry] of entries) {
      if (entry.suspended) continue;
      stopTimer(entry);
      const request = snapshot(entry);
      if (!request || carriedByKeepalive(entry, request)) continue;
      const unload = { ...request, done: null };
      entry.unloadRequest = unload;
      unload.done = send(id, request.body, { keepalive: true }).then((response) => {
        if (entry.unloadRequest === unload) entry.unloadRequest = null;
        if (entries.get(id) !== entry) return null;
        acknowledge(entry, request);
        entry.error = null;
        onSaved(id, response, savedDetails(entry, request, { settled: false, unloading: true }));
        forgetIfIdle(id, entry);
        return response;
      }, (caught) => {
        if (entry.unloadRequest === unload) entry.unloadRequest = null;
        if (entries.get(id) !== entry) return null;
        setError(entry, caught.message);
        onFailed(id, caught, { unloading: true });
        return null;
      });
    }
  }

  // Các lần lưu cần chờ (bắt đầu ngay những dòng chưa chạy); null nếu còn dòng lưu lỗi, ô nhập sai hoặc
  // thay đổi chưa gửi được vì đang dừng sau 429.
  function startPendingSaves() {
    const waits = [];
    for (const [id, entry] of entries) {
      if (entry.suspended) continue;
      if (entry.fieldError !== null) return null;
      if (!entry.inFlight && entry.timer === null && !hasPending(entry)) continue;
      if (entry.error !== null || (pauseTimer !== null && !entry.inFlight)) return null;
      waits.push(entry.inFlight ?? save(id));
    }
    return waits;
  }

  // Chờ lưu xong mọi thay đổi; trả về false nếu còn dòng chưa lưu được (người dùng cần xử lý trước).
  async function flush() {
    let waits = startPendingSaves();
    while (waits?.length) {
      await Promise.all(waits);
      waits = startPendingSaves();
    }
    return waits !== null;
  }

  // Bỏ hẳn thay đổi của một dòng (xóa khoản chi); trả về PUT đang chạy (nếu có) để chờ nó xong.
  function discard(id) {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(null);
    stopTimer(entry);
    entries.delete(id);
    onChange();
    return entry.inFlight ?? Promise.resolve(null);
  }

  // Dòng vừa bị xóa nhưng còn hoàn tác được: không gửi gì nữa (kể cả khi trang ẩn, flush, hết dừng sau 429) và
  // không tính vào trạng thái lưu; thay đổi chưa lưu vẫn giữ. PUT đang chạy (trả về) vẫn chạy tiếp.
  function suspend(id) {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(null);
    stopTimer(entry);
    entry.suspended = true;
    entry.retryWaiting = false;
    onChange();
    return entry.inFlight ?? Promise.resolve(null);
  }

  // Hoàn tác xóa: lưu tiếp thay đổi còn giữ (sau PUT đang chạy, nếu có).
  function resume(id) {
    const entry = entries.get(id);
    if (!entry?.suspended) return;
    entry.suspended = false;
    if (hasPending(entry)) {
      if (entry.inFlight) entry.rerun = true;
      else schedule(id, 0);
    } else {
      forgetIfIdle(id, entry);
    }
    onChange();
  }

  function retain(ids) {
    let changed = false;
    for (const [id, entry] of entries) {
      if (ids.has(id) || entry.suspended) continue;
      stopTimer(entry);
      entries.delete(id);
      changed = true;
    }
    if (changed) onChange();
  }

  // Thành viên đã bị xóa: bỏ tick và người chi đang chờ lưu trỏ tới họ (máy chủ sẽ từ chối cả lần lưu),
  // rồi lưu ngay phần còn lại của dòng.
  function retainMembers(memberIds) {
    let changed = false;
    for (const [id, entry] of entries) {
      let pruned = false;
      for (const memberId of [...entry.participantToggles.keys()]) {
        if (memberIds.has(memberId)) continue;
        entry.participantToggles.delete(memberId);
        pruned = true;
      }
      const payerId = entry.pending.payerId;
      if (payerId !== undefined && payerId !== null && !memberIds.has(payerId)) {
        delete entry.pending.payerId;
        pruned = true;
      }
      if (!pruned) continue;
      changed = true;
      entry.error = null;
      if (entry.inFlight) entry.rerun = true;
      else if (hasPending(entry) && entry.timer === null) schedule(id, 0);
      else forgetIfIdle(id, entry);
    }
    if (changed) onChange();
  }

  function hasWork(id) {
    const entry = entries.get(id);
    return Boolean(entry && !entry.suspended && (entry.timer !== null || hasPending(entry)));
  }

  // Dòng còn thay đổi chưa lưu, đang chờ gửi hoặc có PUT đang chạy (dòng đang chờ xóa không tính).
  function busy(id) {
    const entry = entries.get(id);
    return Boolean(entry && !entry.suspended && (entry.inFlight || entry.timer !== null || hasPending(entry)));
  }

  function status() {
    let message = null;
    let messageOrder = -1;
    let saving = false;
    let pending = false;
    for (const entry of entries.values()) {
      if (entry.suspended) continue;
      const entryMessage = entry.fieldError ? entry.fieldError.message : entry.error;
      if (entryMessage !== null && entry.errorOrder > messageOrder) {
        message = entryMessage;
        messageOrder = entry.errorOrder;
      }
      if (entry.inFlight) saving = true;
      if (entry.timer !== null || hasPending(entry)) pending = true;
    }
    if (message !== null) return { state: "error", message };
    return { state: saving ? "saving" : pending ? "pending" : "saved" };
  }

  return {
    update,
    toggleParticipant,
    rejectField,
    schedule,
    saveAllNow,
    saveAllForUnload,
    retryNow,
    flush,
    discard,
    suspend,
    resume,
    retain,
    retainMembers,
    hasWork,
    busy,
    get: (id) => entries.get(id) ?? null,
    status,
  };
}
