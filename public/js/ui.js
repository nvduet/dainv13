// Thông báo, hộp thoại thao tác, nút đang tải, dòng trạng thái lưu và khung giữ chỗ khi tải trang.
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
// Hộp thoại thao tác: { resolve, reject } của lần mở đang chờ kết quả, và các ô, submit, kết quả, lần gửi đang chạy.
let resolveActionDialog;
let dialogSession = null;

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
  liftNoticeAboveKeyboard();
}

// Thông báo nằm ở đáy màn hình. Bàn phím ảo (iPhone, Android) che phần dưới của trang mà không đổi vị trí của phần tử
// cố định: phần nhỏ bị che thì thông báo được nâng lên đúng phần đó (--keyboard-inset); bàn phím mở thật (che hơn
// 100 px) thì thông báo lên đỉnh phần còn thấy (data-keyboard, --viewport-top), vì ngay trên bàn phím là ô đang gõ.
// Đang phóng to bằng hai ngón thì không đổi gì (khung nhìn nhỏ đi vì phóng to, không phải vì bàn phím).
function liftNoticeAboveKeyboard() {
  const viewport = globalThis.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const set = (name, value) => {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  };
  const place = () => {
    const covered = Math.abs(viewport.scale - 1) < 0.01 ? window.innerHeight - viewport.height - viewport.offsetTop : 0;
    set("--keyboard-inset", `${Math.max(0, Math.round(covered))}px`);
    set("--viewport-top", `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    root.toggleAttribute("data-keyboard", covered > 100);
  };
  viewport.addEventListener("resize", place);
  viewport.addEventListener("scroll", place);
  place();
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

// Hộp thoại thao tác dùng chung (#action-dialog): một lời xác nhận, hoặc mọi ô cần nhập (nhãn trên ô) trong cùng một hộp
// thoại, và thao tác chạy ngay trong đó nên lỗi hiện tại chỗ, không phải mở lại rồi gõ lại.
//   fields: [{ name, label, type = "text", value = "", trim = true, required = true, maxLength, hidden = false, note }]
//     Ô thứ nhất có id #action-dialog-input, ô thứ n (n ≥ 2) #action-dialog-input-n. hidden: ô chưa hiện (vd. mật khẩu
//     khi phiên đã xác thực), hiện ra khi có lỗi nói về nó. note: câu nối vào lời nhắn của hộp thoại khi ô đang hiện.
//   submit(values): chạy khi xác nhận, values = { name: giá trị } của các ô đang hiện (trim: bỏ khoảng trắng hai đầu).
//     Lúc chờ: ô và nút bị khóa, nút xác nhận hiện busyLabel, Esc/×/"Hủy" không đóng. Lỗi ném ra (caught.message) hiện
//     trong hộp thoại, giữ mọi giá trị đã nhập. Lỗi của một ô (caught.field: tên ô) đánh dấu ô đó (ô ẩn thì hiện ra);
//     lỗi chung (mạng, 404, 5xx, quá số lần thử…) không đánh dấu ô nào, con trỏ về ô đầu tiên.
//   error: một lỗi như vậy, hiện sẵn khi mở.
// Kết quả: null khi Hủy (Esc, ×); có submit: kết quả của submit, sau khi hộp thoại đã đóng; không có submit: values
// (true khi không có ô nào). Đang mở một hộp thoại thao tác khác: không thay nó (lần mở đó vẫn chờ kết quả của nó), lỗi
// (nơi gọi báo bằng thông báo).
export function showActionDialog({ title, message = "", fields = [], confirmLabel = "Xác nhận", danger = false, busyLabel = "", submit = null, error = null }) {
  const actionDialog = document.querySelector("#action-dialog");
  if (actionDialog.open) return Promise.reject(new Error("Đang mở một hộp thoại khác. Hãy đóng nó rồi thử lại."));
  // Hộp thoại trước đã đóng nhưng sự kiện close của nó chưa tới (mở lại ngay sau Esc): kết thúc nó theo returnValue
  // của chính nó trước khi đặt lại, để close đến muộn không lấy mất kết quả của hộp thoại mới.
  if (resolveActionDialog) settleActionDialog();
  dialogSession = {
    message,
    submit,
    busyLabel,
    result: true,
    pending: null,
    fields: fields.map((field, index) => ({
      type: "text",
      value: "",
      trim: true,
      required: true,
      hidden: false,
      ...field,
      id: index ? `action-dialog-input-${index + 1}` : "action-dialog-input",
    })),
  };
  document.querySelector("#action-dialog-title").textContent = title;
  document.querySelector("#action-dialog-fields").replaceChildren(...dialogSession.fields.flatMap(renderDialogField));
  renderDialogMessage();
  document.querySelector("#action-dialog-error").textContent = "";
  // Nút còn khóa nếu hộp thoại trước bị đóng giữa lúc gửi.
  for (const button of document.querySelectorAll("#action-form button")) button.disabled = false;
  const confirmButton = document.querySelector("#action-dialog-confirm");
  confirmButton.removeAttribute("aria-busy");
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `button ${danger ? "button-danger" : "button-dark"}`;
  // Escape không đổi returnValue (WebKit/Safari, close watcher): xóa kết quả cũ để Escape luôn là Hủy.
  actionDialog.returnValue = "";
  actionDialog.showModal();
  if (error) showDialogError(error);
  else dialogInput(shownFields()[0])?.focus();
  return new Promise((resolve, reject) => { resolveActionDialog = { resolve, reject }; });
}

function renderDialogField(field) {
  const label = document.createElement("label");
  label.htmlFor = field.id;
  label.textContent = field.label;
  label.hidden = field.hidden;
  const input = document.createElement("input");
  input.id = field.id;
  input.type = field.type;
  input.value = field.value;
  input.autocomplete = field.type === "password" ? "new-password" : "off";
  if (field.maxLength) input.maxLength = field.maxLength;
  input.hidden = field.hidden;
  return [label, input];
}

const shownFields = () => dialogSession.fields.filter((field) => !field.hidden);
const dialogInput = (field) => (field ? document.getElementById(field.id) : null);

function renderDialogMessage() {
  const text = [dialogSession.message, ...shownFields().map((field) => field.note)].filter(Boolean).join(" ");
  const messageElement = document.querySelector("#action-dialog-message");
  messageElement.textContent = text;
  messageElement.hidden = !text;
}

// Lỗi hiện dưới các ô (role=alert). Lỗi của một ô (caught.field): ô đó được đánh dấu, nhận con trỏ và chọn sẵn chữ để
// gõ lại. Lỗi chung: không ô nào bị đánh dấu; con trỏ về ô đầu tiên, chữ không bị chọn (gõ tiếp không mất gì).
function showDialogError(caught) {
  const field = dialogSession.fields.find((item) => item.name === caught.field) ?? null;
  const input = dialogInput(field);
  if (field?.hidden) {
    field.hidden = false;
    input.hidden = false;
    input.labels[0].hidden = false;
    renderDialogMessage();
  }
  document.querySelector("#action-dialog-error").textContent = caught.message;
  if (!input) {
    (dialogInput(shownFields()[0]) ?? document.querySelector("#action-dialog-confirm")).focus();
    return;
  }
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", "action-dialog-error");
  input.focus();
  input.select();
}

// Đang gửi: khóa ô và nút (nút xác nhận hiện busyLabel); trả về hàm mở khóa.
function lockActionDialog(busyLabel) {
  const confirmButton = document.querySelector("#action-dialog-confirm");
  const controls = [...document.querySelectorAll("#action-form :is(input, button)")].filter((control) => control !== confirmButton);
  for (const control of controls) control.disabled = true;
  const resetConfirm = setButtonLoading(confirmButton, busyLabel || confirmButton.textContent);
  return () => {
    for (const control of controls) control.disabled = false;
    resetConfirm();
  };
}

export async function submitActionDialog(event) {
  event.preventDefault();
  const session = dialogSession;
  const actionDialog = document.querySelector("#action-dialog");
  if (!session || session.pending || !actionDialog.open) return;
  clearActionDialogError();
  const shown = shownFields();
  const values = Object.fromEntries(shown.map((field) => {
    const { value } = dialogInput(field);
    return [field.name, field.trim ? value.trim() : value];
  }));
  const empty = shown.find((field) => field.required && !values[field.name]);
  if (empty) {
    // Lỗi hiện dưới ô cuối cùng: hộp thoại nhiều ô thì nói rõ ô nào.
    const message = shown.length > 1 ? `${empty.label} không được để trống.` : "Trường này không được để trống.";
    showDialogError({ message, field: empty.name });
    return;
  }
  if (!session.submit) {
    if (shown.length) session.result = values;
    actionDialog.close("confirm");
    return;
  }
  const unlock = lockActionDialog(session.busyLabel);
  session.pending = Promise.resolve(values).then(session.submit);
  let failure = null;
  try {
    session.result = await session.pending;
  } catch (caught) {
    failure = caught;
  }
  session.pending = null;
  // Bị đóng giữa lúc gửi rồi hộp thoại đã mở cho việc khác: không động vào nó (kết quả đã về nơi gọi, settleActionDialog).
  if (session !== dialogSession) return;
  unlock();
  if (!actionDialog.open) return;
  if (failure) {
    hideRepeatedErrorNotice(failure.message);
    showDialogError(failure);
  } else {
    actionDialog.close("confirm");
  }
}

// Lỗi của hộp thoại nhắc lại thông báo lỗi đang hiện (vd. lần xóa khoản chi bị từ chối khi Store, khôi phục gửi các lần
// xóa còn chờ): lỗi chỉ còn trong hộp thoại, không hiện hai lần.
function hideRepeatedErrorNotice(message) {
  const shown = document.querySelector("#notice-message").textContent;
  const notice = noticeElement();
  if (!notice.hidden && notice.classList.contains("error") && shown && String(message).includes(shown)) hideNotice();
}

export function cancelActionDialog() {
  if (dialogSession?.pending) return;
  document.querySelector("#action-dialog").close("cancel");
}

// Đang gửi: Esc (và các yêu cầu đóng khác) không đóng hộp thoại. Esc phải chặn ngay ở keydown: Chrome chỉ cho chặn sự
// kiện cancel một lần, lần Esc sau đóng luôn.
export function holdBusyActionDialog(event) {
  if (dialogSession?.pending && (event.type === "cancel" || event.key === "Escape")) event.preventDefault();
}

export function clearActionDialogError() {
  document.querySelector("#action-dialog-error").textContent = "";
  for (const input of document.querySelectorAll("#action-dialog-fields [aria-invalid]")) {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  }
}

// Sự kiện close đến lúc hộp thoại đang mở là của lần trước (đã kết thúc khi mở lại): bỏ qua. Hộp thoại vẫn bị đóng giữa
// lúc gửi (yêu cầu đóng không chặn được): kết quả là kết quả của lần gửi đó (lỗi thì ném ra cho nơi gọi báo).
export function settleActionDialog() {
  const actionDialog = document.querySelector("#action-dialog");
  if (!resolveActionDialog || actionDialog.open) return;
  const { resolve, reject } = resolveActionDialog;
  resolveActionDialog = null;
  if (dialogSession.pending) dialogSession.pending.then(resolve, reject);
  else resolve(actionDialog.returnValue === "confirm" ? dialogSession.result : null);
}
