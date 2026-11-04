// Điểm vào của trang: gắn sự kiện (giữ thứ tự cũ) rồi tải dữ liệu.
import {
  addMember,
  cancelMemberGroupEdit,
  closeAuditDiffDialog,
  closeLoginDialog,
  createLedger,
  deleteLedger,
  deleteMember,
  deleteMemberGroup,
  editMemberGroup,
  loadState,
  login,
  logout,
  openLoginDialog,
  refreshAfterReturn,
  renameMember,
  restoreHistoryPoint,
  saveMemberGroup,
  showAuditSessionDiff,
  storeHistoryPoint,
} from "./js/admin.js";
import { downloadLedgerCsv } from "./js/csv-download.js";
import {
  clearFilters,
  handleDetailFocusOut,
  handleFilterInput,
  toggleFilterPanel,
  watchTableOverflow,
} from "./js/detail-view.js";
import {
  handleHistoryShortcut,
  keepNativeUndoInField,
  noteDetailFocus,
  redoLastChange,
  undoLastChange,
} from "./js/expense-history.js";
import {
  addExpense,
  commitDeletesNow,
  deleteExpense,
  duplicateExpense,
  handleExpenseChange,
  handleExpenseFocusOut,
  handleExpenseInput,
  retryExpenseSaves,
  saveExpensesForUnload,
  saveExpensesNow,
  toggleExpenseAmountSign,
} from "./js/expenses.js";
import { closeMemberDetail, closeMemberDetailOnBackdrop, openMemberDetail } from "./js/member-detail.js";
import { createReturnWatcher } from "./js/return-watch.js";
import {
  applyExpenseColumnWidths,
  applyExpenseWidths,
  applyFontSize,
  applyQrSize,
  applySummaryColumnWidths,
  applySummaryWidths,
  resetColumnWidths,
} from "./js/settings.js";
import {
  doneTransfer,
  handleTransferChange,
  handleTransferInput,
  saveTransfersForUnload,
} from "./js/summary.js";
import { initThemePicker } from "./js/theme-picker.js";
import {
  cancelActionDialog,
  clearActionDialogError,
  dismissNoticeOnEscape,
  finishLoading,
  hideNotice,
  initNotice,
  runNoticeAction,
  settleActionDialog,
  showNotice,
  submitActionDialog,
} from "./js/ui.js";

const clickActions = new Map([
  ["edit-member-group", editMemberGroup],
  ["delete-member-group", deleteMemberGroup],
  ["delete-ledger", deleteLedger],
  ["audit-session-diff", showAuditSessionDiff],
  ["restore-history-point", restoreHistoryPoint],
  ["delete-expense", deleteExpense],
  ["duplicate-expense", duplicateExpense],
  ["member-detail", openMemberDetail],
  ["toggle-amount-sign", toggleExpenseAmountSign],
  ["done-transfer", doneTransfer],
  ["rename-member", renameMember],
  ["delete-member", deleteMember],
]);

const submitHandlers = new Map([
  ["ledger-form", createLedger],
  ["member-form", addMember],
  ["member-group-form", saveMemberGroup],
  ["login-form", login],
]);

// Bấm "±" không lấy focus khỏi ô Chi phí, nên bàn phím số trên điện thoại vẫn mở.
function keepAmountFocus(event) {
  if (event.target.closest(".sign-toggle")) event.preventDefault();
}

// Trình duyệt không cuộn ô còn lộ một phần, nên ô nhận focus bằng Tab/Shift+Tab có thể nằm dưới cột hay hàng tiêu đề
// cố định hoặc sát mép khung. Cuộn khung bảng vừa đủ cho ô hiện ra (scroll-padding-left = cột cố định do settings.js
// đặt, scroll-margin trong styles.css). Lề trên = hàng tiêu đề chỉ đặt trong lúc cuộn: để lâu thì trình duyệt tự cuộn ô
// ra giữa khung mỗi lần Shift+Tab lên một dòng. Chạm ô Chi phí trên màn hình cảm ứng cũng cuộn để chừa chỗ cho nút "±".
let focusByTab = false;
function revealFocusedControl(event) {
  const control = event.target;
  const scroller = control.closest(".table-scroll");
  const reveal = focusByTab || (control.matches(".amount-input") && matchMedia("(pointer: coarse)").matches);
  focusByTab = false;
  if (!scroller || !reveal) return;
  requestAnimationFrame(() => {
    if (document.activeElement !== control) return;
    scroller.style.scrollPaddingTop = `${scroller.querySelector("thead")?.offsetHeight ?? 0}px`;
    control.scrollIntoView({ block: "nearest", inline: "nearest" });
    scroller.style.scrollPaddingTop = "";
  });
}

async function handleClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = clickActions.get(button.dataset.action);
  if (!action) return;
  try {
    await action(button, event);
  } catch (caught) {
    showNotice(caught.message, "error");
  }
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const handler = submitHandlers.get(form.id);
  if (!handler) return;
  try {
    await handler(form);
  } catch (caught) {
    showNotice(caught.message, "error");
  }
}

document.querySelector("#notice-close").addEventListener("click", hideNotice);
document.querySelector("#action-form").addEventListener("submit", submitActionDialog);
document.querySelector("#expense-body").addEventListener("focusout", handleExpenseFocusOut);
document.querySelector("#action-dialog-cancel").addEventListener("click", cancelActionDialog);
document.querySelector("#action-dialog-close").addEventListener("click", cancelActionDialog);
document.querySelector("#audit-diff-close").addEventListener("click", closeAuditDiffDialog);
document.querySelector("#action-dialog-input").addEventListener("input", clearActionDialogError);
document.querySelector("#action-dialog").addEventListener("close", settleActionDialog);
document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
applyExpenseColumnWidths();
applySummaryColumnWidths();
document.querySelector("#expense-body").addEventListener("input", handleExpenseInput);
document.querySelector("#expense-body").addEventListener("change", handleExpenseChange);
document.querySelector("#expense-body").addEventListener("pointerdown", keepAmountFocus);
document.querySelector("#expense-body").addEventListener("mousedown", keepAmountFocus);
document.querySelector("#summary-body").addEventListener("change", handleTransferChange);
document.querySelector("#summary-body").addEventListener("input", handleTransferInput);
document.querySelector("#add-expense").addEventListener("click", addExpense);
document.querySelector("#store-history-point").addEventListener("click", storeHistoryPoint);
document.querySelector("#login-button").addEventListener("click", openLoginDialog);
document.querySelector("#cancel-member-group-edit").addEventListener("click", cancelMemberGroupEdit);
document.querySelector("#close-login").addEventListener("click", closeLoginDialog);
document.querySelector("#logout-button").addEventListener("click", logout);
// Rời trang hoặc trang bị ẩn: các lần xóa còn chờ gửi ngay (keepalive) cùng các thay đổi chưa lưu.
// Quay lại sau ≥ 30 giây (trang ẩn hoặc cửa sổ mất focus): tải dữ liệu mới một lần (không hỏi định kỳ).
const returnWatcher = createReturnWatcher({ onReturn: () => void refreshAfterReturn() });
window.addEventListener("pagehide", () => {
  commitDeletesNow();
  saveExpensesForUnload();
  saveTransfersForUnload();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    saveExpensesNow();
    commitDeletesNow();
    returnWatcher.away();
  } else {
    retryExpenseSaves();
    returnWatcher.back();
  }
});
window.addEventListener("blur", (event) => {
  if (event.target === window) returnWatcher.away();
});
window.addEventListener("focus", (event) => {
  if (event.target === window) returnWatcher.back();
});
window.addEventListener("online", retryExpenseSaves);
document.querySelector("#apply-expense-widths").addEventListener("click", applyExpenseWidths);
document.querySelector("#apply-summary-widths").addEventListener("click", applySummaryWidths);
document.querySelector("#reset-column-widths").addEventListener("click", resetColumnWidths);
document.querySelector("#apply-font-size").addEventListener("click", applyFontSize);
document.querySelector("#apply-qr-size").addEventListener("click", applyQrSize);
document.addEventListener("keydown", (event) => { focusByTab = event.key === "Tab"; }, true);
document.addEventListener("focusin", revealFocusedControl);
// Phase 6: tìm/lọc/sắp xếp, xuất CSV, chi tiết thành viên, nút hành động của thông báo, hoàn tác/làm lại.
initNotice();
document.querySelector("#notice-action").addEventListener("click", runNoticeAction);
document.querySelector("#detail-toolbar").addEventListener("input", handleFilterInput);
document.querySelector("#detail-toolbar").addEventListener("change", handleFilterInput);
document.querySelector("#filter-toggle").addEventListener("click", toggleFilterPanel);
document.querySelector("#filter-clear").addEventListener("click", clearFilters);
document.querySelector("#expense-body").addEventListener("focusout", handleDetailFocusOut);
document.querySelector("#export-csv").addEventListener("click", downloadLedgerCsv);
document.querySelector("#member-detail-close").addEventListener("click", closeMemberDetail);
document.querySelector("#member-detail-dialog").addEventListener("click", closeMemberDetailOnBackdrop);
document.querySelector("#undo-change").addEventListener("click", () => void undoLastChange());
document.querySelector("#redo-change").addEventListener("click", () => void redoLastChange());
document.querySelector("#expense-body").addEventListener("focusin", noteDetailFocus);
document.addEventListener("keydown", handleHistoryShortcut);
document.addEventListener("beforeinput", keepNativeUndoInField, true);
document.addEventListener("keydown", dismissNoticeOnEscape);
watchTableOverflow();
// Phase 6b: nút "Đổi giao diện" (lựa chọn chỉ lưu trên máy này).
initThemePicker();

loadState().catch((caught) => {
  finishLoading();
  showNotice(caught.message, "error");
});
