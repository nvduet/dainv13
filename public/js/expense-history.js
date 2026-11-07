// Nút "Hoàn tác" / "Làm lại" của bảng Detail, Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z): lịch sử thay đổi khoản chi trong phiên.
// Mỗi lần lưu thành công ghi lại giá trị trước của các trường vừa đổi. Hoàn tác đặt lại giá trị đó qua hàng đợi tự lưu
// như khi người dùng gõ; chỉ báo "Đã hoàn tác" khi máy chủ đã lưu. Trường đã bị người khác (thiết bị khác) đổi tiếp
// thì bỏ qua và báo không hoàn tác được. Hoàn tác "Thêm dòng" (hay nhân bản) là xóa dòng đó, có thông báo "Hoàn tác".
// Tổng "Đã chuyển khoản" của Summary (ô của Admin, nút Done) dùng chung lịch sử: hoàn tác đặt lại tổng trước đó qua
// chính ô đó (summary.js).
import {
  applyHistoryValues,
  expenseDescription,
  expenseHasQueuedWork,
  expenseWorkUnsettled,
  hasPendingDelete,
  readSavedExpense,
  removeExpenseWithUndo,
  restoreDeletedExpense,
  settleExpenseWork,
} from "./expenses.js";
import { state } from "./state.js";
import { currentTransferTotal, flushTransferInputs, setTransferTotal, transferWorkUnsettled, watchTransferSaves } from "./summary.js";
import { showNotice } from "./ui.js";
import { createUndoHistory, describeEntry, diffSavedExpense, planHistoryStep, planTransferStep } from "./undo-history.js";

const history = createUndoHistory({ onChange: refreshHistoryButtons });
// Tổng chuyển khoản do hoàn tác/làm lại đặt, theo id thành viên: { entry, direction, amountVnd }. Lưu xong đúng tổng đó
// thì báo hoàn tác/làm lại, không ghi thành thay đổi mới.
const pendingTransfers = new Map();
// Giá trị do hoàn tác/làm lại (hoặc lần điền bản sao vừa nhân bản) đặt vào một dòng, theo id khoản chi:
// { entry, direction, skipped, fields: Map(trường → giá trị), toggles: Map(memberId → tick), failed }.
// Lưu xong đúng các giá trị đó thì không ghi thành thay đổi mới; hoàn tác/làm lại khi đó mới được báo thành công.
const pendingWrites = new Map();
// Mỗi lần focus một ô của bảng là một "phiên gõ": các lần lưu cùng một ô trong một phiên gộp thành một mục.
let focusSession = 0;
const editSessions = new Map();
let stepping = false;
const APPLE = /Mac|iPhone|iPad/.test(globalThis.navigator?.userAgent ?? "");
const UNDO_KEY = APPLE ? "⌘Z" : "Ctrl+Z";

const memberName = (id) => state.members.find((member) => member.id === id)?.name ?? null;
const describe = (entry, options = {}) =>
  describeEntry(entry, { description: expenseDescription(entry.expenseId) ?? entry.label, memberName, ...options });

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

export function recordExpenseDelete(id, label) {
  history.record({ kind: "delete", expenseId: id, label });
}

// Dòng chờ xóa được hiện lại ("Hoàn tác" của thông báo, DELETE lỗi): không còn gì để hoàn tác cho lần xóa đó.
export function forgetExpenseDelete(id) {
  history.remove((entry) => entry.kind === "delete" && entry.expenseId === id);
}

// Khoản chi đã bị xóa hẳn (hoặc không còn trên máy chủ): bỏ mọi mục của nó.
export function forgetExpense(id) {
  pendingWrites.delete(id);
  history.remove((entry) => entry.expenseId === id);
}

// Còn một lần hoàn tác/làm lại đang chờ máy chủ lưu (chưa lỗi): chưa làm bước tiếp theo.
function waitingForWrite() {
  for (const [id, write] of pendingWrites) {
    if (write.failed) continue;
    if (expenseHasQueuedWork(id)) return true;
    // Hàng đợi không còn gì để gửi cho dòng này (dòng đã bị bỏ, thành viên bị xóa…): lần ghi không bao giờ xong.
    pendingWrites.delete(id);
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

// Hoàn tác "Thêm dòng" = xóa dòng (thông báo "Đã xóa khoản chi." kèm "Hoàn tác", DELETE gửi sau). Làm lại = hiện lại
// dòng đang chờ xóa; DELETE đã gửi thì không làm lại được.
function stepAdd(entry, direction) {
  const id = entry.expenseId;
  if (direction === "undo") {
    if (!readSavedExpense(id)) {
      showConflict(direction);
      return;
    }
    void removeExpenseWithUndo(id, { record: false });
    history.pushRedo(entry);
    return;
  }
  if (hasPendingDelete(id)) {
    restoreDeletedExpense(id);
    history.pushUndo(entry);
    if (!hasPendingDelete()) showNotice(`Đã làm lại: ${describe(entry)}.`);
  } else if (readSavedExpense(id)) {
    history.pushUndo(entry);
  } else {
    showConflict(direction);
  }
}

function stepDelete(entry) {
  if (!hasPendingDelete(entry.expenseId)) {
    showConflict("undo");
    return;
  }
  const description = describe(entry);
  restoreDeletedExpense(entry.expenseId);
  if (!hasPendingDelete()) showNotice(`Đã hoàn tác: ${description}.`);
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
    const entry = direction === "undo" ? history.takeUndo() : history.takeRedo();
    if (!entry) return;
    if (entry.kind === "edit") stepEdit(entry, direction);
    else if (entry.kind === "transfer") stepTransfer(entry, direction);
    else if (entry.kind === "add") stepAdd(entry, direction);
    else if (direction === "undo") stepDelete(entry);
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
  const writing = [...pendingWrites].some(([id, write]) => !write.failed && expenseHasQueuedWork(id));
  const latest = !stepping && !writing && (expenseWorkUnsettled() || transferWorkUnsettled(new Set(pendingTransfers.keys())));
  setHistoryButton(undoButton, latest ? "latest" : history.peekUndo(), "Hoàn tác", UNDO_KEY, "Chưa có thay đổi để hoàn tác");
  setHistoryButton(redoButton, history.peekRedo(), "Làm lại", APPLE ? "⌘⇧Z" : "Ctrl+Y", "Chưa có thay đổi để làm lại");
  // Nút đang được focus vừa bị tắt (hết thay đổi): focus sang nút kia, hay nút "Add line" khi cả hai đều tắt, để bàn
  // phím không rơi về đầu trang.
  if ((active === undoButton || active === redoButton) && active.disabled) {
    const other = active === undoButton ? redoButton : undoButton;
    (other.disabled ? document.querySelector("#add-expense") : other).focus();
  }
}
