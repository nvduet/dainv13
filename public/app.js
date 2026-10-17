import { calculateBalances, parseThousandInput } from "/accounting.mjs";

const state = {
  members: [],
  expenses: [],
  payments: [],
  isAdmin: false,
  historyPoints: [],
};

const DEFAULT_COLUMN_WIDTHS = {
  expense: {
    payer: 110,
    date: 110,
    description: 145,
    amount: 100,
    member: 80,
    count: 52,
    avg: 94,
    actions: 68,
  },
  summary: {
    label: 120,
    member: 130,
  },
};

let columnWidths = JSON.parse(JSON.stringify(DEFAULT_COLUMN_WIDTHS));

function renderColumnWidths() {
  for (const [key, value] of Object.entries(columnWidths.expense)) {
    document.querySelector(`#col-width-${key}`).value = value;
  }
  for (const [key, value] of Object.entries(columnWidths.summary)) {
    document.querySelector(`#col-width-summary-${key}`).value = value;
  }
  document.querySelector("#expense-member-column-count").textContent = `(${state.members.length} cột)`;
  document.querySelector("#summary-member-column-count").textContent = `(${state.members.length} cột)`;
  applyExpenseColumnWidths();
  applySummaryColumnWidths();
}

// Áp dụng độ rộng cột vào bảng chi phí
function applyExpenseColumnWidths() {
  const w = columnWidths.expense;
  const styleEl = document.getElementById("dynamic-column-widths");
  if (!styleEl) return;

  styleEl.textContent = `
    .expense-table { width: ${w.payer + w.date + w.description + w.amount + state.members.length * w.member + w.count + w.avg + w.actions}px !important; min-width: 0 !important; max-width: none !important; table-layout: fixed !important; }
    .expense-table .expense-payer { width: ${w.payer}px !important; min-width: ${w.payer}px !important; max-width: ${w.payer}px !important; }
    .expense-table .expense-date { width: ${w.date}px !important; min-width: ${w.date}px !important; max-width: ${w.date}px !important; }
    .expense-table .expense-description { width: ${w.description}px !important; min-width: ${w.description}px !important; max-width: ${w.description}px !important; }
    .expense-table .expense-amount { width: ${w.amount}px !important; min-width: ${w.amount}px !important; max-width: ${w.amount}px !important; }
    .expense-table .member-check { width: ${w.member}px !important; min-width: ${w.member}px !important; max-width: ${w.member}px !important; }
    .expense-table .expense-count { width: ${w.count}px !important; min-width: ${w.count}px !important; max-width: ${w.count}px !important; }
    .expense-table .expense-average { width: ${w.avg}px !important; min-width: ${w.avg}px !important; max-width: ${w.avg}px !important; }
    .expense-table .member-actions { width: ${w.actions}px !important; min-width: ${w.actions}px !important; max-width: ${w.actions}px !important; }
  `;
}

// Áp dụng độ rộng cột vào bảng summary
function applySummaryColumnWidths() {
  const w = columnWidths.summary;
  const styleEl = document.getElementById("dynamic-summary-widths");
  if (!styleEl) return;
  const memberColumnCount = Math.max(state.members.length, 1);

  styleEl.textContent = `
    .summary-table { width: ${w.label + memberColumnCount * w.member}px !important; min-width: 0 !important; max-width: none !important; table-layout: fixed !important; }
    .summary-table .summary-label { min-width: ${w.label}px !important; width: ${w.label}px !important; max-width: ${w.label}px !important; }
    .summary-table .summary-member { min-width: ${w.member}px !important; width: ${w.member}px !important; max-width: ${w.member}px !important; }
  `;
}

const notice = document.querySelector("#notice");
const loginDialog = document.querySelector("#login-dialog");
const actionDialog = document.querySelector("#action-dialog");
const viNumber = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
let noticeTimer;
let resolveActionDialog;

function showActionDialog({ title, message = "", inputLabel = "", initialValue = "", inputType = "text", preserveInput = false, confirmLabel = "Xác nhận", danger = false }) {
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
  actionDialog.showModal();
  if (inputLabel) input.focus();
  return new Promise((resolve) => { resolveActionDialog = resolve; });
}

document.querySelector("#action-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#action-dialog-input");
  const isEmpty = input.dataset.preserveInput === "true"
    ? input.value.length === 0
    : !input.value.trim();
  if (input.dataset.needsValue === "true" && isEmpty) {
    document.querySelector("#action-dialog-error").textContent = "Trường này không được để trống.";
    return;
  }
  actionDialog.close("confirm");
});
document.querySelector("#expense-body").addEventListener("focusout", (event) => {
  if (event.target.matches(".amount-input, .description-input")) {
    scheduleAutoSave(event.target.closest("tr"), 0);
  }
});
document.querySelector("#action-dialog-cancel").addEventListener("click", () => actionDialog.close("cancel"));
document.querySelector("#action-dialog-close").addEventListener("click", () => actionDialog.close("cancel"));
document.querySelector("#action-dialog-input").addEventListener("input", () => {
  document.querySelector("#action-dialog-error").textContent = "";
});
actionDialog.addEventListener("close", () => {
  if (!resolveActionDialog) return;
  const resolve = resolveActionDialog;
  resolveActionDialog = null;
  resolve(actionDialog.returnValue === "confirm"
    ? (document.querySelector("#action-dialog-input").hidden
      ? true
      : (document.querySelector("#action-dialog-input").dataset.preserveInput === "true"
        ? document.querySelector("#action-dialog-input").value
        : document.querySelector("#action-dialog-input").value.trim()))
    : null);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatVnd(amount) {
  return `${viNumber.format(amount)}đ`;
}

function formatVndInput(value) {
  const text = String(value);
  const negative = /^\s*-/.test(text);
  const digits = text.replace(/\D/g, "");
  return digits ? `${negative ? "-" : ""}${BigInt(digits).toLocaleString("vi-VN")}đ` : "";
}

function formatVndInputAtCursor(input) {
  const cursor = input.selectionStart ?? input.value.length;
  const digitsBeforeCursor = input.value.slice(0, cursor).replace(/\D/g, "").length;
  input.value = formatVndInput(input.value);
  let digitCount = 0;
  let nextCursor = 0;
  while (nextCursor < input.value.length && digitCount < digitsBeforeCursor) {
    if (/\d/.test(input.value[nextCursor])) digitCount += 1;
    nextCursor += 1;
  }
  input.setSelectionRange(nextCursor, nextCursor);
}

function formatThousandInput(amountVnd) {
  return (amountVnd / 1000).toFixed(3).replace(/\.?0+$/, "");
}

function formatAverageThousand(amountVnd, count) {
  return (amountVnd / count / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 0 });
}

function showNotice(message, kind = "success") {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 6000);
}

function setButtonLoading(button, label) {
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    credentials: "same-origin",
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Máy chủ trả về dữ liệu không đọc được.");
  }
  if (!response.ok) throw new Error(body.error || `Yêu cầu thất bại (${response.status}).`);
  return body;
}

function getExpensePreview() {
  return [...document.querySelectorAll("#expense-body tr[data-expense-id]")]
    .flatMap((row) => {
      const amountInput = row.querySelector(".amount-input");
      let amountVnd = 0;
      if (amountInput.value.trim()) {
        try {
          amountVnd = parseThousandInput(amountInput.value);
        } catch {
          amountVnd = 0;
        }
      }

      const expense = state.expenses.find((item) => item.id === row.dataset.expenseId);
      const payerId = row.querySelector(".payer-input").value;
      const description = row.querySelector(".description-input").value.trim();
      const participantIds = [...row.querySelectorAll("input[type=checkbox]:checked")]
        .map((checkbox) => checkbox.dataset.memberId);
      return [{
        ...expense,
        id: row.dataset.expenseId,
        payerId: payerId || null,
        description,
        amountVnd,
        participantIds,
      }];
    });
}

function getCompleteExpensePreview() {
  return getExpensePreview().filter((expense) =>
    expense.payerId &&
    expense.description &&
    expense.amountVnd !== 0 &&
    expense.participantIds.length > 0,
  );
}

function renderHeader() {
  document.querySelector("#member-count").textContent = String(state.members.length);
  const completeExpenses = getCompleteExpensePreview();
  document.querySelector("#expense-count").textContent = String(completeExpenses.length);
  document.querySelector("#total-spent").textContent = formatVnd(
    completeExpenses.reduce((total, expense) => total + expense.amountVnd, 0),
  );
  document.querySelector("#admin-state").hidden = state.isAdmin;
  document.querySelector("#login-button").hidden = state.isAdmin;
  document.querySelector("#logout-button").hidden = !state.isAdmin;
  document.querySelector("#column-width-details").hidden = !state.isAdmin;
  document.querySelector("#admin-panel").hidden = !state.isAdmin;
}

const autoSaveTimers = new WeakMap();
const savingRows = new WeakSet();
const pendingExpenseChanges = new WeakMap();
const savingTransferInputs = new WeakSet();

function setSaveStatus(message, status = "saved") {
  const element = document.querySelector("#save-status");
  element.textContent = message;
  element.dataset.state = status;
}

function renderExpenses() {
  const head = document.querySelector("#expense-head");
  const body = document.querySelector("#expense-body");
  head.innerHTML = `<tr>
    <th class="expense-payer">Người chi</th>
    <th class="expense-date">Date</th>
    <th class="expense-description">Nội dung</th>
    <th class="expense-amount">Chi phí</th>
    ${state.members.map((member) => `<th class="member-check">${escapeHtml(member.name)}</th>`).join("")}
    <th class="expense-count">Số người</th>
    <th class="expense-average">Số tiền/Ng</th>
    <th class="member-actions">Xóa</th>
  </tr>`;

  const rows = state.expenses;

  if (rows.length === 0) {
    body.innerHTML = `<tr><td class="empty-cell" colspan="${state.members.length + 7}">Chưa có khoản chi — thêm dòng đầu tiên nhé ✿</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((expense) => {
    const selectedMembers = state.members.filter((member) => expense.participantIds.includes(member.id));
    const count = selectedMembers.length;
    return `<tr data-expense-id="${escapeHtml(expense.id)}">
      <td class="expense-payer"><select class="payer-input" aria-label="Người chi">
        <option value="">Chọn người</option>
        ${state.members.map((member) => `<option value="${escapeHtml(member.id)}" ${member.id === expense.payerId ? "selected" : ""}>${escapeHtml(member.name)}</option>`).join("")}
      </select></td>
      <td class="expense-date"><input class="date-input" type="date" value="${escapeHtml(expense.date || "")}" aria-label="Ngày khoản chi"></td>
      <td class="expense-description"><input class="description-input" type="text" maxlength="200" value="${escapeHtml(expense.description)}" placeholder="Nội dung khoản chi" aria-label="Nội dung"></td>
      <td class="expense-amount"><input class="amount-input" type="text" inputmode="decimal" value="${expense.amountVnd ? formatThousandInput(expense.amountVnd) : ""}" placeholder="0" aria-label="Chi phí, nghìn đồng"></td>
      ${state.members.map((member) => `<td class="member-check"><label class="member-check-toggle"><input type="checkbox" data-member-id="${escapeHtml(member.id)}" aria-label="Chia cho ${escapeHtml(member.name)}" ${expense.participantIds.includes(member.id) ? "checked" : ""}></label></td>`).join("")}
      <td class="share-avg expense-count">${count || "—"}</td>
      <td class="share-avg expense-average">${count ? formatAverageThousand(expense.amountVnd, count) : "—"}</td>
      <td class="member-actions">
        <button class="icon-button delete" type="button" data-action="delete-expense" aria-label="Xóa khoản chi" title="Xóa">×</button>
      </td>
    </tr>`;
  }).join("");
  body.querySelectorAll("tr[data-expense-id]").forEach(updateExpenseMissingFieldHighlights);
}

function updateExpenseMissingFieldHighlights(row) {
  const payerInput = row.querySelector(".payer-input");
  const dateInput = row.querySelector(".date-input");
  const descriptionInput = row.querySelector(".description-input");
  const amountInput = row.querySelector(".amount-input");
  let amountMissing = !amountInput.value.trim();
  if (!amountMissing) {
    try {
      amountMissing = parseThousandInput(amountInput.value) === 0;
    } catch {
      amountMissing = true;
    }
  }
  row.querySelector(".expense-payer").classList.toggle("cell-incomplete", !payerInput.value);
  row.querySelector(".expense-date").classList.toggle("cell-incomplete", !dateInput.value);
  row.querySelector(".expense-description").classList.toggle("cell-incomplete", !descriptionInput.value.trim());
  row.querySelector(".expense-amount").classList.toggle("cell-incomplete", amountMissing);
}

function updateExpenseField(row, field, value, delay = 400) {
  const changes = pendingExpenseChanges.get(row) || {};
  changes[field] = value;
  pendingExpenseChanges.set(row, changes);
  row.dataset.saveError = "false";
  scheduleAutoSave(row, delay);
}

async function saveExpenseRow(row, { keepalive = false } = {}) {
  if (savingRows.has(row)) {
    row.dataset.pendingSave = "true";
    return;
  }
  const changes = pendingExpenseChanges.get(row);
  if (!changes || Object.keys(changes).length === 0) return;
  const submitted = { ...changes };
  row.dataset.pendingSave = "false";
  savingRows.add(row);
  setSaveStatus("Đang lưu vào cơ sở dữ liệu…", "saving");
  try {
    const response = await api(`/api/expenses/${encodeURIComponent(row.dataset.expenseId)}`, {
      method: "PUT",
      body: JSON.stringify(submitted),
      keepalive,
    });
    const latest = pendingExpenseChanges.get(row) || {};
    for (const [field, value] of Object.entries(submitted)) {
      if (Object.is(latest[field], value)) delete latest[field];
    }
    pendingExpenseChanges.set(row, latest);
    const savedExpense = { ...response.expense };
    const savedIndex = state.expenses.findIndex((expense) => expense.id === savedExpense.id);
    if (savedIndex !== -1) state.expenses[savedIndex] = savedExpense;
    if (keepalive) {
      setSaveStatus("Đã gửi lưu dữ liệu.", "saved");
      return;
    }
    setSaveStatus("Đã lưu vào cơ sở dữ liệu.", "saved");
    renderHeader();
    renderSummary();
    if (row.dataset.pendingSave !== "true" && Object.keys(latest).length === 0) {
      showNotice("Đã lưu thay đổi khoản chi.");
    }
  } catch (caught) {
    row.dataset.saveError = "true";
    setSaveStatus(`Chưa lưu: ${caught.message}`, "error");
    if (!keepalive) showNotice(caught.message, "error");
  } finally {
    savingRows.delete(row);
    if (!keepalive && row.dataset.pendingSave === "true" && row.isConnected) {
      scheduleAutoSave(row, 0);
    }
  }
}

function scheduleAutoSave(row, delay = 800) {
  clearTimeout(autoSaveTimers.get(row));
  row.dataset.pendingSave = "true";
  setSaveStatus("Có thay đổi chưa lưu…", "saving");
  autoSaveTimers.set(row, setTimeout(() => {
    autoSaveTimers.delete(row);
    saveExpenseRow(row);
  }, delay));
}

async function flushExpenseRows(rows = [...document.querySelectorAll("#expense-body tr[data-expense-id]")]) {
  for (const row of rows) {
    while (row.isConnected) {
      const changes = pendingExpenseChanges.get(row);
      if ((!changes || Object.keys(changes).length === 0) && !savingRows.has(row)) break;
      if (row.dataset.saveError === "true") {
        throw new Error("Có thay đổi khoản chi chưa lưu. Hãy xử lý lỗi lưu trước khi tiếp tục.");
      }
      clearTimeout(autoSaveTimers.get(row));
      autoSaveTimers.delete(row);
      if (savingRows.has(row)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      } else {
        await saveExpenseRow(row);
      }
    }
  }
}

async function flushPendingTransferInputs() {
  for (const input of document.querySelectorAll("#summary-body .paid-transfer-input[data-dirty='true']")) {
    while (input.isConnected && input.dataset.dirty === "true") {
      if (savingTransferInputs.has(input)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      } else {
        await savePaidTransferTotal(input);
        if (input.isConnected && input.dataset.dirty === "true") {
          throw new Error("Có thay đổi chuyển khoản chưa lưu. Hãy xử lý lỗi lưu trước khi tiếp tục.");
        }
      }
    }
  }
}

async function flushPendingChanges() {
  await flushExpenseRows();
  await flushPendingTransferInputs();
}

function renderSummary() {
  const summary = calculateBalances(state.members, getExpensePreview(), state.payments);
  document.querySelector("#summary-head").innerHTML = "";
  const summaryRows = [
    {
      label: "Tên thành viên",
      value: (member) => escapeHtml(member.name),
      className: "member-name",
    },
    { label: "Tiền phải chịu", value: (member) => formatVnd(member.shareVnd) },
    { label: "Đã chi", value: (member) => formatVnd(member.paidExpenseVnd) },
    { label: "Đã chuyển khoản", value: (member) => formatVnd(member.paidToAdminVnd) },
    {
      label: "Số dư",
      value: (member) => formatVnd(member.balanceVnd),
      className: (member) => member.balanceVnd > 0 ? "balance-positive" :
        member.balanceVnd < 0 ? "balance-negative" : "balance-zero",
    },
  ];
  const tbody = document.querySelector("#summary-body");
  tbody.innerHTML = summaryRows.map((row) => `
    <tr>
      <th class="summary-label" scope="row">${row.label}</th>
      ${summary.length
        ? summary.map((member) => {
          const className = typeof row.className === "function" ? row.className(member) : row.className || "";
          const value = row.label === "Đã chuyển khoản" && state.isAdmin
            ? `<input class="paid-transfer-input" type="text" inputmode="text" value="${formatVndInput(member.paidToAdminVnd)}" aria-label="Tổng đã chuyển khoản của ${escapeHtml(member.name)}" data-member-id="${escapeHtml(member.id)}">`
            : row.value(member);
          return `<td class="summary-member ${className}">${value}</td>`;
        }).join("")
        : `<td class="summary-member empty-cell">Thêm thành viên để bắt đầu sổ chi nhé.</td>`}
    </tr>`).join("");
  if (state.isAdmin && summary.length) {
    tbody.innerHTML += `
      <tr>
        <th class="summary-label" scope="row">Dones</th>
        ${summary.map((member) => {
          return `<td class="summary-member">
            <button class="button button-dark button-small done-transfer-button" type="button"
              data-action="done-transfer" data-member-id="${escapeHtml(member.id)}">Done</button>
          </td>`;
        }).join("")}
      </tr>`;
  }

}

function renderMembers() {
  document.querySelector("#member-list").innerHTML = state.members.map((member) => `
    <li>
      <span>${escapeHtml(member.name)}</span>
      <span class="member-name-actions">
        <button class="member-edit" type="button" data-action="rename-member" data-member-id="${escapeHtml(member.id)}" aria-label="Đổi tên ${escapeHtml(member.name)}" title="Đổi tên">✎</button>
        <button class="icon-button delete" type="button" data-action="delete-member" data-member-id="${escapeHtml(member.id)}" aria-label="Xóa ${escapeHtml(member.name)}" title="Xóa">×</button>
      </span>
    </li>`).join("") || `<li>Chưa có thành viên.</li>`;
}

function render() {
  renderExpenses();
  renderHeader();
  renderSummary();
  if (state.isAdmin) {
    renderMembers();
  }
}

function updateExpensePreview(row) {
  const count = row.querySelectorAll("input[type=checkbox]:checked").length;
  const amountInput = row.querySelector(".amount-input");
  let amountVnd = 0;
  if (amountInput.value.trim()) {
    try {
      amountVnd = parseThousandInput(amountInput.value);
    } catch {
      amountVnd = 0;
    }
  }
  updateExpenseMissingFieldHighlights(row);
  const cells = row.querySelectorAll(".share-avg");
  if (cells.length !== 2) return;
  cells[0].textContent = count || "—";
  cells[1].textContent = count && amountVnd
    ? formatAverageThousand(amountVnd, count)
    : "—";
  renderHeader();
  renderSummary();
}

async function savePaidTransferTotal(input, { keepalive = false } = {}) {
  if (savingTransferInputs.has(input)) {
    input.dataset.pendingSave = "true";
    return;
  }
  const submittedValue = input.value;
  const digits = submittedValue.replace(/\D/g, "");
  const negative = /^\s*-/.test(submittedValue);
  const amountValue = digits
    ? BigInt(digits) * (negative ? -1n : 1n)
    : 0n;
  if (amountValue > 1_000_000_000_000n) {
    showNotice("Tổng tiền chuyển khoản không được vượt quá 1.000.000.000.000đ.", "error");
    return;
  }
  const amountVnd = Number(amountValue);
  input.dataset.pendingSave = "false";
  savingTransferInputs.add(input);
  try {
    await api("/api/admin/payments/total", {
      method: "PUT",
      body: JSON.stringify({ memberId: input.dataset.memberId, amountVnd }),
      keepalive: true,
    });
    if (input.value !== submittedValue) {
      input.dataset.pendingSave = "true";
      return;
    }
    input.dataset.dirty = "false";
    if (!keepalive) {
      const data = await api("/api/state");
      state.payments = data.payments;
      renderSummary();
      showNotice("Đã cập nhật tổng tiền chuyển khoản.");
    }
  } catch (caught) {
    if (!keepalive) showNotice(caught.message, "error");
    else setSaveStatus(`Chưa lưu: ${caught.message}`, "error");
  } finally {
    savingTransferInputs.delete(input);
    if (input.dataset.pendingSave === "true" && input.isConnected) {
      void savePaidTransferTotal(input);
    }
  }
}

async function loadState() {
  const data = await api("/api/state");
  state.members = data.members;
  state.expenses = data.expenses;
  state.payments = data.payments;
  state.isAdmin = data.isAdmin;
  columnWidths = data.columnWidths;
  document.querySelector("#font-size-percent").value = data.fontSize;
  document.documentElement.style.setProperty("--font-scale", String(data.fontSize / 100));
  renderColumnWidths();
  render();
  if (state.isAdmin) await loadHistoryPoints();
  else document.querySelector("#history-points").textContent = "";
}

async function loadHistoryPoints() {
  try {
    const data = await api("/api/admin/history-points");
    state.historyPoints = data.points;
    const container = document.querySelector("#history-points");
    container.innerHTML = state.historyPoints.length
      ? state.historyPoints.map((point) => `
        <div class="history-point-item">
          <span>${escapeHtml(point.createdAt)} · ${point.memberCount} thành viên · ${point.expenseCount} khoản chi</span>
          <button class="button button-light button-small" type="button"
            data-action="restore-history-point" data-point-id="${escapeHtml(point.id)}">Khôi phục</button>
        </div>`).join("")
      : `<p class="section-description">Chưa có điểm lưu nào.</p>`;
  } catch (caught) {
    document.querySelector("#history-points").textContent = `Không tải được danh sách: ${caught.message}`;
  }
}

async function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === "restore-history-point") {
      const point = state.historyPoints.find((item) => item.id === button.dataset.pointId);
      const restorePassword = await showActionDialog({
        title: "Khôi phục điểm dữ liệu?",
        message: `Dữ liệu Detail và Summary sẽ được thay bằng điểm lưu ${point?.createdAt || ""}. Cấu hình giao diện và nhật ký sẽ không bị thay đổi.`,
        inputLabel: "Mật khẩu khôi phục?",
        inputType: "password",
        preserveInput: true,
        confirmLabel: "Khôi phục",
        danger: true,
      });
      if (restorePassword === null) return;
      await flushPendingChanges();
      await api(`/api/admin/history-points/${encodeURIComponent(button.dataset.pointId)}/restore`, {
        method: "POST",
        body: JSON.stringify({ password: restorePassword }),
      });
      await loadState();
      showNotice("Đã khôi phục dữ liệu từ điểm đã chọn.");
      return;
    }
    if (action === "delete-expense") {
      const row = button.closest("tr");
      if (row.dataset.deleting === "true") return;
      const expenseId = row.dataset.expenseId;
      if (!state.expenses.some((expense) => expense.id === expenseId)) return;
      row.dataset.deleting = "true";
      clearTimeout(autoSaveTimers.get(row));
      autoSaveTimers.delete(row);
      if (!savingRows.has(row)) {
        pendingExpenseChanges.delete(row);
        row.dataset.pendingSave = "false";
      }
      row.remove();
      renderHeader();
      renderSummary();
      while (savingRows.has(row)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      clearTimeout(autoSaveTimers.get(row));
      autoSaveTimers.delete(row);
      pendingExpenseChanges.delete(row);
      row.dataset.pendingSave = "false";

      const expenseIndex = state.expenses.findIndex((expense) => expense.id === expenseId);
      if (expenseIndex === -1) return;
      const [expense] = state.expenses.splice(expenseIndex, 1);
      renderExpenses();
      renderHeader();
      renderSummary();
      try {
        await api(`/api/expenses/${encodeURIComponent(expenseId)}`, { method: "DELETE" });
        showNotice("Đã xóa khoản chi.");
      } catch (caught) {
        if (expense) state.expenses.splice(Math.max(0, expenseIndex), 0, expense);
        renderExpenses();
        renderHeader();
        renderSummary();
        throw caught;
      }
      return;
    }
    if (action === "done-transfer") {
      if (!state.isAdmin) return;
      const member = calculateBalances(state.members, getExpensePreview(), state.payments)
        .find((item) => item.id === button.dataset.memberId);
      if (!member) throw new Error("Không tìm thấy thành viên để cập nhật.");
      const targetVnd = member.shareVnd - member.paidExpenseVnd;
      if (!Number.isSafeInteger(targetVnd) || Math.abs(targetVnd) > 1_000_000_000_000) {
        throw new Error("Số tiền mục tiêu vượt giới hạn cho phép.");
      }
      const input = [...document.querySelectorAll(".paid-transfer-input")]
        .find((item) => item.dataset.memberId === member.id);
      if (!input) throw new Error("Không tìm thấy ô Đã chuyển khoản tương ứng.");
      input.value = formatVndInput(targetVnd);
      input.dataset.dirty = "true";
      await savePaidTransferTotal(input);
      return;
    }
    if (action === "rename-member") {
      const member = state.members.find((item) => item.id === button.dataset.memberId);
      const name = await showActionDialog({
        title: "Đổi tên thành viên",
        inputLabel: "Tên thành viên mới",
        initialValue: member?.name || "",
        confirmLabel: "Lưu",
      });
      if (name === null || !name.trim()) return;
      await api(`/api/members/${encodeURIComponent(button.dataset.memberId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadState();
      showNotice("Đã cập nhật tên thành viên.");
      return;
    }
    if (action === "delete-member") {
      const member = state.members.find((item) => item.id === button.dataset.memberId);
      const related = state.expenses.filter((expense) =>
        expense.payerId === button.dataset.memberId || expense.participantIds.includes(button.dataset.memberId),
      ).length;
      const message = `Xóa cứng ${member?.name || "thành viên"}? Thao tác này sẽ xóa ${related} khoản chi có liên quan và mọi thanh toán lịch sử của người này; số dư sẽ thay đổi và không thể hoàn tác.`;
      const confirmed = await showActionDialog({
        title: "Xóa thành viên?",
        message,
        confirmLabel: "Xóa",
        danger: true,
      });
      if (!confirmed) return;
      const result = await api(`/api/members/${encodeURIComponent(button.dataset.memberId)}`, { method: "DELETE" });
      await loadState();
      showNotice(`Đã xóa thành viên và ${result.impactedExpenses} khoản chi liên quan.`);
      return;
    }
  } catch (caught) {
    showNotice(caught.message, "error");
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  let resetLoginLoading;
  try {
    if (form.id === "member-form") {
      const name = new FormData(form).get("name");
      await api("/api/members", { method: "POST", body: JSON.stringify({ name }) });
      form.reset();
      await loadState();
      showNotice("Đã thêm thành viên.");
      return;
    }
    if (form.id === "login-form") {
      const formData = new FormData(form);
      const submitButton = form.querySelector(".login-submit");
      resetLoginLoading = setButtonLoading(submitButton, "Đang đăng nhập");
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({
          username: formData.get("username"),
          password: formData.get("password"),
        }),
      });
      state.isAdmin = true;
      renderHeader();
      renderSummary();
      renderMembers();
      loginDialog.close();
      form.reset();
      document.querySelector("#login-error").textContent = "";
      document.querySelector("#history-points").textContent = "Đang tải điểm khôi phục…";
      void loadHistoryPoints();
      showNotice("Đăng nhập Admin thành công.");
      return;
    }
  } catch (caught) {
    if (form.id === "login-form") {
      document.querySelector("#login-error").textContent = caught.message;
    } else {
      showNotice(caught.message, "error");
    }
  } finally {
    resetLoginLoading?.();
  }
}

async function loadAudit() {
  try {
    const data = await api("/api/admin/audit");
    const actionLabels = {
      create: "tạo",
      update: "sửa",
      store: "lưu điểm khôi phục",
      restore: "khôi phục điểm dữ liệu",
      participant_add: "đánh dấu tham gia",
      participant_remove: "bỏ đánh dấu tham gia",
      delete: "xóa",
      hard_delete: "xóa cứng",
      rename: "đổi tên",
      report: "báo nộp",
      confirm: "xác nhận",
      refund: "ghi hoàn",
      configure: "cấu hình",
      reconcile: "điều chỉnh tổng chuyển khoản",
    };
    const memberById = new Map(state.members.map((member) => [member.id, member.name]));
    const fieldLabels = {
      payerId: "Người chi",
      date: "Ngày",
      description: "Nội dung",
      amountVnd: "Số tiền",
    };
    const showValue = (field, value) => {
      if (field === "amountVnd") return formatVnd(value);
      if (field === "payerId") return memberById.get(value) || value;
      return String(value ?? "—");
    };
    const describeEntry = (entry) => {
      const before = entry.beforeJson ? JSON.parse(entry.beforeJson) : null;
      const after = entry.afterJson ? JSON.parse(entry.afterJson) : null;
      const actor = entry.actor === "admin" ? "Admin" : "Khách";
      if (entry.action === "update" && before?.field && before.field === after?.field) {
        return `${actor} đổi ${fieldLabels[after.field] || after.field} của khoản chi ${entry.entityId}: ${showValue(after.field, before.value)} → ${showValue(after.field, after.value)}`;
      }
      if (entry.action === "participant_add" || entry.action === "participant_remove") {
        const change = after || before;
        return `${actor} ${actionLabels[entry.action]}: ${memberById.get(change.memberId) || "thành viên"} (khoản chi ${change.expenseId})`;
      }
      if (entry.action === "reconcile" && entry.entity === "payment_total") {
        return `${actor} đổi Đã chuyển khoản của ${memberById.get(entry.entityId) || entry.entityId}: ${formatVnd(before.paidToAdminVnd)} → ${formatVnd(after.paidToAdminVnd)}`;
      }
      if (entry.action === "update") {
        return `${actor} ${actionLabels[entry.action]} khoản chi ${entry.entityId}`;
      }
      return `${actor} ${actionLabels[entry.action] || entry.action} ${entry.entity} ${entry.entityId}`;
    };
    document.querySelector("#audit-list").innerHTML = data.entries.map((entry) => `
      <div class="audit-entry">
        ${escapeHtml(entry.createdAt)} · ${escapeHtml(describeEntry(entry))}
      </div>`).join("") || "Chưa có thay đổi.";
  } catch (caught) {
    document.querySelector("#audit-list").textContent = caught.message;
  }
}

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
applyExpenseColumnWidths();
applySummaryColumnWidths();
document.querySelector("#expense-body").addEventListener("input", (event) => {
  const row = event.target.closest("tr");
  if (!row) return;
  if (event.target.matches(".description-input")) {
    updateExpenseField(row, "description", event.target.value);
    updateExpensePreview(row);
  }
  if (event.target.matches(".amount-input")) {
    updateExpensePreview(row);
    if (!event.target.value.trim()) {
      updateExpenseField(row, "amountVnd", 0);
    } else {
      try {
        updateExpenseField(row, "amountVnd", parseThousandInput(event.target.value));
      } catch (caught) {
        const changes = pendingExpenseChanges.get(row);
        if (changes) delete changes.amountVnd;
        setSaveStatus(`Chưa lưu: ${caught.message}`, "error");
      }
    }
  }
});
document.querySelector("#expense-body").addEventListener("change", (event) => {
  const row = event.target.closest("tr");
  if (!row) return;
  if (row && event.target.matches("input[type=checkbox]")) {
    updateExpensePreview(row);
    updateExpenseField(row, "participantIds", [...row.querySelectorAll("input[type=checkbox]:checked")]
      .map((checkbox) => checkbox.dataset.memberId), 100);
  } else if (row && event.target.matches(".payer-input")) {
    updateExpensePreview(row);
    updateExpenseField(row, "payerId", event.target.value || null, 100);
  } else if (row && event.target.matches(".date-input")) {
    updateExpenseMissingFieldHighlights(row);
    updateExpenseField(row, "date", event.target.value || null, 100);
  }
});
document.querySelector("#summary-body").addEventListener("change", (event) => {
  if (event.target.matches(".paid-transfer-input")) savePaidTransferTotal(event.target);
});
document.querySelector("#summary-body").addEventListener("input", (event) => {
  if (event.target.matches(".paid-transfer-input")) {
    event.target.dataset.dirty = "true";
    formatVndInputAtCursor(event.target);
  }
});
document.querySelector("#add-expense").addEventListener("click", async () => {
  const button = document.querySelector("#add-expense");
  const pendingId = `pending-${crypto.randomUUID()}`;
  state.expenses.push({
    id: pendingId,
    payerId: null,
    date: null,
    description: "",
    amountVnd: 0,
    participantIds: [],
  });
  renderExpenses();
  renderHeader();
  renderSummary();
  const pendingRow = [...document.querySelectorAll("#expense-body tr")]
    .find((row) => row.dataset.expenseId === pendingId);
  pendingRow?.querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = true;
  });
  button.focus({ preventScroll: true });

  try {
    const { expense } = await api("/api/expenses", { method: "POST", body: "{}" });
    const pendingIndex = state.expenses.findIndex((item) => item.id === pendingId);
    if (pendingIndex !== -1) state.expenses[pendingIndex] = expense;
    renderExpenses();
    renderHeader();
    renderSummary();
    button.focus({ preventScroll: true });
  } catch (caught) {
    state.expenses = state.expenses.filter((item) => item.id !== pendingId);
    renderExpenses();
    renderHeader();
    renderSummary();
    showNotice(caught.message, "error");
  }
});

document.querySelector("#store-history-point").addEventListener("click", async () => {
  const button = document.querySelector("#store-history-point");
  button.disabled = true;
  try {
    await flushPendingChanges();
    await api("/api/admin/history-points", { method: "POST", body: "{}" });
    await loadHistoryPoints();
    showNotice("Đã lưu điểm khôi phục.");
  } catch (caught) {
    showNotice(caught.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#login-button").addEventListener("click", () => {
  if (!state.isAdmin) loginDialog.showModal();
});
document.querySelector("#close-login").addEventListener("click", () => loginDialog.close());
document.querySelector("#logout-button").addEventListener("click", async () => {
  const button = document.querySelector("#logout-button");
  const resetLoading = setButtonLoading(button, "Đang đăng xuất");
  try {
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    state.isAdmin = false;
    state.historyPoints = [];
    renderHeader();
    renderSummary();
    document.querySelector("#history-points").textContent = "";
    showNotice("Đã đăng xuất.");
  } catch (caught) {
    showNotice(caught.message, "error");
  } finally {
    resetLoading();
  }
});
document.querySelector("#audit-details").addEventListener("toggle", (event) => {
  if (event.target.open) loadAudit();
});
window.addEventListener("pagehide", () => {
  for (const row of document.querySelectorAll("#expense-body tr[data-expense-id]")) {
    if (row.dataset.pendingSave !== "true" && !autoSaveTimers.has(row)) continue;
    clearTimeout(autoSaveTimers.get(row));
    autoSaveTimers.delete(row);
    if (!savingRows.has(row)) void saveExpenseRow(row, { keepalive: true });
  }
  for (const input of document.querySelectorAll("#summary-body .paid-transfer-input[data-dirty='true']")) {
    if (!savingTransferInputs.has(input)) void savePaidTransferTotal(input, { keepalive: true });
  }
});

async function saveColumnWidths(updatedWidths, message) {
  try {
    const { columnWidths: savedWidths } = await api("/api/admin/column-widths", {
      method: "PUT",
      body: JSON.stringify(updatedWidths),
    });
    columnWidths = savedWidths;
    renderColumnWidths();
    showNotice(message);
  } catch (caught) {
    showNotice(caught.message, "error");
  }
}

function readWidthInputs(group) {
  const inputs = Object.keys(columnWidths[group]).map((key) =>
    document.querySelector(`#col-width-${group === "summary" ? "summary-" : ""}${key}`),
  );
  if (inputs.some((input) => !input.checkValidity())) {
    showNotice("Nhập độ rộng từ 24 đến 2.000 px cho tất cả các cột.", "error");
    return null;
  }
  return Object.fromEntries(
    Object.keys(columnWidths[group]).map((key, index) => [key, inputs[index].valueAsNumber]),
  );
}

document.querySelector("#apply-expense-widths").addEventListener("click", () => {
  const expense = readWidthInputs("expense");
  if (!expense) return;
  saveColumnWidths(
    { ...columnWidths, expense },
    "Đã lưu độ rộng cột bảng chi phí.",
  );
});

document.querySelector("#apply-summary-widths").addEventListener("click", () => {
  const summary = readWidthInputs("summary");
  if (!summary) return;
  saveColumnWidths(
    { ...columnWidths, summary },
    "Đã lưu độ rộng cột bảng tổng hợp.",
  );
});

document.querySelector("#reset-column-widths").addEventListener("click", () => {
  saveColumnWidths(
    JSON.parse(JSON.stringify(DEFAULT_COLUMN_WIDTHS)),
    "Đã đặt lại độ rộng cột mặc định.",
  );
});

document.querySelector("#apply-font-size").addEventListener("click", async () => {
  const input = document.querySelector("#font-size-percent");
  if (!input.checkValidity()) {
    showNotice("Cỡ chữ phải nằm trong khoảng 75% đến 200%.", "error");
    return;
  }
  try {
    const { fontSize } = await api("/api/admin/font-size", {
      method: "PUT",
      body: JSON.stringify({ fontSize: input.valueAsNumber }),
    });
    document.documentElement.style.setProperty("--font-scale", String(fontSize / 100));
    input.value = fontSize;
    showNotice("Đã lưu cỡ chữ giao diện.");
  } catch (caught) {
    showNotice(caught.message, "error");
  }
});

loadState().catch((caught) => showNotice(caught.message, "error"));
