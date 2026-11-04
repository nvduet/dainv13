// Hợp nhất danh sách khoản chi mới từ máy chủ (tải lại sau thao tác Admin, làm mới khi quay lại trang) với bản đang có
// trên trang. Không phụ thuộc DOM (có kiểm thử node:test); expenses.js lo phần hàng đợi lưu, hàng đợi xóa và lịch sử.
//
// local: state.expenses hiện tại (gồm dòng tạm "pending-…" đang chờ POST); server: danh sách của GET /api/state;
// preferLocal: id trang vừa tự lưu hoặc tạo trong lúc chờ phản hồi (bản trên trang mới hơn bản trong phản hồi);
// removed: id vừa xóa xong trong lúc đó; isDeleting(id): dòng đang chờ xóa trên trang (vẫn ẩn).
// Kết quả: expenses (theo thứ tự máy chủ, rồi bản trang vừa tạo mà phản hồi chưa có, rồi dòng tạm), deleting (bản mới
// nhất của các dòng đang chờ xóa), serverIds, dropped (id trên trang không còn trong danh sách mới).
export function mergeExpenseLists({ local, server, preferLocal = new Set(), removed = new Set(), isDeleting = () => false }) {
  const localById = new Map(local.map((expense) => [expense.id, expense]));
  const serverIds = new Set(server.map((expense) => expense.id));
  const expenses = [];
  const deleting = [];
  for (const expense of server) {
    if (removed.has(expense.id)) continue;
    if (isDeleting(expense.id)) deleting.push(expense);
    else expenses.push(preferLocal.has(expense.id) && localById.has(expense.id) ? localById.get(expense.id) : expense);
  }
  for (const id of preferLocal) {
    if (!serverIds.has(id) && localById.has(id) && !removed.has(id) && !isDeleting(id)) expenses.push(localById.get(id));
  }
  // Dòng tạm đang chờ POST ("Add line", nhân bản) vẫn ở cuối bảng; POST xong sẽ thay nó như thường.
  for (const expense of local) {
    if (expense.id.startsWith("pending-")) expenses.push(expense);
  }
  const kept = new Set(expenses.map((expense) => expense.id));
  const dropped = local.map((expense) => expense.id).filter((id) => !kept.has(id) && !id.startsWith("pending-"));
  return { expenses, deleting, serverIds, dropped };
}
