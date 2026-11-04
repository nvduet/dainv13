// Xuất CSV (sao lưu, mở bằng Excel): phần Detail, một dòng trống, phần Summary. Không phụ thuộc DOM (có kiểm thử).
import { calculateBalances } from "../accounting.mjs";

// Excel dùng dấu phân cách danh sách của máy: ";" ở nơi viết số thập phân bằng dấu phẩy (vi-VN, de-DE…), "," nơi khác.
export function csvSeparator(locale) {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value;
  return decimal === "," ? ";" : ",";
}

// Chữ do khách nhập (nội dung, tên) bắt đầu bằng = + - @, tab hay xuống dòng có thể bị Excel chạy như công thức:
// thêm dấu nháy đơn ở đầu. Cột số là số nguyên thuần (số âm giữ dấu trừ) nên không bị đổi.
function textCell(value) {
  const text = String(value ?? "");
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function quote(cell, separator) {
  return cell.includes(separator) || /["\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function numberCell(value) {
  return Number.isSafeInteger(value) ? String(value) : "";
}

// Số tiền mỗi người (đ): trung bình làm tròn tới đồng (nửa đồng làm tròn ra xa 0), như cột "Số tiền/Ng".
function averagePerPerson(amountVnd, count) {
  if (!count || !amountVnd) return "";
  return String(Math.sign(amountVnd) * Math.round(Math.abs(amountVnd) / count));
}

// expenses: theo thứ tự nhập, mỗi khoản { payerId, date, description, amountVnd, participantIds } (như bảng đang hiện).
// Kết quả gồm BOM UTF-8 và xuống dòng CRLF.
export function buildLedgerCsv({ members, groups = [], expenses, payments = [], separator = "," }) {
  const row = (cells) => cells.map((cell) => quote(cell, separator)).join(separator);
  const namesById = new Map(members.map((member) => [member.id, member.name]));
  const groupsById = new Map(groups.map((group) => [group.id, group.name]));
  const lines = [row([
    "Người chi", "Ngày", "Nội dung", "Chi phí (đ)", ...members.map((member) => textCell(member.name)), "Số người", "Số tiền/người (đ)",
  ])];
  for (const expense of expenses) {
    const participants = new Set(expense.participantIds ?? []);
    const count = members.filter((member) => participants.has(member.id)).length;
    lines.push(row([
      textCell(namesById.get(expense.payerId) ?? ""),
      textCell(expense.date ?? ""),
      textCell(expense.description ?? ""),
      numberCell(expense.amountVnd),
      ...members.map((member) => (participants.has(member.id) ? "x" : "")),
      count ? String(count) : "",
      averagePerPerson(expense.amountVnd, count),
    ]));
  }
  lines.push("");
  lines.push(row(["Thành viên", "Tiền phải chịu (đ)", "Đã chi (đ)", "Đã chuyển khoản (đ)", "Số dư (đ)", "Nhóm"]));
  for (const member of calculateBalances(members, expenses, payments)) {
    lines.push(row([
      textCell(member.name),
      numberCell(member.shareVnd),
      numberCell(member.paidExpenseVnd),
      numberCell(member.paidToAdminVnd),
      numberCell(member.balanceVnd),
      textCell(member.groupId ? groupsById.get(member.groupId) ?? "" : ""),
    ]));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

// so-chi-<slug>-<YYYY-MM-DD>.csv theo ngày của máy người xem.
export function csvFileName(slug, date = new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return `so-chi-${slug}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.csv`;
}
