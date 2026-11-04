// Nút "Xuất CSV": tạo file ngay trên máy (Blob), không gọi máy chủ. Lấy đúng những gì bảng đang hiển thị (mọi
// khoản chi, kể cả dòng đang bị lọc ẩn), theo thứ tự nhập. Nút tắt tới khi dữ liệu tải xong (file rỗng mang tên sổ
// mặc định thì không phải bản sao lưu).
import { buildLedgerCsv, csvFileName, csvSeparator } from "./csv.js";
import { getExpensePreview, inEntryOrder } from "./expenses.js";
import { state } from "./state.js";
import { showNotice } from "./ui.js";

export function downloadLedgerCsv() {
  if (!state.loaded) {
    showNotice("Chưa tải xong dữ liệu, hãy thử lại.", "error");
    return;
  }
  const csv = buildLedgerCsv({
    members: state.members,
    groups: state.groups,
    expenses: inEntryOrder(getExpensePreview()),
    payments: state.payments,
    separator: csvSeparator(),
  });
  const fileName = csvFileName(state.ledger.slug);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showNotice(`Đã xuất ${fileName}.`);
}
