// Nút "Xuất Excel": tạo file .xlsx ngay trên máy (Blob), không gọi máy chủ. Lấy đúng những gì bảng đang hiển thị (mọi
// khoản chi, kể cả dòng đang bị lọc ẩn), theo thứ tự nhập; trang Summary tính như bảng Summary. Nút tắt tới khi dữ liệu
// tải xong (file rỗng mang tên sổ mặc định thì không phải bản sao lưu).
import { buildLedgerXlsx, XLSX_MIME, xlsxFileName } from "./xlsx.js";
import { getExpensePreview, inEntryOrder } from "./expenses.js";
import { state } from "./state.js";
import { showNotice } from "./ui.js";

export function downloadLedgerXlsx() {
  if (!state.loaded) {
    showNotice("Chưa tải xong dữ liệu, hãy thử lại.", "error");
    return;
  }
  const now = new Date();
  const bytes = buildLedgerXlsx({
    members: state.members,
    groups: state.groups,
    expenses: inEntryOrder(getExpensePreview()),
    payments: state.payments,
    date: now,
  });
  const fileName = xlsxFileName(state.ledger.slug, now);
  const url = URL.createObjectURL(new Blob([bytes], { type: XLSX_MIME }));
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
