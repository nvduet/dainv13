// Phần tổng quan đầu trang, bảng Summary, ô "Đã chuyển khoản" và nút Done.
// expenses.js và summary.js nhập lẫn nhau; cả hai chỉ khai báo hàm nên không có vấn đề thứ tự nạp module.
import { calculateBalances } from "/accounting.mjs";
import { MAX_AMOUNT_VND } from "/shared/constants.mjs";
import { api } from "./api.js";
import { renderDetailViewStatus } from "./detail-view.js";
import { flushExpenseChanges, getExpensePreview, notePaymentWrite } from "./expenses.js";
import {
  balanceClass,
  escapeHtml,
  formatTransferInput,
  formatVnd,
  formatVndInput,
  groupColorClass,
  parseTransferInput,
} from "./format.js";
import { refreshMemberDetail } from "./member-detail.js";
import { state } from "./state.js";
import { setSaveStatus, showNotice } from "./ui.js";

const MAX_TRANSFER_VND = BigInt(MAX_AMOUNT_VND);
const SUMMARY_ROWS = [
  {
    label: "Tên thành viên",
    value: (member) => escapeHtml(member.name),
    // Bấm tên mở chi tiết thành viên; chữ của nút đúng bằng tên nên nội dung chữ của ô không đổi.
    content: (member) => `<button class="member-name-button" type="button" data-action="member-detail" data-member-id="${escapeHtml(member.id)}" aria-haspopup="dialog">${escapeHtml(member.name)}</button>`,
    className: "member-name",
    // Hàng tên là tiêu đề cột cho trình đọc màn hình; vẫn nằm trong tbody nên bố cục bảng không đổi.
    header: true,
  },
  { label: "Tiền phải chịu", value: (member) => formatVnd(member.shareVnd) },
  { label: "Đã chi", value: (member) => formatVnd(member.paidExpenseVnd) },
  { label: "Đã chuyển khoản", value: (member) => formatVnd(member.paidToAdminVnd) },
  {
    label: "Số dư",
    value: (member) => formatVnd(member.balanceVnd),
    className: (member) => balanceClass(member.balanceVnd),
  },
];
// Lưu ô "Đã chuyển khoản" theo id thành viên: { inFlight, rerun }.
const transferSaves = new Map();
let summaryShape = "";
let renderingSummary = false;

function isCompleteExpense(expense) {
  return expense.payerId &&
    expense.description &&
    expense.amountVnd !== 0 &&
    expense.participantIds.length > 0;
}

function renderHeader(preview = getExpensePreview()) {
  document.querySelector("#member-count").textContent = String(state.members.length);
  const completeExpenses = preview.filter(isCompleteExpense);
  document.querySelector("#expense-count").textContent = String(completeExpenses.length);
  document.querySelector("#total-spent").textContent = formatVnd(
    completeExpenses.reduce((total, expense) => total + expense.amountVnd, 0),
  );
  document.querySelector("#admin-state").hidden = state.isAdmin;
  document.querySelector("#login-button").hidden = state.isAdmin;
  document.querySelector("#logout-button").hidden = !state.isAdmin;
  document.querySelector("#column-width-details").hidden = !state.isAdmin;
  document.querySelector("#admin-panel").hidden = !state.isAdmin;
  document.querySelector("#ledger-name").textContent = state.ledger.name;
  const brand = document.querySelector(".brand");
  brand.href = `/g/${encodeURIComponent(state.ledger.slug)}`;
  brand.setAttribute("aria-label", `${state.ledger.name} - Trang chủ`);
  document.title = `${state.ledger.name} · Expense`;
}

// Đầu trang, Summary, dòng trạng thái lọc của Detail và chi tiết thành viên đang mở dùng chung một lần đọc bảng.
export function renderTotals(preview = getExpensePreview()) {
  renderHeader(preview);
  renderSummary(preview);
  renderDetailViewStatus(preview);
  refreshMemberDetail(preview);
}

function balanceSegments(summary) {
  const groupsById = new Map(state.groups.map((group) => [group.id, group]));
  const segments = [];
  for (const member of summary) {
    const group = member.groupId ? groupsById.get(member.groupId) : null;
    const previousSegment = segments.at(-1);
    if (group && previousSegment?.group?.id === group.id) {
      previousSegment.members.push(member);
    } else {
      segments.push({ group, members: [member] });
    }
  }
  return segments;
}

function renderTransferInput(member) {
  return `<input class="paid-transfer-input" type="text" inputmode="text" value="${formatVndInput(member.paidToAdminVnd)}" aria-label="Tổng đã chuyển khoản của ${escapeHtml(member.name)}" data-member-id="${escapeHtml(member.id)}">`;
}

function renderSummaryRow(row, rowIndex, summary, groupColorByMemberId) {
  return `
    <tr>
      <th class="summary-label" scope="row">${row.label}</th>
      ${summary.length
        ? summary.map((member) => {
          const className = typeof row.className === "function" ? row.className(member) : row.className || "";
          const isInput = row.label === "Đã chuyển khoản" && state.isAdmin;
          const value = isInput ? renderTransferInput(member) : row.value(member);
          const groupColor = row.label === "Số dư" ? groupColorByMemberId.get(member.id) || "" : "";
          // Tên, số tiền dài bị cắt "…" theo độ rộng cột: hiện đủ khi rê chuột.
          const title = isInput ? "" : ` title="${value}"`;
          const cell = row.header ? "th" : "td";
          const scope = row.header ? ` scope="col"` : "";
          return `<${cell} class="summary-member ${className} ${groupColor}"${scope}${title}>${row.content ? row.content(member) : value}</${cell}>`;
        }).join("")
        // Sổ chưa có thành viên: một ô nhắc trải hết các hàng, nằm giữa phần cột thành viên.
        : rowIndex === 0 ? `<td class="summary-member empty-cell" rowspan="${SUMMARY_ROWS.length}">Thêm thành viên để bắt đầu sổ chi nhé.</td>` : ""}
    </tr>`;
}

function renderGroupBalanceRow(segments) {
  const groupCells = segments.map((segment, index) => {
    const amount = segment.members.reduce((total, member) => total + member.balanceVnd, 0);
    const label = segment.group
      ? `Số dư nhóm ${escapeHtml(segment.group.name)}`
      : `Số dư ${escapeHtml(segment.members[0].name)} chưa thuộc nhóm`;
    return `<td class="summary-member group-balance ${balanceClass(amount)} ${groupColorClass(index)}" colspan="${segment.members.length}" aria-label="${label}: ${formatVnd(amount)}" title="${formatVnd(amount)}">${formatVnd(amount)}</td>`;
  }).join("");
  return `
      <tr class="group-balance-row">
        <th class="summary-label" scope="row">Số dư nhóm</th>
        ${groupCells}
      </tr>`;
}

function renderDoneRow(summary) {
  return `
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

function renderSummary(preview = getExpensePreview()) {
  const summary = calculateBalances(state.members, preview, state.payments);
  const segments = balanceSegments(summary);
  const groupColorByMemberId = new Map();
  segments.forEach((segment, index) => {
    for (const member of segment.members) {
      groupColorByMemberId.set(member.id, groupColorClass(index));
    }
  });
  document.querySelector("#summary-head").innerHTML = "";
  let html = SUMMARY_ROWS.map((row, rowIndex) => renderSummaryRow(row, rowIndex, summary, groupColorByMemberId)).join("");
  if (summary.length) html += renderGroupBalanceRow(segments);
  if (state.isAdmin && summary.length) html += renderDoneRow(summary);
  const tbody = document.querySelector("#summary-body");
  const shape = `${state.isAdmin}|${summary.map((member) => member.id).join(",")}|${segments.map((segment) => segment.members.length).join(",")}`;
  if (shape === summaryShape && tbody.rows.length > 0) {
    patchSummary(tbody, html);
  } else {
    replaceSummary(tbody, html);
  }
  summaryShape = shape;
}

// Cùng cấu trúc bảng: chỉ thay các ô đổi nội dung và giữ nguyên ô "Đã chuyển khoản"
// (giá trị đang gõ, con trỏ, focus và trạng thái sửa không bị mất).
function patchSummary(tbody, html) {
  const fresh = document.createElement("tbody");
  fresh.innerHTML = html;
  [...fresh.rows].forEach((freshRow, rowIndex) => {
    const row = tbody.rows[rowIndex];
    [...freshRow.cells].forEach((freshCell, cellIndex) => {
      const cell = row.cells[cellIndex];
      const input = cell.querySelector(".paid-transfer-input");
      if (input) {
        syncTransferInput(cell, input, freshCell);
      } else if (cell.outerHTML !== freshCell.outerHTML) {
        cell.replaceWith(freshCell);
      }
    });
  });
}

// "Đang sửa" = chữ trong ô khác số đã lưu (thuộc tính value, luôn theo số mới nhất của máy chủ).
// Sửa xong mà trùng số đã lưu (gõ lại đúng số cũ, gõ rồi xóa) thì không còn gì để lưu.
function refreshTransferDirty(input) {
  input.dataset.dirty = String(input.value !== input.defaultValue);
}

function syncTransferInput(cell, input, freshCell) {
  const freshInput = freshCell.querySelector(".paid-transfer-input");
  if (cell.className !== freshCell.className) cell.className = freshCell.className;
  const label = freshInput.getAttribute("aria-label");
  if (input.getAttribute("aria-label") !== label) input.setAttribute("aria-label", label);
  // Ô đang sửa đã có giá trị riêng, nên đổi thuộc tính value không đụng tới chữ đang gõ.
  const value = freshInput.getAttribute("value");
  if (input.getAttribute("value") !== value) input.setAttribute("value", value);
  if (input.dataset.dirty === "true") {
    refreshTransferDirty(input);
  } else if (input.value !== value) {
    input.value = value;
  }
}

// Cấu trúc đổi (thành viên, nhóm, quyền Admin): dựng lại bảng nhưng giữ ô đang sửa theo id thành viên.
function replaceSummary(tbody, html) {
  const active = document.activeElement;
  const kept = [...tbody.querySelectorAll(".paid-transfer-input")]
    .filter((input) => input.dataset.dirty === "true" || input === active)
    .map((input) => ({
      memberId: input.dataset.memberId,
      value: input.value,
      dirty: input.dataset.dirty === "true",
      focused: input === active,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    }));
  // Trình duyệt phát "change" khi gỡ ô đang sửa; bỏ qua để không lưu số tiền gõ dở.
  renderingSummary = true;
  try {
    tbody.innerHTML = html;
  } finally {
    renderingSummary = false;
  }
  for (const saved of kept) {
    const input = findTransferInput(saved.memberId);
    if (!input) continue;
    if (saved.dirty) {
      input.value = saved.value;
      refreshTransferDirty(input);
    }
    if (saved.focused) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(saved.selectionStart, saved.selectionEnd);
      if (input.dataset.dirty === "true") saveTransferOnLeave(input);
    }
  }
}

// Giá trị gán lại bằng mã không làm trình duyệt phát "change" khi rời ô, nên tự lưu khi người dùng rời ô
// (kể cả khi cả cửa sổ mất focus, như "change" của Chrome). Blur do bảng dựng lại gỡ ô thì bỏ qua như handleTransferChange.
function saveTransferOnLeave(input) {
  const handleBlur = () => {
    if (renderingSummary) return;
    input.removeEventListener("blur", handleBlur);
    const memberId = input.dataset.memberId;
    if (input.dataset.dirty === "true" && !transferSaves.get(memberId)?.inFlight) void saveTransferTotal(memberId);
  };
  input.addEventListener("blur", handleBlur);
}

function findTransferInput(memberId) {
  return document.querySelector(`#summary-body .paid-transfer-input[data-member-id="${CSS.escape(memberId)}"]`);
}

export function handleTransferChange(event) {
  if (renderingSummary || !event.target.matches(".paid-transfer-input")) return;
  void saveTransferTotal(event.target.dataset.memberId);
}

export function handleTransferInput(event) {
  if (!event.target.matches(".paid-transfer-input")) return;
  const input = event.target;
  const formatted = formatTransferInput(input.value, input.selectionStart ?? input.value.length);
  input.value = formatted.value;
  input.setSelectionRange(formatted.cursor, formatted.cursor);
  refreshTransferDirty(input);
}

// Cập nhật state.payments từ phản hồi mà không tải lại /api/state; false nếu không đối chiếu được.
function applyTransferLocally(memberId, response) {
  const clientTotal = state.payments
    .filter((payment) => payment.memberId === memberId && payment.status === "confirmed" &&
      payment.direction === "member_to_admin")
    .reduce((total, payment) => total + payment.amountVnd, 0);
  if (response.adjustment && clientTotal + response.adjustmentVnd === response.amountVnd) {
    state.payments.unshift(response.adjustment);
    return true;
  }
  return response.changed === false && clientTotal === response.amountVnd;
}

function saveTransferTotal(memberId, { unloading = false } = {}) {
  let save = transferSaves.get(memberId);
  if (!save) {
    save = { inFlight: null, rerun: false };
    transferSaves.set(memberId, save);
  }
  if (save.inFlight && !unloading) {
    save.rerun = true;
    return save.inFlight;
  }
  const input = findTransferInput(memberId);
  if (!input) return Promise.resolve();
  const submittedValue = input.value;
  const amountValue = parseTransferInput(submittedValue);
  if (amountValue > MAX_TRANSFER_VND || amountValue < -MAX_TRANSFER_VND) {
    if (!unloading) showNotice("Tổng tiền chuyển khoản không được vượt quá 1.000.000.000.000đ.", "error");
    return Promise.resolve();
  }
  const request = api("/api/admin/payments/total", {
    method: "PUT",
    body: JSON.stringify({ memberId, amountVnd: Number(amountValue) }),
    keepalive: unloading,
  });
  if (unloading) {
    request.then((response) => {
      const current = findTransferInput(memberId);
      if (current?.value === submittedValue && applyTransferLocally(memberId, response)) current.dataset.dirty = "false";
    }, (caught) => setSaveStatus(`Chưa lưu: ${caught.message}`, "error"));
    return Promise.resolve();
  }
  save.rerun = false;
  save.inFlight = finishTransferSave(memberId, save, request, submittedValue);
  return save.inFlight;
}

async function finishTransferSave(memberId, save, request, submittedValue) {
  try {
    const response = await request;
    notePaymentWrite();
    // Ô đã được gõ tiếp trong lúc chờ: lưu tiếp số mới. Không còn ô (đã đăng xuất, bảng dựng lại)
    // thì vẫn cập nhật số đã lưu vào Summary.
    const input = findTransferInput(memberId);
    if (input && input.value !== submittedValue) {
      save.rerun = true;
      return;
    }
    if (input) input.dataset.dirty = "false";
    if (!applyTransferLocally(memberId, response)) {
      const data = await api("/api/state");
      state.payments = data.payments;
    }
    renderSummary();
    showNotice("Đã cập nhật tổng tiền chuyển khoản.");
  } catch (caught) {
    showNotice(caught.message, "error");
  } finally {
    save.inFlight = null;
    if (save.rerun && findTransferInput(memberId)) void saveTransferTotal(memberId);
  }
}

function isTransferDirty(memberId) {
  return findTransferInput(memberId)?.dataset.dirty === "true";
}

export async function flushTransferInputs() {
  for (const input of document.querySelectorAll("#summary-body .paid-transfer-input[data-dirty='true']")) {
    const memberId = input.dataset.memberId;
    while (isTransferDirty(memberId)) {
      const inFlight = transferSaves.get(memberId)?.inFlight;
      if (inFlight) {
        await inFlight;
      } else {
        await saveTransferTotal(memberId);
        if (isTransferDirty(memberId) && !transferSaves.get(memberId)?.inFlight) {
          throw new Error("Có thay đổi chuyển khoản chưa lưu. Hãy xử lý lỗi lưu trước khi tiếp tục.");
        }
      }
    }
  }
}

export function saveTransfersForUnload() {
  for (const input of document.querySelectorAll("#summary-body .paid-transfer-input[data-dirty='true']")) {
    void saveTransferTotal(input.dataset.memberId, { unloading: true });
  }
}

export async function doneTransfer(button) {
  if (!state.isAdmin) return;
  await flushExpenseChanges();
  const member = calculateBalances(state.members, getExpensePreview(), state.payments)
    .find((item) => item.id === button.dataset.memberId);
  if (!member) throw new Error("Không tìm thấy thành viên để cập nhật.");
  const targetVnd = member.shareVnd - member.paidExpenseVnd;
  if (!Number.isSafeInteger(targetVnd) || Math.abs(targetVnd) > MAX_AMOUNT_VND) {
    throw new Error("Số tiền mục tiêu vượt giới hạn cho phép.");
  }
  const input = findTransferInput(member.id);
  if (!input) throw new Error("Không tìm thấy ô Đã chuyển khoản tương ứng.");
  input.value = formatVndInput(targetVnd);
  refreshTransferDirty(input);
  await saveTransferTotal(member.id);
}
