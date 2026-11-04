// Chi tiết một thành viên (bấm tên trong Summary): nhóm, bốn khoản tổng và số dư, các khoản chi người đó trả hoặc
// tham gia (phần chịu chia đúng như Summary) và các lần chuyển khoản. Số liệu lấy từ đúng những gì Summary đang dùng.
import { memberBreakdown } from "../accounting.mjs";
import { getExpensePreview, inEntryOrder } from "./expenses.js";
import { balanceClass, escapeHtml, formatLocalDate, formatLocalDateTime, formatVnd } from "./format.js";
import { state } from "./state.js";

let openMemberId = null;

const dialog = () => document.querySelector("#member-detail-dialog");

// "chia n": số người cùng chịu khoản đó.
function role(row) {
  const split = row.participant ? ` <span class="member-detail-split">(chia ${row.participantCount})</span>` : "";
  if (row.payer && row.participant) return `Người chi, tham gia${split}`;
  return row.payer ? "Người chi" : `Tham gia${split}`;
}

// Mỗi lần sửa ô "Đã chuyển khoản" (hay bấm Done) ghi một dòng chênh lệch: tăng là chuyển khoản, giảm là điều chỉnh.
function transferKind(transfer) {
  if (transfer.direction === "admin_to_member") return "Admin hoàn";
  return transfer.amountVnd < 0 ? "Điều chỉnh" : "Chuyển khoản";
}

function balanceNote(balanceVnd) {
  if (balanceVnd > 0) return "Còn phải nộp cho Admin";
  if (balanceVnd < 0) return "Admin còn phải hoàn";
  return "Đã cân bằng";
}

// Nội dung xuống dòng để bảng vừa khung. Màn hình hẹp (styles.css): ẩn cột Ngày và Vai trò, hai thông tin đó hiện ở
// dòng nhỏ dưới nội dung (md-meta), nên Chi phí và Phần chịu luôn thấy được mà không cuộn ngang.
function renderExpenseRows(rows) {
  if (!rows.length) return `<p class="section-description">Chưa có khoản chi nào liên quan.</p>`;
  const body = rows.map((row) => {
    const date = escapeHtml(formatLocalDate(row.date) || "—");
    return `<tr>
      <td class="md-date">${date}</td>
      <td class="member-detail-description">${escapeHtml(row.description || "—")}<span class="md-meta">${date} · ${role(row)}</span></td>
      <td class="num">${formatVnd(row.amountVnd)}</td>
      <td class="num">${row.participant ? formatVnd(row.shareVnd) : "—"}</td>
      <td class="md-role">${role(row)}</td>
    </tr>`;
  }).join("");
  return `<div class="audit-diff-table-scroll member-detail-table-scroll"><table class="audit-diff-table member-detail-table">
      <thead><tr><th class="md-date" scope="col">Ngày</th><th scope="col">Nội dung</th><th class="num" scope="col">Chi phí</th><th class="num" scope="col">Phần chịu</th><th class="md-role" scope="col">Vai trò</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function renderTransfers(transfers) {
  if (!transfers.length) return `<p class="section-description">Chưa có chuyển khoản.</p>`;
  return `<ul class="member-transfers">${transfers.map((transfer) => `<li>
      <span>${escapeHtml(formatLocalDateTime(transfer.createdAt) || "—")}</span>
      <span>${transferKind(transfer)}</span>
      <strong>${formatVnd(transfer.amountVnd)}</strong>
    </li>`).join("")}</ul>`;
}

// false nếu thành viên không còn (bị xóa).
function renderMemberDetail(preview) {
  // Theo thứ tự nhập, không theo cách sắp xếp đang chọn của bảng Detail.
  const detail = memberBreakdown(state.members, inEntryOrder(preview), state.payments, openMemberId);
  if (!detail) return false;
  const group = state.groups.find((item) => item.id === detail.member.groupId);
  document.querySelector("#member-detail-title").textContent = detail.member.name;
  const totals = [
    ["Tiền phải chịu", detail.shareVnd],
    ["Đã chi", detail.paidExpenseVnd],
    ["Đã chuyển khoản", detail.paidToAdminVnd],
    ["Admin đã hoàn", detail.refundedVnd],
  ];
  document.querySelector("#member-detail-content").innerHTML = `
    <p class="section-description member-detail-group">${group ? `Nhóm ${escapeHtml(group.name)}` : "Chưa thuộc nhóm"}</p>
    <dl class="member-totals">
      ${totals.map(([label, amount]) => `<div><dt>${label}</dt><dd>${formatVnd(amount)}</dd></div>`).join("")}
      <div class="member-balance"><dt>Số dư</dt><dd class="${balanceClass(detail.balanceVnd)}">${formatVnd(detail.balanceVnd)}</dd><dd class="member-balance-note">${balanceNote(detail.balanceVnd)}</dd></div>
    </dl>
    <h3>Khoản chi liên quan <span class="member-detail-count">(${detail.expenses.length})</span></h3>
    ${renderExpenseRows(detail.expenses)}
    <h3>Chuyển khoản</h3>
    ${renderTransfers(detail.transfers)}`;
  return true;
}

export function openMemberDetail(button) {
  openMemberId = button.dataset.memberId;
  if (!renderMemberDetail(getExpensePreview())) return;
  dialog().showModal();
  // Mở ở đầu nội dung, kể cả khi lần trước đã cuộn xuống (tên và nút đóng luôn ở trên, chỉ phần nội dung cuộn).
  document.querySelector("#member-detail-content").scrollTop = 0;
}

export function closeMemberDetail() {
  dialog().close();
}

// Bấm ra ngoài hộp thoại (nền mờ) cũng đóng: hộp thoại chỉ để xem.
export function closeMemberDetailOnBackdrop(event) {
  if (event.target !== dialog()) return;
  const box = dialog().getBoundingClientRect();
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  if (!inside) dialog().close();
}

// Summary vừa tính lại (lưu xong, dữ liệu mới): hộp thoại đang mở hiện cùng số liệu; thành viên đã bị xóa thì đóng.
export function refreshMemberDetail(preview) {
  if (!dialog()?.open) return;
  if (!renderMemberDetail(preview ?? getExpensePreview())) dialog().close();
}
