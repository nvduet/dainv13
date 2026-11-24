// Nút "Hoàn tác" / "Làm lại", Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z): lịch sử thay đổi khoản chi và chuyển khoản của sổ đang mở.
// Mỗi lần lưu thành công ghi lại giá trị trước của các trường vừa đổi. Hoàn tác đặt lại giá trị đó qua hàng đợi tự lưu
// như khi người dùng gõ; chỉ báo "Đã hoàn tác" khi máy chủ đã lưu. Trường đã bị người khác (thiết bị khác) đổi tiếp
// thì bỏ qua và báo không hoàn tác được. Hoàn tác "Thêm dòng" (hay nhân bản) là xóa dòng đó, có thông báo "Hoàn tác";
// hoàn tác một lần xóa đã gửi tạo lại dòng với giá trị cũ ở chỗ cũ (làm lại thì xóa lại).
// Tổng "Đã chuyển khoản" của Summary (ô của Admin, nút Done) dùng chung lịch sử: hoàn tác đặt lại tổng trước đó qua
// chính ô đó (summary.js).
// Lịch sử được lưu trên thiết bị theo sổ sau mỗi thay đổi (history-store.js, tối đa 50 bước mỗi ngăn), nên vẫn hoàn tác
// được thay đổi của lần mở trang trước; các tab cùng sổ trên máy dùng chung một lịch sử (sự kiện "storage"). Lịch sử
// ghi id của sổ: sổ bị xóa rồi tạo lại cùng tên (cùng slug) không nhận lịch sử của sổ cũ.
import {
  applyHistoryValues,
  deleteInProgress,
  expenseDescription,
  expenseHasQueuedWork,
  expenseIsKnown,
  expenseWorkUnsettled,
  hasPendingDelete,
  readSavedExpense,
  recreateExpense,
  removedExpenseSnapshot,
  removeExpenseWithUndo,
  restoreDeletedExpense,
  settleExpenseWork,
} from "./expenses.js";
import {
  browserStorage,
  forgetStoredHistory,
  historyStorageKey,
  parseStoredHistory,
  readStoredHistory,
  writeStoredHistory,
} from "./history-store.js";
import { state } from "./state.js";
import { currentTransferTotal, flushTransferInputs, setTransferTotal, transferWorkUnsettled, watchTransferSaves } from "./summary.js";
import { showNotice } from "./ui.js";
import {
  createUndoHistory,
  DELETE_SETTLE_MS,
  describeEntry,
  diffSavedExpense,
  planHistoryStep,
  planTransferStep,
  stacksToStore,
} from "./undo-history.js";

// Mã của trang này: mục do trang khác ghi (tab khác, lần mở trước) được nhận ra.
const PAGE_ID = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const history = createUndoHistory({ origin: PAGE_ID, onChange: historyChanged });
// Tổng chuyển khoản do hoàn tác/làm lại đặt, theo id thành viên: { entry, direction, amountVnd }. Lưu xong đúng tổng đó
// thì báo hoàn tác/làm lại, không ghi thành thay đổi mới.
const pendingTransfers = new Map();
// Giá trị do hoàn tác/làm lại (hoặc lần điền bản sao vừa nhân bản) đặt vào một dòng, theo id khoản chi:
// { entry, direction, skipped, fields: Map(trường → giá trị), toggles: Map(memberId → tick), failed }.
// Lưu xong đúng các giá trị đó thì không ghi thành thay đổi mới; hoàn tác/làm lại khi đó mới được báo thành công.
const pendingWrites = new Map();
// Dòng đã xóa hẳn đang được tạo lại (chờ POST): { entry, direction }.
const recreations = new Set();
// Mục tạo lại dòng mà dòng còn đang chờ xóa ở một tab khác (thông báo 6 giây của tab đó): chỉ tab đó hoàn tác được,
// trong khoảng này kể từ lúc mục được ghi (quá hạn: tab đó đã đóng mà không gửi DELETE).
const PENDING_ELSEWHERE_MS = DELETE_SETTLE_MS;
// Mỗi lần focus một ô của bảng là một "phiên gõ": các lần lưu cùng một ô trong một phiên gộp thành một mục.
let focusSession = 0;
const editSessions = new Map();
let stepping = false;
const APPLE = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "");
const UNDO_KEY = APPLE ? "⌘Z" : "Ctrl+Z";
// Sổ đã đọc lịch sử đã lưu (slug và id; null: chưa tải dữ liệu lần nào), bộ nhớ của trình duyệt (null: bị chặn, lịch
// sử chỉ còn trong trang), lúc gửi GET /api/state của lần tải dữ liệu gần nhất và hàm tải lại dữ liệu (admin.js, gắn ở
// app.js).
let historySlug = null;
let historyLedger = null;
let storage = null;
let persistQueued = false;
let stateLoadedAt = -Infinity;
let refreshState = null;

const memberName = (id) => state.members.find((member) => member.id === id)?.name ?? null;
const describe = (entry, options = {}) => describeEntry(entry, {
  description: expenseDescription(entry.expenseId) ?? entry.snapshot?.description ?? entry.label,
  memberName,
  ...options,
});

function historyChanged() {
  queuePersist();
  refreshHistoryButtons();
}

// Bước đã lấy khỏi ngăn và đang chờ máy chủ: { entry, direction }.
function stepsInFlight() {
  return [
    ...[...pendingWrites.values()].filter((write) => write.entry),
    ...pendingTransfers.values(),
    ...recreations,
  ];
}

// Ghi lịch sử của sổ vào bộ nhớ của trình duyệt. Bước đang chờ máy chủ được ghi lại vào ngăn của nó: đóng trang giữa
// chừng không mất bước đó (lần mở sau, quy tắc "dữ liệu đã thay đổi" quyết định).
function persistHistory() {
  persistQueued = false;
  if (historySlug === null) return;
  writeStoredHistory(storage, historySlug, stacksToStore(history.entries(), stepsInFlight()), { ledger: historyLedger });
}

// Nhiều thay đổi liên tiếp (lấy một mục rồi đánh dấu nó đang chờ) chỉ ghi một lần.
function queuePersist() {
  if (persistQueued || historySlug === null) return;
  persistQueued = true;
  queueMicrotask(persistHistory);
}

// Lịch sử từ bộ nhớ (lần mở trang, tab khác vừa ghi). Bước trang này đang chờ máy chủ không lấy lại; session chỉ giữ
// cho mục của chính trang này.
function adoptStoredHistory({ undo, redo }) {
  const flying = new Set(stepsInFlight().map(({ entry }) => entry.id));
  const current = history.entries();
  const sessions = new Map([...current.undo, ...current.redo].map((entry) => [entry.id, entry.session]));
  const adopt = (entries) => entries.filter((entry) => !flying.has(entry.id)).map((entry) =>
    (entry.origin === PAGE_ID ? { ...entry, session: sessions.get(entry.id) ?? null } : entry));
  history.replace({ undo: adopt(undo), redo: adopt(redo) });
}

function handleStoredHistory(event) {
  if (historySlug === null || (event.key !== null && event.key !== historyStorageKey(historySlug))) return;
  if (storage && event.storageArea && event.storageArea !== storage) return;
  const stored = event.newValue ? parseStoredHistory(event.newValue, { ledger: historyLedger }) : { undo: [], redo: [] };
  // Lịch sử một tab khác ghi cho sổ khác cùng slug (tab còn mở sổ cũ đã bị xóa): không phải của sổ này.
  if (stored.foreign) return;
  adoptStoredHistory(stored);
  refreshHistoryButtons();
}

// Gọi một lần lúc khởi động (app.js): theo dõi lịch sử tab khác ghi; refresh() tải lại dữ liệu trước khi áp một bước
// do tab khác ghi sau lần tải gần nhất của trang này (bước đó có thể dựa trên dữ liệu trang chưa có).
export function watchStoredHistory(refresh) {
  refreshState = refresh;
  globalThis.addEventListener?.("storage", handleStoredHistory);
}

// Dữ liệu vừa tải và hợp nhất (expenses.js, sau GET /api/state gửi lúc loadedAt). Lần đầu: đọc lịch sử đã lưu của sổ
// (của sổ cũ cùng slug thì bỏ). Sổ đang mở đổi id (bị xóa rồi tạo lại cùng tên trong lúc trang mở): lịch sử trong trang
// là của sổ cũ, bỏ hết. Mỗi lần: bỏ các mục không còn áp được (pruneHistory).
export function syncHistoryWithState({ loadedAt = Date.now(), expenseIds, deletingIds }) {
  const slug = state.ledger?.slug;
  if (!slug) return;
  const ledger = state.ledger.id ?? null;
  if (historySlug !== slug || historyLedger !== ledger) {
    if (historySlug === slug) forgetPageHistory();
    historySlug = slug;
    historyLedger = ledger;
    storage = browserStorage();
    const stored = readStoredHistory(storage, slug, { ledger });
    if (stored) adoptStoredHistory(stored);
  }
  stateLoadedAt = Math.max(stateLoadedAt, loadedAt);
  // Dòng đang được tạo lại (POST chưa trả lời): các bước của nó vẫn còn dùng được dù lần tải này chưa thấy dòng.
  const recreatingIds = new Set([...recreations].map(({ entry }) => entry.expenseId));
  history.prune({ expenseIds, memberIds: new Set(state.members.map((member) => member.id)), deletingIds, recreatingIds, loadedAt });
  refreshHistoryButtons();
}

// Lịch sử trong trang (kể cả bước đang chờ máy chủ: kết quả của chúng không còn được ghi vào lịch sử).
function forgetPageHistory() {
  pendingWrites.clear();
  pendingTransfers.clear();
  recreations.clear();
  history.replace({ undo: [], redo: [] });
}

// Quên lịch sử đã lưu của một sổ (gọi sau khi xóa sổ). Sổ đang mở thì trang cũng thôi ghi lịch sử của nó.
export function forgetLedgerHistory(slug) {
  forgetStoredHistory(storage ?? browserStorage(), slug);
  if (slug !== historySlug) return;
  historySlug = null;
  historyLedger = null;
  forgetPageHistory();
  refreshHistoryButtons();
}

// Ghi ngay (trang sắp đóng: không chờ tới cuối lượt xử lý).
export function flushHistory() {
  if (persistQueued) persistHistory();
}

// Lời nhắc đọc cho trình đọc màn hình cùng thông báo có nút "Hoàn tác" (thông báo chỉ hiện vài giây).
export function undoShortcutHint() {
  return `Nhấn ${UNDO_KEY} để hoàn tác.`;
}

export function noteDetailFocus() {
  focusSession += 1;
}

// Người dùng vừa sửa một trường (memberId: tick người tham gia). Hoàn tác đang chờ lưu trường đó thì người dùng thắng:
// bỏ lần hoàn tác (không báo thành công cho giá trị đã bị thay).
export function noteUserEdit(id, field, memberId = null) {
  editSessions.set(`${id}\t${memberId ? "participants" : field}`, focusSession);
  const write = pendingWrites.get(id);
  if (!write) return;
  const touched = memberId ? write.toggles.delete(memberId) : write.fields.delete(field);
  if (touched && write.entry) {
    pendingWrites.delete(id);
    queuePersist();
    refreshHistoryButtons();
  }
}

// Một lần lưu thành công: before = khoản chi đã lưu trước đó, after = phản hồi của máy chủ, sent = { fields, toggles }
// vừa gửi. Trả về true nếu lần lưu này hoàn tất một lần hoàn tác/làm lại (đã báo, không cần "Đã lưu…").
export function recordExpenseSave(id, before, after, sent) {
  const write = pendingWrites.get(id);
  const { change, keys } = diffSavedExpense(id, before, after, sent, write);
  let confirmed = false;
  if (write && write.fields.size === 0 && write.toggles.size === 0) {
    pendingWrites.delete(id);
    confirmed = confirmWrite(write);
  }
  if (keys.length) {
    change.session = keys.length === 1 ? editSessions.get(`${id}\t${keys[0]}`) ?? null : null;
    history.record(change);
  } else {
    // Nội dung vừa lưu có thể là tên mà nút đang dùng để mô tả thay đổi (vd. bản sao vừa được điền).
    refreshHistoryButtons();
  }
  return confirmed;
}

export function noteSaveFailed(id) {
  const write = pendingWrites.get(id);
  if (write) write.failed = true;
}

// Dòng vừa thêm ("Add line" hoặc nhân bản) đã có trên máy chủ.
export function recordExpenseAdd(id, { duplicate = false } = {}) {
  history.record({ kind: "add", expenseId: id, duplicate, label: "" });
}

// Lần điền bản sao (PUT ngay sau POST của nút nhân bản): một phần của "Nhân bản", không phải thay đổi riêng.
export function markDuplicateFill(id, fields, participantIds) {
  pendingWrites.set(id, {
    entry: null,
    direction: null,
    skipped: false,
    fields: new Map(Object.entries(fields)),
    toggles: new Map(participantIds.map((memberId) => [memberId, true])),
    failed: false,
  });
}

// Nút × (hay "Hoàn tác" của bản sao): dòng vừa bị xóa, snapshot là dòng lúc đó (removeExpenseWithUndo).
export function recordExpenseDelete(id, label, snapshot) {
  history.record({ kind: "delete", expenseId: id, label, snapshot });
}

// Dòng chờ xóa được hiện lại ("Hoàn tác" của thông báo, DELETE lỗi): không còn gì để hoàn tác cho lần xóa đó; "Thêm
// dòng" đã hoàn tác (ngăn "Làm lại") thôi mang ảnh chụp (dòng đang có, không chờ xóa ở đâu cả).
export function forgetExpenseDelete(id) {
  history.remove((entry) => entry.kind === "delete" && entry.expenseId === id);
  history.update((entry) => entry.kind === "add" && entry.expenseId === id && Boolean(entry.snapshot), (entry) => {
    delete entry.snapshot;
    return true;
  });
}

// Ảnh chụp của dòng bị xóa ghi vào các mục tạo lại được dòng đó: mục xóa, và "Thêm dòng" đã hoàn tác (ngăn "Làm lại").
// Chỗ của một khoản chi trên máy chủ không đổi, nên chỗ đã biết được giữ. at đổi theo: tab khác thấy mục mới hơn lần
// tải dữ liệu của nó thì tải lại dữ liệu trước khi áp mục.
function markDeleted(id, values, { confirmed }) {
  const now = Date.now();
  history.update((entry, stack) => entry.expenseId === id && (entry.kind === "delete" || (entry.kind === "add" && stack === "redo")), (entry) => {
    const before = entry.snapshot ?? {};
    entry.snapshot = {
      ...before,
      ...values,
      position: values.position ?? before.position ?? null,
      deleted: true,
      sentAt: before.deleted && before.sentAt != null ? before.sentAt : now,
      confirmed,
    };
    entry.at = now;
    return true;
  });
}

// DELETE sắp gửi (hết thời gian hoàn tác, trang ẩn hay đóng): từ lúc này hoàn tác là tạo lại dòng, khi máy chủ đã xóa
// xong. Chưa có phản hồi (trang có thể đóng trước): lần tải dữ liệu còn thấy dòng trong DELETE_SETTLE_MS chưa có nghĩa
// là DELETE thất bại.
export function noteExpenseDeleting(id, values) {
  markDeleted(id, values, { confirmed: false });
}

// DELETE đã xong (máy chủ trả lời, kể cả 404): giữ các mục của dòng (hoàn tác tạo lại được dòng, các bước cũ hơn của nó
// dùng lại được).
export function noteExpenseDeleted(id, values) {
  markDeleted(id, values, { confirmed: true });
}

// Khoản chi không còn trên trang (tải lại dữ liệu): lần hoàn tác đang chờ lưu cho nó không bao giờ xong; các mục của nó
// được xét ở lần tải dữ liệu (syncHistoryWithState).
export function forgetExpenseWrites(id) {
  if (pendingWrites.delete(id)) queuePersist();
}

// Còn một lần hoàn tác/làm lại đang chờ máy chủ lưu (chưa lỗi): chưa làm bước tiếp theo.
function waitingForWrite() {
  for (const [id, write] of pendingWrites) {
    if (write.failed) continue;
    if (expenseHasQueuedWork(id)) return true;
    // Hàng đợi không còn gì để gửi cho dòng này (dòng đã bị bỏ, thành viên bị xóa…): lần ghi không bao giờ xong.
    pendingWrites.delete(id);
    queuePersist();
  }
  return false;
}

function confirmWrite(write) {
  if (!write.entry) return false;
  if (write.direction === "undo") history.pushRedo(write.entry);
  else history.pushUndo(write.entry);
  const verb = write.direction === "undo" ? "hoàn tác" : "làm lại";
  // Kết quả sau khi hoàn tác: giá trị cũ là giá trị hiện tại ("120 → 100"), không phải thay đổi vừa bỏ.
  const description = describe(write.entry, { inverse: write.direction === "undo" });
  showNotice(write.skipped
    ? `Đã ${verb} một phần: ${description}. Không thể ${verb} phần còn lại vì dữ liệu đã thay đổi.`
    : `Đã ${verb}: ${description}.`);
  return true;
}

function showConflict(direction) {
  showNotice(`Không thể ${direction === "undo" ? "hoàn tác" : "làm lại"} vì dữ liệu đã thay đổi.`, "error", 10000);
}

const putBack = (write) => (write.direction === "undo" ? history.pushUndo : history.pushRedo)(write.entry);

// Gọi một lần lúc khởi động (app.js), khi mọi module đã nạp: summary.js và module này import lẫn nhau.
export function watchTransferHistory() {
  watchTransferSaves({
    // Một tổng chuyển khoản đã lưu: của hoàn tác/làm lại thì báo; Admin gõ hay bấm Done thì thành một mục.
    saved(memberId, before, after, changed) {
      const write = pendingTransfers.get(memberId);
      pendingTransfers.delete(memberId);
      if (write) queuePersist();
      if (write?.amountVnd === after) return confirmWrite({ ...write, skipped: false });
      if (changed) history.record({ kind: "transfer", memberId, before, after, label: memberName(memberId) ?? "" });
      return false;
    },
    // Lưu lỗi: mục về ngăn cũ để thử lại sau.
    failed(memberId) {
      const write = pendingTransfers.get(memberId);
      if (!write) return;
      pendingTransfers.delete(memberId);
      putBack(write);
    },
    dirty: () => refreshHistoryButtons(),
  });
}

function stepTransfer(entry, direction) {
  const exists = state.members.some((member) => member.id === entry.memberId);
  const amountVnd = exists ? planTransferStep(entry, currentTransferTotal(entry.memberId), direction) : null;
  if (amountVnd === null) {
    showConflict(direction);
    return;
  }
  const write = { entry, direction, amountVnd };
  pendingTransfers.set(entry.memberId, write);
  if (!setTransferTotal(entry.memberId, amountVnd)) {
    pendingTransfers.delete(entry.memberId);
    putBack(write);
    showNotice("Chỉ Admin mới hoàn tác được thay đổi chuyển khoản. Hãy đăng nhập Admin.", "error");
  }
}

function stepEdit(entry, direction) {
  const current = readSavedExpense(entry.expenseId);
  const plan = current && planHistoryStep(entry, current, direction, new Set(state.members.map((member) => member.id)));
  if (!plan || plan.empty) {
    showConflict(direction);
    return;
  }
  pendingWrites.set(entry.expenseId, {
    entry: plan.applied,
    direction,
    skipped: plan.skipped > 0,
    fields: new Map(Object.entries(plan.fields)),
    toggles: new Map([...plan.add.map((memberId) => [memberId, true]), ...plan.remove.map((memberId) => [memberId, false])]),
    failed: false,
  });
  applyHistoryValues(entry.expenseId, plan);
}

// Xóa dòng khi hoàn tác "Thêm dòng" hay làm lại một lần xóa: thông báo "Đã xóa khoản chi." kèm "Hoàn tác", DELETE gửi
// sau; mục mang ảnh chụp của dòng để tạo lại được dòng khi DELETE đã gửi.
function removeForStep(entry) {
  void removeExpenseWithUndo(entry.expenseId, { record: false });
  entry.snapshot = removedExpenseSnapshot(entry.expenseId) ?? entry.snapshot;
}

// Tạo lại dòng đã xóa hẳn (hoàn tác lần xóa, làm lại "Thêm dòng"/nhân bản): một POST với id, giá trị và chỗ cũ của dòng
// (expenses.js). Gửi lại cũng không thành hai dòng, nên trong lúc chờ, mục vẫn được ghi lại vào ngăn của nó (tab khác,
// lần mở sau làm lại được). Chỉ báo thành công khi máy chủ đã trả lời (dòng đã có từ trước cũng là xong); thành viên đã
// bị xóa thì là hoàn tác một phần.
// attemptedAt: POST đã gửi. Phản hồi mất (mạng rớt, trang đóng) mà dòng đã có lại thì lần bấm sau thấy dòng và coi bước
// là xong (step()), thay vì báo "dữ liệu đã thay đổi".
function recreateRow(entry, direction) {
  const flight = { entry, direction };
  entry.snapshot = { ...entry.snapshot, attemptedAt: Date.now() };
  recreations.add(flight);
  queuePersist();
  recreateExpense(entry.expenseId, entry.snapshot, {
    created(expense, { skipped }) {
      // Lịch sử của trang đã bị bỏ trong lúc chờ (sổ được tạo lại cùng slug): kết quả không thuộc lịch sử mới.
      if (!recreations.delete(flight)) return;
      finishRecreated(entry, direction, skipped, expense.position);
    },
    failed(caught) {
      if (!recreations.delete(flight)) return;
      // Máy chủ từ chối hẳn (dữ liệu của bước không hợp lệ): bước không bao giờ áp được, bỏ đi để không chặn các bước
      // cũ hơn. Lỗi mạng, máy chủ bận, quá giới hạn: bước về ngăn cũ, thử lại sau.
      const refused = caught.status >= 400 && caught.status < 500 && ![408, 429].includes(caught.status);
      if (refused) queuePersist();
      else putBack(flight);
      showNotice(caught.message, "error");
    },
  });
}

// Dòng đã có lại trên máy chủ: bước sang ngăn kia; lần xóa tới ghi ảnh chụp mới.
function finishRecreated(entry, direction, skipped, position) {
  if (entry.kind === "delete") {
    const snapshot = { ...entry.snapshot };
    delete snapshot.attemptedAt;
    entry.snapshot = { ...snapshot, position: position ?? null, deleted: false, sentAt: null, confirmed: false };
  } else {
    delete entry.snapshot;
  }
  confirmWrite({ entry, direction, skipped });
}

// Hoàn tác "Thêm dòng" = xóa dòng (thông báo "Đã xóa khoản chi." kèm "Hoàn tác", DELETE gửi sau). Làm lại = hiện lại
// dòng đang chờ xóa, hoặc tạo lại dòng khi máy chủ đã xóa nó (step() đã loại trường hợp dòng còn chờ xóa ở tab khác hay
// DELETE chưa tới).
function stepAdd(entry, direction) {
  const id = entry.expenseId;
  if (direction === "undo") {
    if (!readSavedExpense(id)) {
      showConflict(direction);
      return;
    }
    removeForStep(entry);
    history.pushRedo(entry);
    return;
  }
  if (hasPendingDelete(id)) {
    restoreDeletedExpense(id);
    delete entry.snapshot;
    history.pushUndo(entry);
    if (!hasPendingDelete()) showNotice(`Đã làm lại: ${describe(entry)}.`);
  } else if (readSavedExpense(id)) {
    delete entry.snapshot;
    history.pushUndo(entry);
  } else if (entry.snapshot?.deleted && !expenseIsKnown(id)) {
    recreateRow(entry, direction);
  } else {
    showConflict(direction);
  }
}

// Hoàn tác một lần xóa: dòng còn chờ xóa thì hiện lại (không gọi máy chủ); máy chủ đã xóa thì tạo lại dòng (step() đã
// loại trường hợp dòng còn chờ xóa ở tab khác hay DELETE chưa tới). Mục sang ngăn "Làm lại": làm lại = xóa lại dòng
// (thông báo "Đã xóa khoản chi." kèm "Hoàn tác").
function stepDelete(entry, direction) {
  const id = entry.expenseId;
  if (direction === "redo") {
    if (!readSavedExpense(id)) {
      showConflict(direction);
      return;
    }
    removeForStep(entry);
    history.pushUndo(entry);
    return;
  }
  if (hasPendingDelete(id)) {
    const description = describe(entry);
    restoreDeletedExpense(id);
    history.pushRedo(entry);
    if (!hasPendingDelete()) showNotice(`Đã hoàn tác: ${description}.`);
  } else if (entry.snapshot?.deleted && !expenseIsKnown(id)) {
    recreateRow(entry, direction);
  } else {
    showConflict(direction);
  }
}

// Mục tạo lại dòng khi áp: xóa ở ngăn "Hoàn tác", "Thêm dòng"/nhân bản ở ngăn "Làm lại".
const recreatesRow = (entry, direction) => (entry.kind === "delete" && direction === "undo") || (entry.kind === "add" && direction === "redo");

// DELETE của dòng đã gửi mà chưa có phản hồi (trang khác gửi, hay trang vừa đóng/tải lại) trong khi trang vẫn còn dòng:
// có thể máy chủ đã xóa xong (dữ liệu trang cũ), hoặc DELETE chưa tới. Quá DELETE_SETTLE_MS sau lúc gửi mà dòng vẫn còn
// thì DELETE đã không tới (vd. gửi lúc đóng trang mà mất mạng): không chờ nữa.
function deleteUnconfirmed(entry, direction) {
  const snapshot = entry.snapshot;
  return recreatesRow(entry, direction) && Boolean(snapshot?.deleted) && !snapshot.confirmed &&
    snapshot.sentAt != null && Date.now() - snapshot.sentAt < DELETE_SETTLE_MS && expenseIsKnown(entry.expenseId);
}

// Dòng của mục còn chờ xóa ở một tab khác (thông báo 6 giây của tab đó, DELETE chưa gửi): chỉ tab đó hiện lại được dòng.
function pendingElsewhere(entry, direction) {
  return recreatesRow(entry, direction) && entry.origin !== PAGE_ID && Boolean(entry.snapshot) && !entry.snapshot.deleted &&
    !hasPendingDelete(entry.expenseId) && expenseIsKnown(entry.expenseId) && Date.now() - entry.at < PENDING_ELSEWHERE_MS;
}

function inHistory(id) {
  const { undo, redo } = history.entries();
  return undo.some((entry) => entry.id === id) || redo.some((entry) => entry.id === id);
}

async function step(direction) {
  if (stepping) return;
  stepping = true;
  try {
    // Thay đổi vừa gõ, dòng vừa thêm và lần hoàn tác trước phải lưu xong trước: chúng là thay đổi mới nhất.
    if (!(await settleExpenseWork()) || waitingForWrite()) {
      showNotice("Có thay đổi khoản chi chưa lưu. Hãy xử lý lỗi lưu trước khi tiếp tục.", "error");
      return;
    }
    try {
      await flushTransferInputs();
    } catch (caught) {
      showNotice(caught.message, "error");
      return;
    }
    const peek = () => (direction === "undo" ? history.peekUndo() : history.peekRedo());
    let next = peek();
    if (!next) return;
    // Dòng của bước đang được xóa (DELETE chờ PUT của dòng hay đang gửi): chờ máy chủ trả lời (cùng lần gửi đó). Xóa
    // xong thì bước tạo lại được dòng; bị từ chối thì dòng đã hiện lại kèm lỗi và mục xóa đã bị bỏ: dừng, không lấy một
    // bước khác thay cho bước nút vừa mô tả.
    const deleting = next.expenseId ? deleteInProgress(next.expenseId) : null;
    if (deleting) {
      await deleting;
      if (peek()?.id !== next.id) return;
      next = peek();
    }
    // Dữ liệu trang có thể cũ hơn bước: bước do tab khác ghi sau lần tải dữ liệu gần nhất của trang này, hay lần xóa đã
    // gửi mà máy chủ chưa xác nhận trong khi trang vẫn còn dòng. Tải lại trước, để không áp bước lên dữ liệu cũ (vd. báo
    // "dữ liệu đã thay đổi" sai). Lần tải có thể bỏ chính bước nút đã mô tả (không còn áp được: báo) hay tab khác vừa
    // đổi lịch sử (nút cập nhật theo, người dùng bấm lại): không bao giờ áp một bước khác thay cho nó.
    // Tạo lại một dòng (POST cùng id) cũng luôn tải lại trước: sổ có thể đã bị xóa rồi tạo lại cùng tên ở máy khác
    // (lịch sử của sổ cũ bị bỏ khi tải), hay dòng đã có lại.
    const recreating = recreatesRow(next, direction) && Boolean(next.snapshot?.deleted);
    if ((next.origin !== PAGE_ID && next.at > stateLoadedAt) || deleteUnconfirmed(next, direction) || recreating) {
      await refreshState?.();
      const top = peek();
      if (top?.id !== next.id) {
        if (!inHistory(next.id)) showConflict(direction);
        return;
      }
      next = top;
    }
    // Lần tạo lại trước của chính bước này đã gửi POST mà không nhận được trả lời, và dòng nay đã có: bước đã xong.
    const recreated = recreatesRow(next, direction) && next.snapshot?.attemptedAt != null ? readSavedExpense(next.expenseId) : null;
    if (recreated) {
      const entry = direction === "undo" ? history.takeUndo() : history.takeRedo();
      if (entry) finishRecreated(entry, direction, false, recreated.position);
      return;
    }
    if (pendingElsewhere(next, direction)) {
      showNotice(`Dòng này đang chờ xóa ở một cửa sổ khác. Hãy ${direction === "undo" ? "hoàn tác" : "làm lại"} ở cửa sổ đó.`, "error");
      return;
    }
    if (deleteUnconfirmed(next, direction)) {
      showNotice("Khoản chi đang được xóa. Hãy thử lại sau giây lát.", "error");
      return;
    }
    const entry = direction === "undo" ? history.takeUndo() : history.takeRedo();
    if (!entry) return;
    if (entry.kind === "edit") stepEdit(entry, direction);
    else if (entry.kind === "transfer") stepTransfer(entry, direction);
    else if (entry.kind === "add") stepAdd(entry, direction);
    else stepDelete(entry, direction);
  } finally {
    stepping = false;
    refreshHistoryButtons();
  }
}

export function undoLastChange() {
  return step("undo");
}

export function redoLastChange() {
  return step("redo");
}

// Ctrl+Z / ⌘Z: hoàn tác; Ctrl+Y, Ctrl+Shift+Z / ⌘⇧Z: làm lại (⌘Y là phím mở Lịch sử của trình duyệt trên macOS nên
// không bắt). Không làm gì khi đang mở hộp thoại hoặc khi focus ở ô nhập, ô chọn hay ô tick (hoàn tác sẵn có của trình
// duyệt trong ô nhập vẫn chạy).
export function handleHistoryShortcut(event) {
  if (event.defaultPrevented || event.altKey || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
  const letter = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : { KeyZ: "z", KeyY: "y" }[event.code];
  const undo = letter === "z" && !event.shiftKey;
  const redo = (letter === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) || (letter === "z" && event.shiftKey);
  if (!undo && !redo) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable]")) return;
  event.preventDefault();
  void (undo ? undoLastChange() : redoLastChange());
}

// Hoàn tác sẵn có của Chrome dùng chung cho cả trang: Ctrl+Z trong một ô (hoặc khi focus ở ô chọn, ô tick) có thể
// hoàn tác chữ đã gõ ở một ô khác, kể cả một dòng đang khuất, rồi ô đó tự lưu. Chỉ để nó hoàn tác trong chính ô đang
// được focus.
export function keepNativeUndoInField(event) {
  if ((event.inputType === "historyUndo" || event.inputType === "historyRedo") && event.target !== document.activeElement) {
    event.preventDefault();
  }
}

// entry: mục sẽ được hoàn tác/làm lại; "latest": thay đổi vừa gõ chưa lưu xong (sẽ là mục mới nhất khi lưu xong,
// nên nút không mô tả mục cũ hơn mà nó sẽ không hoàn tác).
function setHistoryButton(button, entry, verb, shortcut, emptyTitle) {
  if (!button) return;
  const label = entry === "latest" ? `${verb} thay đổi mới nhất` : entry ? `${verb}: ${describe(entry)}` : verb;
  const title = entry ? `${label} (${shortcut})` : emptyTitle;
  if (button.disabled !== !entry) button.disabled = !entry;
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
  if (button.title !== title) button.title = title;
}

// Nút tắt khi không còn gì để hoàn tác/làm lại; chú thích và tên đọc cho trình đọc màn hình mô tả thay đổi.
export function refreshHistoryButtons() {
  if (typeof document === "undefined") return;
  const undoButton = document.querySelector("#undo-change");
  const redoButton = document.querySelector("#redo-change");
  if (!undoButton || !redoButton) return;
  const active = document.activeElement;
  // Hoàn tác/làm lại (hay lần điền bản sao) đang chờ lưu chính nó thì không tính là thay đổi mới của người dùng.
  const writing = recreations.size > 0 || [...pendingWrites].some(([id, write]) => !write.failed && expenseHasQueuedWork(id));
  const latest = !stepping && !writing && (expenseWorkUnsettled() || transferWorkUnsettled(new Set(pendingTransfers.keys())));
  setHistoryButton(undoButton, latest ? "latest" : history.peekUndo(), "Hoàn tác", UNDO_KEY, "Chưa có thay đổi để hoàn tác");
  setHistoryButton(redoButton, history.peekRedo(), "Làm lại", APPLE ? "⌘⇧Z" : "Ctrl+Y", "Chưa có thay đổi để làm lại");
  // Nút đang được focus vừa bị tắt (hết thay đổi): focus sang nút kia, hay nút "Xuất Excel" (cạnh hai nút) khi cả hai
  // đều tắt, để bàn phím không rơi về đầu trang.
  if ((active === undoButton || active === redoButton) && active.disabled) {
    const other = active === undoButton ? redoButton : undoButton;
    (other.disabled ? document.querySelector("#export-xlsx") : other).focus();
  }
}
