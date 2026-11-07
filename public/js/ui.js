// Thông báo, hộp thoại xác nhận, nút đang tải, dòng trạng thái lưu và khung giữ chỗ khi tải trang.
// Thông báo ẩn chỉ trượt ra và trong suốt (styles.css) nên vùng aria-live (#notice-message: chỉ đọc lời nhắn, không đọc
// các nút) luôn sẵn sàng; chữ được xóa sau khi trượt ra.
const NOTICE_EXIT_MS = 400;
// Rời chuột hay focus khỏi thông báo đã dừng đếm: còn ít nhất chừng này để kịp đọc.
const NOTICE_RESUME_MS = 2000;
let noticeTimer;
let noticeClearTimer;
let noticeAction = null;
let noticeDismiss = null;
let noticeToken = 0;
// Đếm giờ của thông báo đang hiện: dừng khi rê chuột lên hay focus vào nó (đọc, bấm "Hoàn tác"), và với thông báo lỗi
// khi trang đang ẩn (người dùng chưa thấy nó).
const countdown = { remaining: 0, deadline: 0, hover: false, focus: false, untilVisible: false };
// Chuột đang ở trên thông báo. Chỉ chuột mới dừng đếm giờ: một lần chạm để lại :hover "dính" ở chỗ vừa chạm mà không
// có pointerleave nào sau đó, nên thông báo hiện ra từ lần chạm đó (vd. "Hoàn tác" của bản sao) sẽ không bao giờ hết hạn.
let mouseOverNotice = false;
// Phần tử có focus trước khi focus vào thông báo: focus quay lại đó khi thông báo đóng.
let focusBeforeNotice = null;
let resolveActionDialog;

const noticeElement = () => document.querySelector("#notice");

function runCountdown() {
  clearTimeout(noticeTimer);
  countdown.deadline = 0;
  if (noticeElement().hidden || countdown.hover || countdown.focus ||
      (countdown.untilVisible && document.visibilityState === "hidden")) return;
  const token = noticeToken;
  countdown.deadline = Date.now() + countdown.remaining;
  noticeTimer = setTimeout(() => hideNotice(token, "expired"), countdown.remaining);
}

function holdCountdown(reason, held) {
  if (countdown[reason] === held) return;
  if (held && countdown.deadline) countdown.remaining = Math.max(0, countdown.deadline - Date.now());
  countdown[reason] = held;
  if (!held) countdown.remaining = Math.max(countdown.remaining, NOTICE_RESUME_MS);
  runCountdown();
}

// Gắn một lần khi trang mở (app.js).
export function initNotice() {
  const notice = noticeElement();
  const trackMouse = (over) => (event) => {
    if (event.pointerType !== "mouse") return;
    mouseOverNotice = over;
    holdCountdown("hover", over);
  };
  notice.addEventListener("pointerenter", trackMouse(true));
  notice.addEventListener("pointerleave", trackMouse(false));
  notice.addEventListener("focusin", (event) => {
    if (!notice.contains(event.relatedTarget)) focusBeforeNotice = event.relatedTarget;
    holdCountdown("focus", true);
  });
  notice.addEventListener("focusout", (event) => {
    if (!notice.contains(event.relatedTarget)) holdCountdown("focus", false);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && countdown.untilVisible) runCountdown();
  });
}

// options: số (thời gian hiện, ms) hoặc { duration, action: { label, onClick }, onDismiss, hint }. Nút hành động (vd.
// "Hoàn tác") nằm ngoài #notice-message, cạnh nút đóng; nó ẩn (visibility: hidden, không nhận focus) khi thông báo ẩn.
// hint: lời nhắc chỉ đọc cho trình đọc màn hình (vùng riêng, #notice-message vẫn chỉ là lời nhắn), vd. phím tắt.
// onDismiss(reason) chạy đúng một lần khi thông báo đi mà không bấm nút hành động: "expired" (hết hạn), "closed" (×,
// Esc) hay "replaced" (thông báo khác thay). Trả về mã của thông báo (cho hideNotice).
export function showNotice(message, kind = "success", options = {}) {
  const { duration = kind === "error" ? 30000 : 6000, action = null, onDismiss = null, hint = "" } = typeof options === "number" ? { duration: options } : options;
  const dismissPrevious = noticeDismiss;
  clearTimeout(noticeTimer);
  clearTimeout(noticeClearTimer);
  const notice = noticeElement();
  const messageElement = document.querySelector("#notice-message");
  messageElement.setAttribute("role", kind === "error" ? "alert" : "status");
  messageElement.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  messageElement.textContent = message;
  const hintElement = document.querySelector("#notice-hint");
  if (hintElement.textContent !== hint) hintElement.textContent = hint;
  const actionButton = document.querySelector("#notice-action");
  noticeAction = action?.onClick ?? null;
  noticeDismiss = onDismiss;
  if (actionButton.textContent !== (action?.label ?? "")) actionButton.textContent = action?.label ?? "";
  actionButton.hidden = !action;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
  const token = ++noticeToken;
  countdown.remaining = duration;
  countdown.hover = mouseOverNotice && notice.matches(":hover");
  countdown.focus = notice.contains(document.activeElement);
  countdown.untilVisible = kind === "error";
  runCountdown();
  dismissPrevious?.("replaced");
  return token;
}

// Bấm nút hành động của thông báo: đóng thông báo rồi chạy hành động (một lần, thay cho onDismiss).
export function runNoticeAction() {
  const action = noticeAction;
  noticeDismiss = null;
  hideNotice();
  action?.();
}

// token (số): chỉ đóng khi thông báo đang hiện vẫn là thông báo đó. Focus đang ở trong thông báo (×, "Hoàn tác") thì
// quay về chỗ cũ, không ở lại một nút đã ẩn.
export function hideNotice(token, reason = "closed") {
  if (typeof token === "number" && token !== noticeToken) return;
  const dismiss = noticeDismiss;
  noticeDismiss = null;
  clearTimeout(noticeTimer);
  countdown.deadline = 0;
  noticeAction = null;
  const notice = noticeElement();
  notice.hidden = true;
  if (notice.contains(document.activeElement)) {
    const back = focusBeforeNotice?.isConnected && !focusBeforeNotice.closest("[inert]") ? focusBeforeNotice : null;
    if (back) back.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
  focusBeforeNotice = null;
  // Vùng trống thì lần sau đọc lại được cả khi cùng một nội dung.
  clearTimeout(noticeClearTimer);
  noticeClearTimer = setTimeout(() => {
    if (!notice.hidden) return;
    document.querySelector("#notice-message").textContent = "";
    document.querySelector("#notice-hint").textContent = "";
    document.querySelector("#notice-action").hidden = true;
  }, NOTICE_EXIT_MS);
  dismiss?.(reason);
}

// Esc đóng thông báo đang hiện (như bấm ×), trừ khi đang mở hộp thoại hoặc focus ở ô nhập, ô chọn (Esc của chính ô đó).
export function dismissNoticeOnEscape(event) {
  if (event.key !== "Escape" || event.defaultPrevented || noticeElement().hidden) return;
  if (document.querySelector("dialog[open]")) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target && !target.closest("#notice") && target.closest("input, select, textarea, [contenteditable]")) return;
  hideNotice();
}

// Đang hiện một thông báo lỗi hoặc có nút hành động ("Hoàn tác"): lần làm mới dữ liệu không che nó bằng thông báo
// của mình.
export function isImportantNoticeShown() {
  const notice = noticeElement();
  return !notice.hidden && (notice.classList.contains("error") || !document.querySelector("#notice-action").hidden);
}

// Dữ liệu đầu tiên đã hiển thị (hoặc tải lỗi): bỏ khung giữ chỗ của tổng quan, Summary và Detail.
export function finishLoading() {
  for (const section of document.querySelectorAll("main > [aria-busy]")) section.removeAttribute("aria-busy");
}

export function setButtonLoading(button, label) {
  const originalText = button.textContent;
  button.textContent = label;
  button.classList.add("is-loading");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  return () => {
    button.textContent = originalText;
    button.classList.remove("is-loading");
    button.disabled = false;
    button.removeAttribute("aria-busy");
  };
}

export function setSaveStatus(message, status = "saved") {
  const element = document.querySelector("#save-status");
  if (element.textContent !== message) element.textContent = message;
  if (element.dataset.state !== status) element.dataset.state = status;
}

export function showActionDialog({ title, message = "", inputLabel = "", initialValue = "", inputType = "text", preserveInput = false, confirmLabel = "Xác nhận", danger = false }) {
  const actionDialog = document.querySelector("#action-dialog");
  // Hộp thoại trước đã đóng nhưng sự kiện close của nó chưa tới (mở lại ngay sau Esc): kết thúc nó theo returnValue
  // của chính nó trước khi đặt lại, để close đến muộn không lấy mất kết quả của hộp thoại mới.
  if (resolveActionDialog) settleActionDialog();
  document.querySelector("#action-dialog-title").textContent = title;
  const messageElement = document.querySelector("#action-dialog-message");
  messageElement.textContent = message;
  messageElement.hidden = !message;
  const inputLabelElement = document.querySelector("#action-dialog-label");
  const input = document.querySelector("#action-dialog-input");
  inputLabelElement.textContent = inputLabel;
  inputLabelElement.htmlFor = "action-dialog-input";
  inputLabelElement.hidden = !inputLabel;
  input.value = initialValue;
  input.type = inputType;
  input.dataset.preserveInput = String(preserveInput);
  input.autocomplete = inputType === "password" ? "new-password" : "off";
  input.hidden = !inputLabel;
  input.dataset.needsValue = String(Boolean(inputLabel));
  document.querySelector("#action-dialog-error").textContent = "";
  const confirmButton = document.querySelector("#action-dialog-confirm");
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `button ${danger ? "button-danger" : "button-dark"}`;
  // Escape không đổi returnValue (WebKit/Safari, close watcher): xóa kết quả cũ để Escape luôn là Hủy.
  actionDialog.returnValue = "";
  actionDialog.showModal();
  if (inputLabel) input.focus();
  return new Promise((resolve) => { resolveActionDialog = resolve; });
}

export function submitActionDialog(event) {
  event.preventDefault();
  const input = document.querySelector("#action-dialog-input");
  const isEmpty = input.dataset.preserveInput === "true"
    ? input.value.length === 0
    : !input.value.trim();
  if (input.dataset.needsValue === "true" && isEmpty) {
    document.querySelector("#action-dialog-error").textContent = "Trường này không được để trống.";
    return;
  }
  document.querySelector("#action-dialog").close("confirm");
}

export function cancelActionDialog() {
  document.querySelector("#action-dialog").close("cancel");
}

export function clearActionDialogError() {
  document.querySelector("#action-dialog-error").textContent = "";
}

// Sự kiện close đến lúc hộp thoại đang mở là của lần trước (đã kết thúc khi mở lại): bỏ qua.
export function settleActionDialog() {
  if (!resolveActionDialog || document.querySelector("#action-dialog").open) return;
  const resolve = resolveActionDialog;
  resolveActionDialog = null;
  const input = document.querySelector("#action-dialog-input");
  resolve(document.querySelector("#action-dialog").returnValue === "confirm"
    ? (input.hidden
      ? true
      : (input.dataset.preserveInput === "true"
        ? input.value
        : input.value.trim()))
    : null);
}
