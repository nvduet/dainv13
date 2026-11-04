// Bảng Detail: dựng dòng, thêm/xóa/nhân bản từng dòng, xem trước số liệu và tự lưu theo id khoản chi.
import { isPlainThousandInput } from "../accounting.mjs";
import { api } from "./api.js";
import { createDeleteQueue } from "./delete-queue.js";
import { mergeExpenseLists } from "./expense-merge.js";
import {
  arrangeRenderedExpenses,
  captureDetailView,
  pinExpenseRow,
  readExpenseRow,
  renamePinnedRow,
} from "./detail-view.js";
import {
  forgetExpense,
  forgetExpenseDelete,
  markDuplicateFill,
  noteSaveFailed,
  noteUserEdit,
  recordExpenseAdd,
  recordExpenseDelete,
  recordExpenseSave,
  refreshHistoryButtons,
  undoShortcutHint,
} from "./expense-history.js";
import {
  escapeHtml,
  formatAverageThousand,
  formatThousandInput,
  parseAmountInput,
  parseAmountOrZero,
  toggleAmountSign,
} from "./format.js";
import { createSaveQueue } from "./save-queue.js";
import { state } from "./state.js";
import { renderTotals } from "./summary.js";
import { hideNotice, setSaveStatus, showNotice } from "./ui.js";

const expenseQueue = createSaveQueue({
  send: (id, body, { keepalive }) => api(`/api/expenses/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
    keepalive,
  }),
  onSaved: handleExpenseSaved,
  onFailed: handleExpenseSaveFailed,
  onChange: refreshSaveStatus,
  isVisible: () => document.visibilityState === "visible",
});
// Xóa có thể hoàn tác: dòng ẩn ngay (Summary và tổng đầu trang không tính nó), DELETE gửi khi thông báo
// "Đã xóa khoản chi." hết hạn hoặc bị đóng, khi trang ẩn/đóng (keepalive), trước Store, khôi phục, đăng xuất và
// làm mới dữ liệu. Dữ liệu giữ cho mỗi dòng: expense (bản đã lưu mới nhất), index, nextId (chỗ cũ), row (dòng đang
// mờ dần), amountText/descriptionText (chữ đang gõ dở, để hiện lại đúng như cũ).
const deleteQueue = createDeleteQueue({
  send: (id, { keepalive }) => api(`/api/expenses/${encodeURIComponent(id)}`, { method: "DELETE", keepalive }),
  onCommitted: handleDeleteCommitted,
  onFailed: handleDeleteFailed,
});
// Thông báo "Đã xóa khoản chi." đang hiện (mã của nó trong ui.js), null nếu không.
let deleteNotice = null;
// Thông báo xóa bị thông báo khác thay: các lần xóa vẫn chờ đủ 6 giây (còn hoàn tác được bằng nút "Hoàn tác" ở đầu
// bảng hay Ctrl+Z) rồi mới gửi DELETE.
const DELETE_UNDO_MS = 6000;
let deleteTimer = null;
// Lời báo của lần DELETE bị từ chối gần nhất (flushPendingDeletes nhắc lại khi dừng Store, khôi phục, đăng xuất).
let lastDeleteFailure = "";
// Bản sao (nhân bản) đang chờ PUT điền giá trị: lưu xong thì báo "Đã nhân bản" (kèm Hoàn tác) thay vì "Đã lưu".
const duplicatesAwaitingSave = new Set();
let pendingAdds = Promise.resolve();
// Số lần "Add line"/nhân bản đang chờ POST (nút hoàn tác chưa biết mục mới nhất).
let addsInFlight = 0;
// Bản sao vừa nhân bản được tô nền trong 2 giây (không chuyển động, nên vẫn hiện khi giảm chuyển động).
const COPY_HIGHLIGHT_MS = 2000;
// Làm mới dữ liệu khi quay lại trang (admin.js): ghi lại những gì trang tự lưu trong lúc chờ GET /api/state, để dữ liệu
// cũ hơn trong phản hồi đó không đè lên.
const localWriteWatchers = new Set();
// Dòng bị xóa mờ dần rồi mới gỡ (styles.css .row-exit); gỡ hẳn sau thời gian này nếu animationend không tới.
const ROW_EXIT_FALLBACK_MS = 600;

function findExpenseRow(id) {
  return document.querySelector(`#expense-body tr[data-expense-id="${CSS.escape(id)}"]`);
}

// Dòng tạm "pending-…" (đang chờ POST) không bao giờ được lưu hay xóa qua API.
function editableExpenseId(row) {
  const id = row?.dataset.expenseId;
  return id && !id.startsWith("pending-") ? id : null;
}

function formatShareAverage(amountVnd, count) {
  return count && amountVnd ? formatAverageThousand(amountVnd, count) : "—";
}

function renderExpenseHead() {
  return `<tr>
    <th class="expense-payer">Người chi</th>
    <th class="expense-date">Date</th>
    <th class="expense-description">Nội dung</th>
    <th class="expense-amount">Chi phí</th>
    ${state.members.map((member) => `<th class="member-check" title="${escapeHtml(member.name)}">${escapeHtml(member.name)}</th>`).join("")}
    <th class="expense-count">Số người</th>
    <th class="expense-average">Số tiền/Ng</th>
    <th class="member-actions">Xóa<span class="visually-hidden"> hoặc nhân bản</span></th>
  </tr>`;
}

function renderEmptyExpenseRow() {
  return `<tr><td class="empty-cell" colspan="${state.members.length + 7}"><span class="empty-state">Chưa có khoản chi — thêm dòng đầu tiên nhé ✿</span></td></tr>`;
}

function renderExpenseRow(expense) {
  const participants = new Set(expense.participantIds);
  const count = state.members.filter((member) => participants.has(member.id)).length;
  return `<tr data-expense-id="${escapeHtml(expense.id)}">
      <td class="expense-payer"><select class="payer-input" aria-label="Người chi">
        <option value="">Chọn người</option>
        ${state.members.map((member) => `<option value="${escapeHtml(member.id)}" ${member.id === expense.payerId ? "selected" : ""}>${escapeHtml(member.name)}</option>`).join("")}
      </select></td>
      <td class="expense-date"><input class="date-input" type="date" value="${escapeHtml(expense.date || "")}" aria-label="Ngày khoản chi"></td>
      <td class="expense-description"><input class="description-input" type="text" maxlength="200" value="${escapeHtml(expense.description)}" placeholder="Nội dung khoản chi" aria-label="Nội dung"></td>
      <td class="expense-amount"><input class="amount-input" type="text" inputmode="decimal" value="${expense.amountVnd ? formatThousandInput(expense.amountVnd) : ""}" placeholder="0" aria-label="Chi phí, nghìn đồng"><button class="sign-toggle" type="button" tabindex="-1" data-action="toggle-amount-sign" aria-label="Đổi dấu âm/dương" title="Đổi dấu âm/dương">±</button></td>
      ${state.members.map((member) => `<td class="member-check"><label class="member-check-toggle"><input type="checkbox" data-member-id="${escapeHtml(member.id)}" aria-label="Chia cho ${escapeHtml(member.name)}" ${participants.has(member.id) ? "checked" : ""}></label></td>`).join("")}
      <td class="share-avg expense-count">${count || "—"}</td>
      <td class="share-avg expense-average">${formatShareAverage(expense.amountVnd, count)}</td>
      <td class="member-actions">
        <button class="icon-button duplicate" type="button" data-action="duplicate-expense" aria-label="Nhân bản khoản chi" title="Nhân bản"><svg aria-hidden="true" focusable="false"><use href="#icon-duplicate"></use></svg></button><button class="icon-button delete" type="button" data-action="delete-expense" aria-label="Xóa khoản chi" title="Xóa">×</button>
      </td>
    </tr>`;
}

function createExpenseRow(expense) {
  const container = document.createElement("tbody");
  container.innerHTML = renderExpenseRow(expense);
  const row = container.firstElementChild;
  if (expense.id.startsWith("pending-")) {
    row.querySelectorAll("input, select, button").forEach((control) => {
      control.disabled = true;
    });
  }
  updateExpenseMissingFieldHighlights(row);
  return row;
}

function insertExpenseRow(row, beforeRow = null) {
  const body = document.querySelector("#expense-body");
  body.querySelector(".empty-cell")?.closest("tr").remove();
  body.insertBefore(row, beforeRow);
}

// Hiệu ứng xuất hiện chỉ cho dòng vừa thêm (dựng lại bảng hay tự lưu không phát lại); gỡ lớp khi chạy xong.
function animateRowIn(row) {
  const finish = (event) => {
    if (event.animationName !== "row-enter") return;
    row.removeEventListener("animationend", finish);
    row.classList.remove("row-enter");
  };
  row.addEventListener("animationend", finish);
  row.classList.add("row-enter");
}

// Bản sao vừa nhân bản: nền xanh nhạt tới `until` (dòng thật thay dòng tạm vẫn giữ đúng hạn đó).
function highlightCopy(row, until = Date.now() + COPY_HIGHLIGHT_MS) {
  row.classList.add("row-copied");
  row.dataset.copiedUntil = String(until);
  setTimeout(() => {
    if (Number(row.dataset.copiedUntil) > Date.now()) return;
    row.classList.remove("row-copied");
    delete row.dataset.copiedUntil;
  }, Math.max(0, until - Date.now()));
}

// Dòng thật thay dòng tạm khi POST xong: hiệu ứng xuất hiện chạy tiếp từ chỗ dòng tạm đang chạy tới.
function replaceExpenseRow(oldRow, newRow) {
  const elapsed = oldRow.classList.contains("row-enter") ? oldRow.cells[0]?.getAnimations?.()[0]?.currentTime : null;
  if (oldRow.classList.contains("row-shift")) newRow.classList.add("row-shift");
  if (oldRow.dataset.copiedUntil) highlightCopy(newRow, Number(oldRow.dataset.copiedUntil));
  oldRow.replaceWith(newRow);
  if (typeof elapsed !== "number") return;
  animateRowIn(newRow);
  for (const cell of newRow.cells) {
    for (const animation of cell.getAnimations?.() ?? []) animation.currentTime = elapsed;
  }
}

// Dòng bị xóa thôi khớp tr[data-expense-id] ngay (đếm dòng, xem trước số liệu, tìm dòng đều bỏ qua nó),
// không nhận thao tác nữa, mờ dần trong khi các dòng dưới trượt lên chiếm chỗ, rồi mới gỡ khỏi bảng.
function removeExpenseRow(row) {
  const body = document.querySelector("#expense-body");
  delete row.dataset.expenseId;
  if (!body.querySelector("tr[data-expense-id]")) {
    body.innerHTML = renderEmptyExpenseRow();
    animateRowIn(body.firstElementChild);
    return;
  }
  row.inert = true;
  row.classList.remove("row-enter");
  row.classList.add("row-exit");
  body.style.setProperty("--row-shift", `${-row.offsetHeight}px`);
  for (let next = row.nextElementSibling; next; next = next.nextElementSibling) {
    next.classList.remove("row-enter");
    next.classList.add("row-shift");
  }
  row.addEventListener("animationend", (event) => {
    if (event.animationName === "row-exit") dropExitingRow(row);
  });
  setTimeout(() => dropExitingRow(row), ROW_EXIT_FALLBACK_MS);
}

// Gỡ dòng đang mờ dần và bỏ dịch chuyển của các dòng dưới trong cùng một lần vẽ: các dòng đứng yên đúng chỗ.
function dropExitingRow(row) {
  const body = row.parentElement;
  if (!body) return;
  row.remove();
  for (const shifted of body.querySelectorAll("tr.row-shift")) shifted.classList.remove("row-shift");
}

// Dựng lại toàn bộ bảng (sau thao tác Admin/khôi phục) mà không làm mất ô đang sửa hoặc chưa lưu,
// rồi áp lại cách xem (lọc/sắp xếp) trước khi trả focus về ô đang sửa (chuyển chỗ một dòng làm mất focus).
export function renderExpenses() {
  const body = document.querySelector("#expense-body");
  const preserved = captureExpenseRows();
  const arrangement = captureDetailView();
  expenseQueue.retain(new Set(state.expenses.map((expense) => expense.id)));
  expenseQueue.retainMembers(new Set(state.members.map((member) => member.id)));
  document.querySelector("#expense-head").innerHTML = renderExpenseHead();
  if (state.expenses.length === 0) {
    body.innerHTML = renderEmptyExpenseRow();
  } else {
    body.innerHTML = state.expenses.map(renderExpenseRow).join("");
    body.querySelectorAll("tr[data-expense-id]").forEach(updateExpenseMissingFieldHighlights);
    // Dòng tạm còn chờ POST: không sửa được, như khi vừa thêm (createExpenseRow).
    for (const control of body.querySelectorAll('tr[data-expense-id^="pending-"] :is(input, select, button)')) control.disabled = true;
  }
  const restoreFocus = restoreExpenseRows(preserved);
  arrangeRenderedExpenses(arrangement);
  restoreFocus();
  refreshHistoryButtons();
}

function focusSelector(element) {
  if (element.matches("input[type=checkbox]")) {
    return `input[type=checkbox][data-member-id="${CSS.escape(element.dataset.memberId)}"]`;
  }
  return [...element.classList].map((name) => `.${CSS.escape(name)}`).join("");
}

function captureExpenseRows() {
  const captured = new Map();
  const active = document.activeElement;
  for (const row of document.querySelectorAll("#expense-body tr[data-expense-id]")) {
    const id = row.dataset.expenseId;
    const focused = active && active !== row && row.contains(active) ? active : null;
    if (!focused && !expenseQueue.get(id)) continue;
    captured.set(id, {
      payerId: row.querySelector(".payer-input").value,
      date: row.querySelector(".date-input").value,
      description: row.querySelector(".description-input").value,
      amount: row.querySelector(".amount-input").value,
      checked: new Set([...row.querySelectorAll("input[type=checkbox]:checked")].map((checkbox) => checkbox.dataset.memberId)),
      focus: focused && {
        selector: focusSelector(focused),
        selection: focused.matches(".description-input, .amount-input")
          ? [focused.selectionStart, focused.selectionEnd]
          : null,
      },
    });
  }
  return captured;
}

// Giá trị gõ chưa lưu luôn được giữ; giá trị khác chỉ giữ khi vẫn khớp dữ liệu mới (giữ nguyên cách gõ "360,5").
// Trả về hàm đặt lại focus (gọi sau khi các dòng đã vào đúng chỗ).
function restoreExpenseRows(captured) {
  let restoreFocus = () => {};
  if (captured.size === 0) return restoreFocus;
  const expensesById = new Map(state.expenses.map((expense) => [expense.id, expense]));
  for (const [id, saved] of captured) {
    const row = findExpenseRow(id);
    const expense = expensesById.get(id);
    if (!row || !expense) continue;
    const entry = expenseQueue.get(id);
    const pending = (field) => Boolean(entry && Object.hasOwn(entry.pending, field));
    if (pending("payerId")) setPayerValue(row.querySelector(".payer-input"), saved.payerId);
    if (pending("date")) row.querySelector(".date-input").value = saved.date;
    if (pending("description") || saved.description.trim() === expense.description) {
      row.querySelector(".description-input").value = saved.description;
    }
    if (pending("amountVnd") || entry?.fieldError?.field === "amountVnd" ||
        parseAmountOrZero(saved.amount) === expense.amountVnd) {
      row.querySelector(".amount-input").value = saved.amount;
    }
    for (const checkbox of row.querySelectorAll("input[type=checkbox]")) {
      if (entry?.participantToggles.has(checkbox.dataset.memberId)) {
        checkbox.checked = saved.checked.has(checkbox.dataset.memberId);
      }
    }
    updateExpenseRowCells(row);
    const control = saved.focus?.selector ? row.querySelector(saved.focus.selector) : null;
    if (control) {
      restoreFocus = () => {
        control.focus({ preventScroll: true });
        if (saved.focus.selection) control.setSelectionRange(...saved.focus.selection);
      };
    }
  }
  return restoreFocus;
}

// Người chi không có trong danh sách (ví dụ vừa bị xóa) thì hiện "Chọn người" như khi dựng dòng, không để ô trống.
function setPayerValue(select, payerId) {
  select.value = [...select.options].some((option) => option.value === payerId) ? payerId : "";
}

function updateExpenseMissingFieldHighlights(row) {
  row.querySelector(".expense-payer").classList.toggle("cell-incomplete", !row.querySelector(".payer-input").value);
  row.querySelector(".expense-date").classList.toggle("cell-incomplete", !row.querySelector(".date-input").value);
  row.querySelector(".expense-description").classList.toggle("cell-incomplete", !row.querySelector(".description-input").value.trim());
  row.querySelector(".expense-amount").classList.toggle("cell-incomplete", parseAmountOrZero(row.querySelector(".amount-input").value) === 0);
}

function updateExpenseRowCells(row) {
  const count = row.querySelectorAll("input[type=checkbox]:checked").length;
  const amountVnd = parseAmountOrZero(row.querySelector(".amount-input").value);
  updateExpenseMissingFieldHighlights(row);
  row.querySelector(".expense-count").textContent = count || "—";
  row.querySelector(".expense-average").textContent = formatShareAverage(amountVnd, count);
}

// Số liệu xem trước lấy từ đúng những gì đang hiển thị trong bảng (kể cả thay đổi chưa lưu), gồm cả các dòng
// đang bị bộ lọc ẩn (hidden: true): Summary và tổng đầu trang luôn tính mọi khoản chi.
export function getExpensePreview() {
  return [...document.querySelectorAll("#expense-body tr[data-expense-id]")].map(readExpenseRow);
}

function updateExpensePreview(row) {
  updateExpenseRowCells(row);
  renderTotals(getExpensePreview());
}

export function handleExpenseInput(event) {
  const row = event.target.closest("tr");
  const id = editableExpenseId(row);
  if (!id) return;
  if (event.target.matches(".description-input")) {
    noteUserEdit(id, "description");
    expenseQueue.update(id, "description", event.target.value, 400);
    updateExpensePreview(row);
  }
  if (event.target.matches(".amount-input")) {
    noteUserEdit(id, "amountVnd");
    // Đang gõ một phép tính ("120+45"): ô nở rộng sang trái để thấy cả phép tính (styles.css).
    event.target.classList.toggle("is-expression", Boolean(event.target.value.trim()) && !isPlainThousandInput(event.target.value));
    updateExpensePreview(row);
    let amountVnd;
    try {
      amountVnd = parseAmountInput(event.target.value);
    } catch (caught) {
      expenseQueue.rejectField(id, "amountVnd", caught.message);
      return;
    }
    expenseQueue.update(id, "amountVnd", amountVnd, 400);
  }
}

export function handleExpenseChange(event) {
  const row = event.target.closest("tr");
  const id = editableExpenseId(row);
  if (!id) return;
  if (event.target.matches("input[type=checkbox]")) {
    noteUserEdit(id, null, event.target.dataset.memberId);
    updateExpensePreview(row);
    expenseQueue.toggleParticipant(id, event.target.dataset.memberId, event.target.checked, 100);
  } else if (event.target.matches(".payer-input")) {
    noteUserEdit(id, "payerId");
    updateExpensePreview(row);
    expenseQueue.update(id, "payerId", event.target.value || null, 100);
  } else if (event.target.matches(".date-input")) {
    noteUserEdit(id, "date");
    updateExpenseMissingFieldHighlights(row);
    expenseQueue.update(id, "date", event.target.value || null, 100);
  }
}

// Nút "±" (màn hình cảm ứng): đổi dấu ô Chi phí rồi phát "input" như khi gõ dấu trừ, nên được tự lưu y hệt.
export function toggleExpenseAmountSign(button) {
  const input = button.closest("td")?.querySelector(".amount-input");
  if (!input || input.disabled) return;
  const next = toggleAmountSign(input.value, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length);
  input.value = next.value;
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  input.setSelectionRange(next.selectionStart, next.selectionEnd);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function handleExpenseFocusOut(event) {
  if (!event.target.matches(".amount-input, .description-input")) return;
  if (event.target.matches(".amount-input")) showEvaluatedAmount(event.target);
  const id = editableExpenseId(event.target.closest("tr"));
  if (id && expenseQueue.hasWork(id)) expenseQueue.schedule(id, 0);
}

// Rời ô Chi phí đang là một phép tính hợp lệ ("120+45"): ô hiện kết quả ("165"), cùng số tiền đã/đang lưu.
// Số gõ tay ("360,5") và phép tính sai giữ nguyên như khi gõ.
function showEvaluatedAmount(input) {
  input.classList.remove("is-expression");
  if (!input.value.trim() || isPlainThousandInput(input.value)) return;
  let amountVnd;
  try {
    amountVnd = parseAmountInput(input.value);
  } catch {
    return;
  }
  input.value = amountVnd ? formatThousandInput(amountVnd) : "0";
}

function refreshSaveStatus() {
  const status = expenseQueue.status();
  if (status.state === "error") setSaveStatus(`Chưa lưu: ${status.message}`, "error");
  else if (status.state === "saving") setSaveStatus("Đang lưu vào cơ sở dữ liệu…", "saving");
  else if (status.state === "pending") setSaveStatus("Có thay đổi chưa lưu…", "saving");
  else setSaveStatus("Đã lưu vào cơ sở dữ liệu.", "saved");
  // Thay đổi đang chờ lưu sẽ là mục hoàn tác mới nhất: nút "Hoàn tác" thôi mô tả mục cũ.
  refreshHistoryButtons();
}

// Còn thay đổi khoản chi đang chờ lưu, đang lưu, hoặc dòng đang chờ POST: lần hoàn tác tới sẽ áp cho chúng.
export function expenseWorkUnsettled() {
  const { state: saveState } = expenseQueue.status();
  return addsInFlight > 0 || saveState === "saving" || saveState === "pending";
}

// Các dòng theo thứ tự nhập (không theo cách sắp xếp đang chọn của bảng): xuất CSV, chi tiết thành viên.
export function inEntryOrder(items) {
  const positions = new Map(state.expenses.map((expense, index) => [expense.id, index]));
  const position = (item) => positions.get(item.id) ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort((left, right) => position(left) - position(right));
}

// Phản hồi lưu hợp nhất với bản đã lưu, trừ những trường/tick vẫn còn giá trị mới hơn đang chờ lưu.
function mergeExpense(current, saved, pending = {}, participantToggles = new Map()) {
  const merged = { ...saved };
  for (const field of Object.keys(pending)) {
    if (Object.hasOwn(current, field)) merged[field] = current[field];
  }
  if (participantToggles.size) {
    const participantIds = (saved.participantIds || []).filter((memberId) => participantToggles.get(memberId) !== false);
    for (const [memberId, checked] of participantToggles) {
      if (checked && !participantIds.includes(memberId)) participantIds.push(memberId);
    }
    merged.participantIds = participantIds;
  }
  return merged;
}

function mergeSavedExpense(id, saved, pending = {}, participantToggles = new Map()) {
  const index = state.expenses.findIndex((expense) => expense.id === id);
  if (index === -1 || !saved) return null;
  state.expenses[index] = mergeExpense(state.expenses[index], saved, pending, participantToggles);
  return state.expenses[index];
}

function noteLocalWrite(kind, id = null) {
  for (const watcher of localWriteWatchers) {
    if (kind === "expense") watcher.expenseIds.add(id);
    else if (kind === "delete") watcher.deletedIds.add(id);
    else watcher.payments = true;
  }
}

// Làm mới dữ liệu (admin.js): khoản chi trang tự lưu/tạo/xóa và chuyển khoản trang tự lưu trong lúc chờ GET.
export function watchLocalWrites() {
  const watcher = { expenseIds: new Set(), deletedIds: new Set(), payments: false };
  watcher.stop = () => localWriteWatchers.delete(watcher);
  localWriteWatchers.add(watcher);
  return watcher;
}

export function notePaymentWrite() {
  noteLocalWrite("payments");
}

// Ô không được focus và không chờ lưu lấy theo dữ liệu vừa lưu (ví dụ tick từ điện thoại khác).
function syncExpenseRow(row, expense, { pending, participantToggles, fieldError }) {
  const active = document.activeElement;
  const idle = (control, field) => control !== active && !Object.hasOwn(pending, field);
  const payer = row.querySelector(".payer-input");
  if (idle(payer, "payerId") && (payer.value || null) !== (expense.payerId ?? null)) setPayerValue(payer, expense.payerId || "");
  const date = row.querySelector(".date-input");
  if (idle(date, "date") && (date.value || null) !== (expense.date ?? null)) date.value = expense.date || "";
  const description = row.querySelector(".description-input");
  if (idle(description, "description") && description.value.trim() !== (expense.description ?? "")) {
    description.value = expense.description ?? "";
  }
  const amount = row.querySelector(".amount-input");
  if (idle(amount, "amountVnd") && fieldError?.field !== "amountVnd" &&
      parseAmountOrZero(amount.value) !== expense.amountVnd) {
    amount.value = expense.amountVnd ? formatThousandInput(expense.amountVnd) : "";
  }
  const participants = new Set(expense.participantIds || []);
  for (const checkbox of row.querySelectorAll("input[type=checkbox]")) {
    if (checkbox !== active && !participantToggles.has(checkbox.dataset.memberId)) {
      checkbox.checked = participants.has(checkbox.dataset.memberId);
    }
  }
}

function handleExpenseSaved(id, response, details) {
  // Dòng đang chờ xóa (PUT chạy trước khi bấm xóa): chỉ giữ bản mới nhất để "Hoàn tác" hiện lại đúng dữ liệu.
  const deleted = deleteQueue.data(id);
  if (deleted) {
    if (response?.expense) deleted.expense = mergeExpense(deleted.expense, response.expense, details.pending, details.participantToggles);
    return;
  }
  noteLocalWrite("expense", id);
  const previous = state.expenses.find((expense) => expense.id === id);
  const merged = mergeSavedExpense(id, response?.expense, details.pending, details.participantToggles);
  const historyDone = previous && response?.expense ? recordExpenseSave(id, previous, response.expense, details.sent) : false;
  if (details.unloading) {
    setSaveStatus("Đã gửi lưu dữ liệu.", "saved");
    return;
  }
  const row = findExpenseRow(id);
  if (row && merged) {
    syncExpenseRow(row, merged, details);
    updateExpenseRowCells(row);
  }
  renderTotals();
  if (!details.settled) return;
  if (duplicatesAwaitingSave.delete(id)) showDuplicateNotice(id);
  // Đang có thông báo xóa (kèm "Hoàn tác"): không thay nó bằng "Đã lưu…" (ô trạng thái lưu đã báo).
  else if (!historyDone && deleteNotice === null) showNotice("Đã lưu thay đổi khoản chi.");
}

function handleExpenseSaveFailed(id, caught, { unloading }) {
  if (deleteQueue.has(id)) return;
  noteSaveFailed(id);
  duplicatesAwaitingSave.delete(id);
  if (unloading) setSaveStatus(`Chưa lưu: ${caught.message}`, "error");
  else showNotice(caught.message, "error");
}

export async function flushExpenseChanges() {
  if (!(await expenseQueue.flush())) {
    throw new Error("Có thay đổi khoản chi chưa lưu. Hãy xử lý lỗi lưu trước khi tiếp tục.");
  }
}

// Chờ dòng đang thêm và mọi thay đổi đang chờ lưu xong (false: còn dòng lưu lỗi).
export async function settleExpenseWork() {
  await pendingAdds;
  return expenseQueue.flush();
}

export function saveExpensesNow() {
  expenseQueue.saveAllNow();
}

export function saveExpensesForUnload() {
  expenseQueue.saveAllForUnload();
}

// Có mạng lại hoặc trang hiện lại: các dòng đang chờ tự thử lại được gửi ngay.
export function retryExpenseSaves() {
  expenseQueue.retryNow();
}

// Dữ liệu mới từ máy chủ (tải lại sau thao tác Admin, làm mới khi quay lại trang). Dòng đang chờ xóa vẫn ẩn (giữ bản
// mới nhất để "Hoàn tác"); khoản chi máy chủ không còn thì thôi chờ xóa. preferLocal: khoản chi trang vừa tự lưu hoặc
// tạo trong lúc chờ phản hồi (bản trên trang mới hơn); removed: khoản chi vừa xóa xong trong lúc đó.
export function mergeServerExpenses(expenses, { preferLocal = new Set(), removed = new Set() } = {}) {
  const result = mergeExpenseLists({ local: state.expenses, server: expenses, preferLocal, removed, isDeleting: (id) => deleteQueue.has(id) });
  for (const expense of result.deleting) deleteQueue.data(expense.id).expense = expense;
  // Khoản chi đang chờ xóa mà máy chủ đã không còn: thôi chờ xóa, bỏ cả thay đổi chưa lưu giữ cho "Hoàn tác" (một điểm
  // khôi phục có thể đưa lại khoản chi cùng id, và dòng đó phải tự lưu như thường).
  for (const id of deleteQueue.pendingIds()) {
    if (result.serverIds.has(id) || !deleteQueue.forget(id)) continue;
    void expenseQueue.discard(id);
    forgetExpense(id);
  }
  for (const id of result.dropped) forgetExpense(id);
  state.expenses = result.expenses;
}

function refocusAddButton(button) {
  if (document.activeElement === button || document.activeElement === document.body) {
    button.focus({ preventScroll: true });
  }
}

export function addExpense() {
  const button = document.querySelector("#add-expense");
  const pendingId = `pending-${crypto.randomUUID()}`;
  const placeholder = {
    id: pendingId,
    payerId: null,
    date: null,
    description: "",
    amountVnd: 0,
    participantIds: [],
  };
  state.expenses.push(placeholder);
  const row = createExpenseRow(placeholder);
  insertExpenseRow(row);
  animateRowIn(row);
  // Đang lọc/sắp xếp: dòng mới vẫn hiện ở cuối tới khi bộ lọc đổi.
  pinExpenseRow(pendingId);
  renderTotals();
  refocusAddButton(button);
  // Bấm thêm khi POST trước chưa xong: dòng tạm hiện ngay, các POST chạy lần lượt theo thứ tự bấm.
  queueAdd(() => createExpense(pendingId, button));
  return pendingAdds;
}

function queueAdd(create) {
  addsInFlight += 1;
  refreshHistoryButtons();
  pendingAdds = pendingAdds.then(create).finally(() => {
    addsInFlight -= 1;
    refreshHistoryButtons();
  });
}

// POST xong: dòng thật (hiển thị `shown`, mặc định là khoản chi trống vừa tạo) thay dòng tạm; trả về dòng đó.
// Dữ liệu tải lại trong lúc chờ POST (thao tác Admin) có thể đã mang khoản chi này vào bảng: không để nó hiện hai lần.
// Dòng tải về đó bị bỏ, trừ khi người dùng đang sửa nó (khi đó bỏ dòng tạm).
function placeCreatedExpense(pendingId, expense, shown = expense) {
  noteLocalWrite("expense", expense.id);
  renamePinnedRow(pendingId, expense.id);
  const placeholderRow = findExpenseRow(pendingId);
  const loadedRow = findExpenseRow(expense.id);
  if (loadedRow && (expenseQueue.get(expense.id) || loadedRow.contains(document.activeElement))) {
    state.expenses = state.expenses.filter((item) => item.id !== pendingId);
    placeholderRow?.remove();
    return loadedRow;
  }
  loadedRow?.remove();
  state.expenses = state.expenses.filter((item) => item.id !== expense.id);
  const pendingIndex = state.expenses.findIndex((item) => item.id === pendingId);
  if (pendingIndex !== -1) state.expenses[pendingIndex] = expense;
  else state.expenses.push(expense);
  const row = createExpenseRow(shown);
  if (placeholderRow) {
    replaceExpenseRow(placeholderRow, row);
  } else {
    insertExpenseRow(row);
    animateRowIn(row);
  }
  return row;
}

// POST lỗi: bỏ dòng tạm.
function dropPlaceholder(pendingId) {
  const pendingIndex = state.expenses.findIndex((item) => item.id === pendingId);
  if (pendingIndex !== -1) state.expenses.splice(pendingIndex, 1);
  const placeholderRow = findExpenseRow(pendingId);
  if (placeholderRow) removeExpenseRow(placeholderRow);
  renderTotals();
}

async function createExpense(pendingId, button) {
  try {
    const { expense } = await api("/api/expenses", { method: "POST", body: "{}" });
    placeCreatedExpense(pendingId, expense);
    recordExpenseAdd(expense.id);
    renderTotals();
    refocusAddButton(button);
  } catch (caught) {
    dropPlaceholder(pendingId);
    showNotice(caught.message, "error");
  }
}

// Nút × của một dòng.
export function deleteExpense(button) {
  const id = editableExpenseId(button.closest("tr"));
  return id ? removeExpenseWithUndo(id) : undefined;
}

function nextExpenseRowId(row) {
  let next = row.nextElementSibling;
  while (next && !next.dataset.expenseId) next = next.nextElementSibling;
  return next?.dataset.expenseId ?? null;
}

// Dòng đang hiện gần nhất sau (rồi trước) một dòng, để focus không rơi về <body> khi dòng đó bị gỡ.
function neighbourRow(row) {
  for (const step of ["nextElementSibling", "previousElementSibling"]) {
    for (let other = row[step]; other; other = other[step]) {
      if (editableExpenseId(other) && !other.hidden && !other.inert) return other;
    }
  }
  return null;
}

// Xóa một dòng mà người dùng còn hoàn tác được: nút ×, "Hoàn tác" sau khi nhân bản, hoàn tác "Thêm dòng" (record:
// false, lịch sử đã có mục "Thêm dòng"). Dòng thôi khớp tr[data-expense-id] ngay và mờ dần; thay đổi chưa lưu của nó
// được giữ (không gửi) để hiện lại khi hoàn tác, và bị bỏ khi xóa thật. Focus trong dòng chuyển sang cùng ô của dòng
// kế bên (không có thì nút "Add line"). Không gọi máy chủ; luôn trả về Promise.
export function removeExpenseWithUndo(id, { record = true } = {}) {
  const row = findExpenseRow(id);
  const index = state.expenses.findIndex((expense) => expense.id === id);
  if (!row || row.inert || id.startsWith("pending-") || deleteQueue.has(id) || index === -1) return Promise.resolve();
  const focused = row.contains(document.activeElement) ? focusSelector(document.activeElement) : null;
  const neighbour = focused ? neighbourRow(row) : null;
  const [expense] = state.expenses.splice(index, 1);
  expenseQueue.suspend(id);
  const data = {
    expense,
    index,
    // Chỗ cũ của dòng trong bảng (kể cả khi đang lọc/sắp xếp) để hiện lại đúng chỗ.
    nextId: nextExpenseRowId(row),
    row,
    amountText: row.querySelector(".amount-input").value,
    descriptionText: row.querySelector(".description-input").value,
    focused,
    focusedAfter: null,
  };
  deleteQueue.add(id, data);
  removeExpenseRow(row);
  if (focused) {
    data.focusedAfter = neighbour?.querySelector(focused) ?? document.querySelector("#add-expense");
    data.focusedAfter.focus({ preventScroll: true });
  }
  renderTotals();
  if (record) recordExpenseDelete(id, expense.description);
  showDeleteNotice();
  return Promise.resolve();
}

// "Đã xóa khoản chi." (nhiều dòng: "Đã xóa n khoản chi.") kèm "Hoàn tác" cho mọi dòng đang chờ xóa, 6 giây (dừng đếm
// khi rê chuột hay focus vào thông báo). Hết hạn, bấm × hay Esc: gửi DELETE ngay. Bị thông báo khác thay: DELETE gửi
// sau 6 giây nữa (vẫn hoàn tác được bằng nút "Hoàn tác" ở đầu bảng). Xóa thêm một dòng thì hiện lại (đếm lại, 6 giây mới).
function showDeleteNotice() {
  const count = deleteQueue.pendingIds().length;
  clearTimeout(deleteTimer);
  if (!count) {
    hideDeleteNotice();
    return;
  }
  // Thông báo xóa cũ bị thay bằng thông báo mới này: không gửi DELETE.
  deleteNotice = null;
  const token = showNotice(count === 1 ? "Đã xóa khoản chi." : `Đã xóa ${count} khoản chi.`, "success", {
    duration: DELETE_UNDO_MS,
    action: { label: "Hoàn tác", onClick: undoPendingDeletes },
    hint: undoShortcutHint(),
    onDismiss: (reason) => {
      if (deleteNotice !== token) return;
      deleteNotice = null;
      if (reason === "replaced") deleteTimer = setTimeout(() => void commitPendingDeletes(), DELETE_UNDO_MS);
      else void commitPendingDeletes();
    },
  });
  deleteNotice = token;
}

function hideDeleteNotice() {
  if (deleteNotice === null) return;
  const token = deleteNotice;
  deleteNotice = null;
  hideNotice(token);
}

export function hasPendingDelete(id = null) {
  return id === null ? deleteQueue.pendingIds().length > 0 : deleteQueue.isPending(id);
}

// Dòng hiện lại (hoàn tác, DELETE lỗi): bản đã lưu mới nhất, cộng thay đổi chưa lưu còn giữ trong hàng đợi (chữ gõ dở
// như "360,5" hay chữ sai giữ nguyên).
function createRestoredRow({ expense, amountText, descriptionText }) {
  const entry = expenseQueue.get(expense.id);
  const shown = { ...expense, participantIds: [...(expense.participantIds || [])] };
  if (entry) {
    Object.assign(shown, entry.pending);
    for (const [memberId, checked] of entry.participantToggles) {
      shown.participantIds = shown.participantIds.filter((item) => item !== memberId);
      if (checked) shown.participantIds.push(memberId);
    }
  }
  const row = createExpenseRow(shown);
  if (entry && (Object.hasOwn(entry.pending, "amountVnd") || entry.fieldError?.field === "amountVnd")) {
    row.querySelector(".amount-input").value = amountText;
  }
  if (entry && Object.hasOwn(entry.pending, "description")) row.querySelector(".description-input").value = descriptionText;
  updateExpenseRowCells(row);
  return row;
}

// Đặt dòng lại đúng chỗ cũ (trước dòng từng đứng sau nó, kể cả khi đang lọc/sắp xếp), hiệu ứng xuất hiện; trả về dòng.
function putRowBack(data) {
  // Dòng cũ có thể còn đang mờ dần: gỡ nó trước để không hiện hai dòng giống nhau.
  dropExitingRow(data.row);
  const index = Math.min(data.index, state.expenses.length);
  state.expenses.splice(index, 0, data.expense);
  const nextRow = (data.nextId && findExpenseRow(data.nextId)) || (state.expenses.slice(index + 1)
    .map((item) => findExpenseRow(item.id))
    .find(Boolean) ?? null);
  const row = createRestoredRow(data);
  insertExpenseRow(row, nextRow);
  animateRowIn(row);
  return row;
}

// Hoàn tác: dòng hiện lại; focus đã chuyển đi khi xóa (hoặc đang ở thông báo, hay đã rơi về <body>) quay về đúng ô cũ.
function restorePendingDelete(id) {
  const data = deleteQueue.restore(id);
  if (!data) return false;
  const row = putRowBack(data);
  expenseQueue.resume(id);
  forgetExpenseDelete(id);
  const active = document.activeElement;
  if (data.focused && (!active || active === document.body || active === data.focusedAfter || active.closest("#notice"))) {
    row.querySelector(data.focused)?.focus({ preventScroll: true });
  }
  return true;
}

// Hoàn tác một lần xóa còn chờ (Ctrl+Z, "Làm lại" một dòng vừa thêm). Còn dòng khác chờ xóa thì thông báo đếm lại.
export function restoreDeletedExpense(id) {
  if (!restorePendingDelete(id)) return false;
  renderTotals();
  showDeleteNotice();
  return true;
}

// "Hoàn tác" của thông báo xóa: hiện lại mọi dòng đang chờ xóa (dòng xóa sau cùng trước, để mỗi dòng về đúng chỗ).
function undoPendingDeletes() {
  deleteNotice = null;
  clearTimeout(deleteTimer);
  const restored = deleteQueue.pendingIds().reverse().filter(restorePendingDelete);
  if (restored.length) renderTotals();
}

// Gửi DELETE của mọi dòng đang chờ xóa (sau PUT đang chạy của dòng đó) và chờ xong; kết quả: true/false mỗi dòng
// (false: máy chủ từ chối, dòng đã hiện lại).
export function commitPendingDeletes() {
  clearTimeout(deleteTimer);
  hideDeleteNotice();
  return Promise.all(deleteQueue.ids().map((id) => {
    const data = deleteQueue.data(id);
    const inFlight = expenseQueue.discard(id).then((saved) => {
      if (saved?.expense && data) data.expense = { ...saved.expense };
    });
    return deleteQueue.commit(id, { wait: inFlight });
  }));
}

// Trước Store, khôi phục và đăng xuất: dừng nếu máy chủ từ chối một lần xóa (dòng đó đã hiện lại kèm lỗi), để thao
// tác không chạy với dòng người dùng tưởng đã xóa và lỗi không bị thông báo thành công che mất.
export async function flushPendingDeletes() {
  if ((await commitPendingDeletes()).includes(false)) {
    throw new Error(`${lastDeleteFailure}\nCó khoản chi chưa xóa được. Hãy xử lý lỗi trước khi tiếp tục.`.trim());
  }
}

// Trang ẩn hoặc đang đóng: gửi ngay mọi DELETE còn chờ (keepalive). Khi trang đóng hẳn không còn ai nhận lỗi, nên
// DELETE bị từ chối lúc đó không hiện lại dòng được (lần mở sau dòng vẫn còn).
export function commitDeletesNow() {
  clearTimeout(deleteTimer);
  hideDeleteNotice();
  for (const id of deleteQueue.ids()) expenseQueue.discard(id);
  deleteQueue.sendAllNow();
}

function handleDeleteCommitted(id) {
  noteLocalWrite("delete", id);
  forgetExpense(id);
}

// DELETE bị từ chối (mạng, 5xx, 429…): dòng về đúng chỗ cũ như trước khi xóa và báo lỗi (nói rõ khoản nào, vì lúc đó
// người dùng đã thấy "Đã xóa"); không bao giờ báo "Đã xóa". Trang đang ẩn thì lỗi chờ tới khi trang hiện lại mới đếm giờ.
function handleDeleteFailed(id, caught, data) {
  if (state.expenses.some((expense) => expense.id === id)) return;
  putRowBack(data);
  forgetExpenseDelete(id);
  renderTotals();
  const description = String(data.expense?.description ?? "").trim();
  lastDeleteFailure = `Chưa xóa được khoản chi${description ? ` "${description}"` : ""}: ${caught.message || "Hãy thử lại sau."}`;
  showNotice(lastDeleteFailure, "error");
}

const COPIED_FIELDS = ["payerId", "date", "description", "amountVnd"];

// Nút nhân bản: dòng tạm mang đúng các giá trị đang hiển thị của dòng gốc hiện ngay ở cuối bảng (nền sáng lên),
// rồi POST tạo khoản chi và một PUT (qua hàng đợi tự lưu) điền người chi, ngày, nội dung, chi phí, người tham gia.
// Bấm đúp chỉ tạo một bản sao (lần bấm thứ hai của cú bấm đúp có event.detail = 2).
export function duplicateExpense(button, event = null) {
  const source = button.closest("tr");
  const sourceId = editableExpenseId(source);
  if (!sourceId || source.inert || event?.detail > 1) return undefined;
  const shown = readExpenseRow(source);
  let amountVnd;
  try {
    amountVnd = parseAmountInput(source.querySelector(".amount-input").value);
  } catch {
    // Ô Chi phí đang gõ sai: bản sao lấy số tiền đã lưu.
    amountVnd = state.expenses.find((expense) => expense.id === sourceId)?.amountVnd ?? 0;
  }
  const copy = {
    payerId: shown.payerId,
    date: shown.date,
    description: shown.description,
    amountVnd,
    participantIds: shown.participantIds,
  };
  const pendingId = `pending-${crypto.randomUUID()}`;
  const placeholder = { id: pendingId, ...copy };
  state.expenses.push(placeholder);
  const row = createExpenseRow(placeholder);
  insertExpenseRow(row);
  animateRowIn(row);
  highlightCopy(row);
  pinExpenseRow(pendingId);
  renderTotals();
  row.querySelector(".member-actions").scrollIntoView({ block: "nearest", inline: "nearest" });
  queueAdd(() => createDuplicate(pendingId, copy));
  return pendingAdds;
}

async function createDuplicate(pendingId, copy) {
  let expense;
  try {
    ({ expense } = await api("/api/expenses", { method: "POST", body: "{}" }));
  } catch (caught) {
    dropPlaceholder(pendingId);
    showNotice(caught.message, "error");
    return;
  }
  // Thành viên bị xóa trong lúc chờ: bỏ khỏi bản sao (máy chủ sẽ từ chối cả lần lưu).
  const memberIds = new Set(state.members.map((member) => member.id));
  const values = {
    ...copy,
    payerId: memberIds.has(copy.payerId) ? copy.payerId : null,
    participantIds: copy.participantIds.filter((memberId) => memberIds.has(memberId)),
  };
  const row = placeCreatedExpense(pendingId, expense, { ...expense, ...values });
  // Lịch sử: một mục "Nhân bản" (hoàn tác = xóa bản sao); lần điền giá trị ngay sau đây không là thay đổi riêng.
  recordExpenseAdd(expense.id, { duplicate: true });
  // Người dùng đã kịp sửa dòng tải về (placeCreatedExpense giữ dòng đó): trường họ đã sửa không bị ghi đè.
  const edited = expenseQueue.get(expense.id);
  const filled = {};
  for (const field of COPIED_FIELDS) {
    if (values[field] === expense[field] || (edited && Object.hasOwn(edited.pending, field))) continue;
    filled[field] = values[field];
  }
  const ticks = values.participantIds.filter((memberId) => !edited?.participantToggles.has(memberId));
  setRowValues(row, expense.id, { fields: filled, add: ticks, remove: [] });
  const queued = Object.keys(filled).length > 0 || ticks.length > 0;
  if (queued) markDuplicateFill(expense.id, filled, ticks);
  if (queued) duplicatesAwaitingSave.add(expense.id);
  else showDuplicateNotice(expense.id);
}

function showDuplicateNotice(id) {
  showNotice("Đã nhân bản khoản chi.", "success", {
    action: { label: "Hoàn tác", onClick: () => removeExpenseWithUndo(id) },
    hint: undoShortcutHint(),
  });
}

// ---------- Cho lịch sử hoàn tác (expense-history.js) ----------

// Bản đã lưu của một khoản chi đang hiện trong bảng (null: không còn, đang chờ xóa hoặc chưa có trên máy chủ).
export function readSavedExpense(id) {
  if (deleteQueue.has(id) || !findExpenseRow(id)) return null;
  const expense = state.expenses.find((item) => item.id === id);
  return expense ? { ...expense, participantIds: [...(expense.participantIds || [])] } : null;
}

export function expenseDescription(id) {
  return (state.expenses.find((expense) => expense.id === id) ?? deleteQueue.data(id)?.expense)?.description ?? null;
}

export function expenseHasQueuedWork(id) {
  return expenseQueue.busy(id);
}

// Hoàn tác/làm lại: đặt giá trị vào các ô của dòng rồi lưu qua hàng đợi như khi người dùng sửa (gửi ngay).
export function applyHistoryValues(id, values) {
  const row = findExpenseRow(id);
  if (!row) return false;
  setRowValues(row, id, values);
  return true;
}

// Đặt giá trị vào các ô của một dòng và xếp lưu ngay (hoàn tác/làm lại, điền bản sao vừa nhân bản).
function setRowValues(row, id, { fields, add, remove }) {
  for (const [field, value] of Object.entries(fields)) {
    if (field === "payerId") setPayerValue(row.querySelector(".payer-input"), value ?? "");
    else if (field === "date") row.querySelector(".date-input").value = value ?? "";
    else if (field === "description") row.querySelector(".description-input").value = value ?? "";
    else if (field === "amountVnd") row.querySelector(".amount-input").value = value ? formatThousandInput(value) : "";
    expenseQueue.update(id, field, value, 0);
  }
  for (const [memberIds, checked] of [[add, true], [remove, false]]) {
    for (const memberId of memberIds) {
      const checkbox = row.querySelector(`input[type=checkbox][data-member-id="${CSS.escape(memberId)}"]`);
      if (checkbox) checkbox.checked = checked;
      expenseQueue.toggleParticipant(id, memberId, checked, 0);
    }
  }
  updateExpensePreview(row);
}
