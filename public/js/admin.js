// Quản trị: thành viên, nhóm, các sổ, điểm khôi phục, nhật ký phiên; tải dữ liệu và phiên Admin.
import { api } from "./api.js";
import {
  commitPendingDeletes,
  flushExpenseChanges,
  flushPendingDeletes,
  hasPendingDelete,
  mergeServerExpenses,
  renderExpenses,
  settleExpenseWork,
  watchLocalWrites,
} from "./expenses.js";
import { escapeHtml, formatLocalDateTime, formatVnd, unbreakable } from "./format.js";
import { ledgerSignature } from "./return-watch.js";
import { applyDisplaySettings } from "./settings.js";
import { state } from "./state.js";
import { flushTransferInputs, renderTotals } from "./summary.js";
import { finishLoading, isImportantNoticeShown, setButtonLoading, showActionDialog, showNotice } from "./ui.js";

let editingGroupId = null;
// Tên nhóm renderMemberGroups vừa đặt vào ô (để biết Admin có đang gõ dở không).
let renderedGroupName = "";
// Số lần loadState đã áp dữ liệu (0: chưa tải xong lần đầu). Lần làm mới bỏ kết quả nếu loadState áp dữ liệu mới hơn.
let loadGeneration = 0;
let refreshing = false;

// GET /api/state, ghi lại những gì trang tự lưu, tạo hay xóa trong lúc chờ phản hồi (dữ liệu cũ hơn trong phản hồi
// không được đè lên chúng, kể cả khi DELETE của thông báo "Đã xóa" tự gửi trong lúc đó).
async function fetchState() {
  const writes = watchLocalWrites();
  try {
    return { data: await api("/api/state"), writes };
  } finally {
    writes.stop();
  }
}

export async function loadState() {
  const { data, writes } = await fetchState();
  loadGeneration += 1;
  state.ledger = data.ledger;
  state.members = data.members;
  state.groups = data.groups;
  mergeServerExpenses(data.expenses, { preferLocal: writes.expenseIds, removed: writes.deletedIds });
  // Chuyển khoản trang vừa lưu trong lúc chờ: số liệu của phản hồi lưu mới hơn.
  if (!writes.payments) state.payments = data.payments;
  state.isAdmin = data.isAdmin;
  state.storePasswordVerified = data.storePasswordVerified;
  state.loaded = true;
  applyDisplaySettings(data);
  render();
  finishLoading();
  document.querySelector("#export-csv").disabled = false;
  if (state.isAdmin) {
    await loadAdminData();
  } else {
    clearAdminData();
  }
}

const displaySettings = (source) => ({ fontSize: source.fontSize, qrSize: source.qrSize, columnWidths: source.columnWidths });
const signature = (source, settings = displaySettings(source)) => ledgerSignature({ ...source, settings });

// Vị trí cuộn của trang và các khung bảng, để dựng lại bảng mà người dùng vẫn thấy đúng chỗ đang xem.
function captureScroll() {
  return {
    x: window.scrollX,
    y: window.scrollY,
    boxes: [...document.querySelectorAll(".table-scroll")].map((box) => [box, box.scrollLeft, box.scrollTop]),
  };
}

function restoreScroll({ x, y, boxes }) {
  for (const [box, left, top] of boxes) {
    if (box.scrollLeft !== left) box.scrollLeft = left;
    if (box.scrollTop !== top) box.scrollTop = top;
  }
  if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
}

// Quay lại trang sau ≥ 30 giây (app.js): gửi các lần xóa còn chờ và chờ lưu xong, rồi một GET /api/state. Dữ liệu mới
// được hợp nhất mà không mất ô đang sửa, thay đổi chưa lưu hay đang lưu, bộ lọc, cách sắp xếp và vị trí cuộn; chỉ báo
// "Đã cập nhật dữ liệu mới." khi có gì đổi và không che một lỗi (vd. xóa thất bại lúc trang ẩn) hay nút "Hoàn tác".
// Lỗi mạng thì giữ nguyên trang (lần quay lại sau thử lại).
export async function refreshAfterReturn() {
  if (refreshing || loadGeneration === 0) return;
  refreshing = true;
  try {
    await commitPendingDeletes();
    await settleExpenseWork();
    const generation = loadGeneration;
    const { data, writes } = await fetchState();
    if (generation !== loadGeneration) return;
    const changed = applyRefreshedState(data, writes);
    if (changed && !hasPendingDelete() && !isImportantNoticeShown()) showNotice("Đã cập nhật dữ liệu mới.");
  } catch {
    // Không tải được: trang giữ nguyên dữ liệu đang có.
  } finally {
    refreshing = false;
  }
}

function applyRefreshedState(data, writes) {
  const settings = displaySettings(state);
  const before = signature(state, settings);
  const membersBefore = signature({ members: state.members, groups: state.groups, expenses: [], payments: [] });
  const wasAdmin = state.isAdmin;
  const scroll = captureScroll();
  state.ledger = data.ledger;
  state.members = data.members;
  state.groups = data.groups;
  // Chuyển khoản trang vừa lưu trong lúc chờ: số liệu của phản hồi lưu mới hơn.
  if (!writes.payments) state.payments = data.payments;
  state.isAdmin = data.isAdmin;
  state.storePasswordVerified = data.storePasswordVerified;
  mergeServerExpenses(data.expenses, { preferLocal: writes.expenseIds, removed: writes.deletedIds });
  const freshSettings = displaySettings(data);
  if (signature(state, freshSettings) === before) return false;
  const membersChanged = signature({ members: state.members, groups: state.groups, expenses: [], payments: [] }) !== membersBefore;
  if (membersChanged || JSON.stringify(freshSettings) !== JSON.stringify(settings)) applyDisplaySettings(data);
  renderExpenses();
  renderTotals();
  // Danh sách thành viên/nhóm dựng lại cả ô sửa nhóm: chỉ khi chúng đổi, và giữ tên, thành viên Admin đang chọn dở.
  if (state.isAdmin && (membersChanged || !wasAdmin)) {
    const groupForm = captureGroupForm();
    renderMembers();
    restoreGroupForm(groupForm);
  }
  if (state.isAdmin && !wasAdmin) void loadAdminData();
  else if (!state.isAdmin && wasAdmin) clearAdminData();
  restoreScroll(scroll);
  return true;
}

function render() {
  renderExpenses();
  renderTotals();
  if (state.isAdmin) {
    renderMembers();
  }
}

function loadAdminData() {
  return Promise.all([loadHistoryPoints(), loadLedgers(), loadAudit()]);
}

function clearAdminData() {
  state.historyPoints = [];
  state.auditSessions = [];
  state.ledgers = [];
  document.querySelector("#history-points").textContent = "";
  document.querySelector("#ledger-list").textContent = "";
  document.querySelector("#audit-list").textContent = "";
}

// Trước Store và khôi phục: các lần xóa còn chờ được gửi (dòng đã xóa không quay lại), mọi thay đổi được lưu. Một lần
// xóa hay lưu bị từ chối thì dừng (lỗi hiện ra, Store không chụp dòng người dùng tưởng đã xóa).
async function flushPendingChanges() {
  await flushPendingDeletes();
  await flushExpenseChanges();
  await flushTransferInputs();
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
  renderMemberGroups();
}

// Ô tạo/sửa nhóm đang gõ dở: tên khác tên vừa dựng, thành viên chọn/bỏ khác lựa chọn vừa dựng (defaultSelected là
// lựa chọn renderMemberGroups đặt).
function captureGroupForm() {
  const name = document.querySelector("#member-group-name").value;
  return {
    name: name !== renderedGroupName ? name : null,
    toggled: new Map([...document.querySelector("#member-group-members").options]
      .filter((option) => option.selected !== option.defaultSelected)
      .map((option) => [option.value, option.selected])),
  };
}

// Thành viên đã bị xóa hoặc đã vào nhóm khác (ô bị tắt) thì bỏ khỏi lựa chọn.
function restoreGroupForm({ name, toggled }) {
  if (name !== null) document.querySelector("#member-group-name").value = name;
  for (const option of document.querySelector("#member-group-members").options) {
    if (toggled.has(option.value) && !option.disabled) option.selected = toggled.get(option.value);
  }
}

function renderMemberGroups() {
  const memberSelect = document.querySelector("#member-group-members");
  const currentGroup = state.groups.find((group) => group.id === editingGroupId);
  const membersById = new Map(state.members.map((member) => [member.id, member]));
  memberSelect.innerHTML = state.members.map((member) => {
    const assignedToOther = member.groupId && member.groupId !== editingGroupId;
    return `<option value="${escapeHtml(member.id)}" ${currentGroup?.memberIds.includes(member.id) ? "selected" : ""} ${assignedToOther ? "disabled" : ""}>${escapeHtml(member.name)}${assignedToOther ? " (đã thuộc nhóm khác)" : ""}</option>`;
  }).join("");
  renderedGroupName = currentGroup?.name || "";
  document.querySelector("#member-group-name").value = renderedGroupName;
  document.querySelector("#member-group-submit").textContent = currentGroup ? "Lưu nhóm" : "Tạo nhóm";
  document.querySelector("#cancel-member-group-edit").hidden = !currentGroup;
  document.querySelector("#member-group-list").innerHTML = state.groups.map((group) => `
    <li>
      <span><strong>${escapeHtml(group.name)}</strong>: ${escapeHtml(group.memberIds.map((id) =>
        membersById.get(id)?.name || id).join(", "))}</span>
      <span class="member-name-actions">
        <button class="member-edit" type="button" data-action="edit-member-group" data-group-id="${escapeHtml(group.id)}">Sửa</button>
        <button class="icon-button delete" type="button" data-action="delete-member-group" data-group-id="${escapeHtml(group.id)}" aria-label="Xóa nhóm ${escapeHtml(group.name)}" title="Xóa">×</button>
      </span>
    </li>`).join("") || "<li>Chưa có nhóm.</li>";
}

async function loadLedgers() {
  try {
    const data = await api("/api/admin/ledgers");
    state.ledgers = data.ledgers;
    document.querySelector("#ledger-list").innerHTML = state.ledgers.map((ledger) => `
      <li>
        <a href="/g/${encodeURIComponent(ledger.slug)}">${escapeHtml(ledger.name)}</a>
        <span class="ledger-actions">
          ${ledger.slug === state.ledger.slug ? "<strong>Đang mở</strong>" : ""}
          ${ledger.slug === "chill-guys" ? "<span class=\"protected-ledger\">Mặc định · không thể xóa</span>" : `
            <button class="icon-button delete" type="button" data-action="delete-ledger"
              data-ledger-slug="${escapeHtml(ledger.slug)}" data-ledger-name="${escapeHtml(ledger.name)}"
              aria-label="Xóa sổ ${escapeHtml(ledger.name)}" title="Xóa sổ">×</button>`}
        </span>
      </li>`).join("");
  } catch (caught) {
    document.querySelector("#ledger-list").textContent = `Không tải được danh sách sổ: ${caught.message}`;
  }
}

async function loadHistoryPoints() {
  try {
    const data = await api("/api/admin/history-points");
    state.historyPoints = data.points;
    const container = document.querySelector("#history-points");
    container.innerHTML = state.historyPoints.length
      ? state.historyPoints.map((point) => `
        <div class="history-point-item">
          <span><strong>${escapeHtml(point.message || "Không có message")}</strong><br>
            ${escapeHtml(formatLocalDateTime(point.createdAt))} · ${point.memberCount} thành viên · ${point.expenseCount} khoản chi</span>
          <button class="button button-light button-small" type="button"
            data-action="restore-history-point" data-point-id="${escapeHtml(point.id)}">Khôi phục</button>
        </div>`).join("")
      : `<p class="section-description">Chưa có điểm lưu nào.</p>`;
  } catch (caught) {
    document.querySelector("#history-points").textContent = `Không tải được danh sách: ${caught.message}`;
  }
}

async function loadAudit() {
  try {
    const data = await api("/api/admin/audit");
    state.auditSessions = data.sessions;
    document.querySelector("#audit-list").innerHTML = state.auditSessions.map((session) => {
      const actors = [
        ...(session.adminSeen ? ["Admin"] : []),
        ...(session.guestSeen ? ["Khách"] : []),
      ];
      return `<div class="audit-entry audit-session-entry">
        <span>${escapeHtml(formatLocalDateTime(session.startedAt))} · ${escapeHtml(actors.join(" + "))}</span>
        <button class="button button-light button-small" type="button"
          data-action="audit-session-diff" data-session-id="${escapeHtml(session.id)}">Xem diff</button>
      </div>`;
    }).join("") || "Chưa có phiên thay đổi.";
  } catch (caught) {
    document.querySelector("#audit-list").textContent = caught.message;
  }
}

function renderAuditSnapshotTable(snapshot, changeTypes, memberChangeTypes) {
  const members = snapshot.members || [];
  const memberNames = new Map(members.map((member) => [member.id, member.name]));
  const rows = snapshot.expenses || [];
  return `<div class="audit-diff-table-scroll">
    <table class="audit-diff-table">
      <thead><tr>
        <th>Người chi</th><th>Date</th><th>Nội dung</th><th>Chi phí</th>
        ${members.map((member) => {
          const changeType = memberChangeTypes.get(member.id);
          return `<th class="${changeType ? `diff-${changeType}` : ""}">${escapeHtml(member.name)}</th>`;
        }).join("")}
      </tr></thead>
      <tbody>${rows.map((expense) => {
        const changeType = changeTypes.get(expense.id);
        const participants = new Set(expense.participantIds || []);
        return `<tr class="${changeType ? `diff-${changeType}` : ""}">
          <td>${escapeHtml(memberNames.get(expense.payerId) || "—")}</td>
          <td>${escapeHtml(expense.date || "—")}</td>
          <td>${escapeHtml(expense.description || "—")}</td>
          <td>${escapeHtml(formatVnd(expense.amountVnd))}</td>
          ${members.map((member) => `<td>${participants.has(member.id) ? "✓" : ""}</td>`).join("")}
        </tr>`;
      }).join("") || `<tr><td colspan="${members.length + 4}">Không có khoản chi.</td></tr>`}</tbody>
    </table>
  </div>`;
}

function renderAuditSessionDiff(session) {
  const beforeExpenses = new Map((session.before.expenses || []).map((expense) => [expense.id, expense]));
  const afterExpenses = new Map((session.after.expenses || []).map((expense) => [expense.id, expense]));
  const beforeMembers = new Map((session.before.members || []).map((member) => [member.id, member]));
  const afterMembers = new Map((session.after.members || []).map((member) => [member.id, member]));
  const beforeChanges = new Map();
  const afterChanges = new Map();
  const beforeMemberChanges = new Map();
  const afterMemberChanges = new Map();
  const comparable = (expense) => JSON.stringify({
    payerId: expense.payerId,
    date: expense.date,
    description: expense.description,
    amountVnd: expense.amountVnd,
    participantIds: [...(expense.participantIds || [])].sort(),
  });
  const memberContext = (snapshot, member) => {
    const group = (snapshot.groups || []).find((item) => item.id === member.groupId);
    return JSON.stringify([
      member.name,
      member.position,
      member.groupId,
      group?.name,
      group?.position,
    ]);
  };
  for (const [id, before] of beforeExpenses) {
    const after = afterExpenses.get(id);
    if (!after) beforeChanges.set(id, "deleted");
    else if (comparable(before) !== comparable(after)) {
      beforeChanges.set(id, "modified");
      afterChanges.set(id, "modified");
    }
  }
  for (const id of afterExpenses.keys()) {
    if (!beforeExpenses.has(id)) afterChanges.set(id, "added");
  }
  for (const [id, before] of beforeMembers) {
    const after = afterMembers.get(id);
    if (!after) beforeMemberChanges.set(id, "deleted");
    else if (memberContext(session.before, before) !== memberContext(session.after, after)) {
      beforeMemberChanges.set(id, "modified");
      afterMemberChanges.set(id, "modified");
    }
  }
  for (const id of afterMembers.keys()) {
    if (!beforeMembers.has(id)) afterMemberChanges.set(id, "added");
  }
  const actorNames = session.actors.map((actor) => actor === "admin" ? "Admin" : "Khách");
  document.querySelector("#audit-diff-title").textContent = `Detail · ${actorNames.join(" + ")}`;
  document.querySelector("#audit-diff-content").innerHTML = `
    <p class="section-description">Phiên ${escapeHtml(unbreakable(formatLocalDateTime(session.startedAt)))} · hoạt động gần nhất ${escapeHtml(unbreakable(formatLocalDateTime(session.lastActivity)))} · Có thay đổi từ: ${actorNames.map((name) => `<span class="audit-actor">${escapeHtml(name)}</span>`).join(" ")}</p>
    <div class="audit-diff-legend">
      <span class="diff-deleted">Xóa</span>
      <span class="diff-added">Thêm</span>
      <span class="diff-modified">Sửa</span>
    </div>
    <div class="audit-diff-panels">
      <section class="audit-diff-panel"><h3>Trước phiên</h3>${renderAuditSnapshotTable(session.before, beforeChanges, beforeMemberChanges)}</section>
      <section class="audit-diff-panel"><h3>Sau phiên</h3>${renderAuditSnapshotTable(session.after, afterChanges, afterMemberChanges)}</section>
    </div>`;
}

export async function showAuditSessionDiff(button) {
  const { session } = await api(`/api/admin/audit/${encodeURIComponent(button.dataset.sessionId)}`);
  renderAuditSessionDiff(session);
  document.querySelector("#audit-diff-dialog").showModal();
}

export function closeAuditDiffDialog() {
  document.querySelector("#audit-diff-dialog").close();
}

export function editMemberGroup(button) {
  editingGroupId = button.dataset.groupId;
  renderMemberGroups();
  document.querySelector("#member-group-name").focus();
}

export function cancelMemberGroupEdit() {
  editingGroupId = null;
  document.querySelector("#member-group-form").reset();
  renderMemberGroups();
}

export async function deleteMemberGroup(button) {
  const group = state.groups.find((item) => item.id === button.dataset.groupId);
  const confirmed = await showActionDialog({
    title: "Xóa nhóm thành viên?",
    message: `Xóa nhóm ${group?.name || ""}? Các thành viên sẽ trở lại trạng thái chưa nhóm; dữ liệu khoản chi không bị xóa.`,
    confirmLabel: "Xóa nhóm",
    danger: true,
  });
  if (!confirmed) return;
  await api(`/api/admin/member-groups/${encodeURIComponent(button.dataset.groupId)}`, { method: "DELETE" });
  editingGroupId = null;
  await loadState();
  showNotice("Đã xóa nhóm.");
}

// Tạo sổ và Store hỏi mật khẩu thao tác một lần cho cả phiên Admin (mọi sổ); undefined = phiên đã xác thực.
function askOperationsPassword(title) {
  if (state.storePasswordVerified) return Promise.resolve(undefined);
  return showActionDialog({
    title,
    message: "Nhập mật khẩu thao tác. Mật khẩu sẽ được ghi nhớ cho các lần tạo sổ và Store tiếp theo trong phiên Admin này.",
    inputLabel: "Mật khẩu thao tác",
    inputType: "password",
    preserveInput: true,
    confirmLabel: "Xác thực",
  });
}

// Gửi tạo sổ/Store, kèm mật khẩu nếu vừa hỏi. Gửi không kèm mật khẩu mà bị từ chối 400 (vd. đã đăng nhập lại ở
// tab khác nên phiên mới chưa xác thực): lần sau hỏi lại mật khẩu thay vì gửi lại y như cũ.
async function postWithOperationsPassword(path, body, password) {
  try {
    const data = await api(path, {
      method: "POST",
      body: JSON.stringify({ ...body, ...(password !== undefined ? { password } : {}) }),
    });
    state.storePasswordVerified = true;
    return data;
  } catch (caught) {
    if (password === undefined && caught.status === 400) state.storePasswordVerified = false;
    throw caught;
  }
}

// Xóa sổ luôn hỏi mật khẩu thao tác.
export async function deleteLedger(button) {
  const { ledgerSlug, ledgerName } = button.dataset;
  const password = await showActionDialog({
    title: `Xóa sổ "${ledgerName}"?`,
    message: "Thao tác này xóa vĩnh viễn thành viên, khoản chi, nhóm, nhật ký, cấu hình và các điểm Store. Nhập mật khẩu thao tác để xác nhận.",
    inputLabel: "Mật khẩu thao tác",
    inputType: "password",
    preserveInput: true,
    confirmLabel: "Xóa vĩnh viễn",
    danger: true,
  });
  if (password === null) return;
  await api(`/api/admin/ledgers/${encodeURIComponent(ledgerSlug)}`, {
    method: "DELETE",
    body: JSON.stringify({ password }),
  });
  if (ledgerSlug === state.ledger.slug) {
    window.location.assign("/g/chill-guys");
    return;
  }
  await loadLedgers();
  showNotice(`Đã xóa sổ "${ledgerName}".`);
}

export async function restoreHistoryPoint(button) {
  const point = state.historyPoints.find((item) => item.id === button.dataset.pointId);
  const restorePassword = await showActionDialog({
    title: "Khôi phục điểm dữ liệu?",
    message: `Dữ liệu Detail và Summary sẽ được thay bằng điểm lưu ${unbreakable(formatLocalDateTime(point?.createdAt))}. Cấu hình giao diện và nhật ký sẽ không bị thay đổi.`,
    inputLabel: "Mật khẩu thao tác",
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
}

export async function renameMember(button) {
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
}

export async function deleteMember(button) {
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
}

export async function createLedger(form) {
  const name = document.querySelector("#new-ledger-name").value;
  const password = await askOperationsPassword("Xác thực tạo sổ");
  if (password === null) return;
  const submitButton = form.querySelector('button[type="submit"]');
  const resetLoading = setButtonLoading(submitButton, "Đang tạo sổ");
  try {
    const data = await postWithOperationsPassword("/api/admin/ledgers", { name }, password);
    form.reset();
    await loadLedgers();
    showNotice(`Đã tạo sổ "${data.ledger.name}". Link: ${window.location.origin}/g/${data.ledger.slug}`);
  } finally {
    resetLoading();
  }
}

export async function addMember(form) {
  const name = new FormData(form).get("name");
  await api("/api/members", { method: "POST", body: JSON.stringify({ name }) });
  form.reset();
  await loadState();
  showNotice("Đã thêm thành viên.");
}

export async function saveMemberGroup(form) {
  const body = {
    name: document.querySelector("#member-group-name").value,
    memberIds: [...document.querySelector("#member-group-members").selectedOptions]
      .map((option) => option.value),
  };
  if (editingGroupId) {
    await api(`/api/admin/member-groups/${encodeURIComponent(editingGroupId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    showNotice("Đã cập nhật nhóm.");
  } else {
    await api("/api/admin/member-groups", {
      method: "POST",
      body: JSON.stringify(body),
    });
    showNotice("Đã tạo nhóm.");
  }
  editingGroupId = null;
  form.reset();
  await loadState();
}

export async function storeHistoryPoint() {
  const button = document.querySelector("#store-history-point");
  button.disabled = true;
  try {
    const message = await showActionDialog({
      title: "Store điểm dữ liệu",
      message: "Viết một message để nhận biết ý nghĩa của điểm lưu này.",
      inputLabel: "Message",
      confirmLabel: "Tiếp tục",
    });
    if (message === null) return;
    const password = await askOperationsPassword("Xác thực Store");
    if (password === null) return;
    await flushPendingChanges();
    await postWithOperationsPassword("/api/admin/history-points", { message }, password);
    await loadHistoryPoints();
    showNotice(`Đã Store: ${message}`);
  } catch (caught) {
    showNotice(caught.message, "error");
  } finally {
    button.disabled = false;
  }
}

export function openLoginDialog() {
  if (!state.isAdmin) document.querySelector("#login-dialog").showModal();
}

export function closeLoginDialog() {
  document.querySelector("#login-dialog").close();
}

export async function login(form) {
  const formData = new FormData(form);
  const resetLoading = setButtonLoading(form.querySelector(".login-submit"), "Đang đăng nhập");
  try {
    await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });
    state.isAdmin = true;
    state.storePasswordVerified = false;
    renderTotals();
    renderMembers();
    document.querySelector("#login-dialog").close();
    form.reset();
    document.querySelector("#login-error").textContent = "";
    document.querySelector("#history-points").textContent = "Đang tải điểm khôi phục…";
    void loadAdminData();
    showNotice("Đăng nhập Admin thành công.");
  } catch (caught) {
    document.querySelector("#login-error").textContent = caught.message;
  } finally {
    resetLoading();
  }
}

export async function logout() {
  const button = document.querySelector("#logout-button");
  const resetLoading = setButtonLoading(button, "Đang đăng xuất");
  try {
    await flushPendingDeletes();
    await api("/api/admin/logout", { method: "POST", body: "{}" });
    state.isAdmin = false;
    state.storePasswordVerified = false;
    clearAdminData();
    renderTotals();
    showNotice("Đã đăng xuất.");
  } catch (caught) {
    showNotice(caught.message, "error");
  } finally {
    resetLoading();
  }
}
