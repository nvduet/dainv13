// Xóa khoản chi có thể hoàn tác: dòng bị xóa chỉ ẩn trên trang, DELETE được gửi sau (thông báo "Đã xóa khoản chi."
// hết hạn hoặc bị đóng, trang ẩn hay đóng, trước Store, khôi phục, đăng xuất và làm mới dữ liệu). "Hoàn tác" trước
// lúc đó không gọi máy chủ. Không phụ thuộc DOM (có kiểm thử node:test): hàm gửi DELETE được truyền vào.
//
// Mỗi dòng chờ xóa: "pending" (còn hoàn tác được) → "waiting" (chờ PUT đang chạy của dòng xong) → "sending".
// Kết quả báo đúng một lần qua onCommitted (kể cả 404: khoản chi đã không còn) hoặc onFailed (dòng cần hiện lại).
export function createDeleteQueue({ send, onCommitted = () => {}, onFailed = () => {} }) {
  const records = new Map();

  function add(id, data) {
    if (records.has(id)) return false;
    records.set(id, { data, state: "pending", done: null, sending: null });
    return true;
  }

  // Còn hoàn tác được (DELETE chưa bắt đầu).
  function isPending(id) {
    return records.get(id)?.state === "pending";
  }

  function pendingIds() {
    return [...records].filter(([, record]) => record.state === "pending").map(([id]) => id);
  }

  // Hoàn tác: trả về dữ liệu đã giữ khi xóa và bỏ dòng khỏi hàng đợi; null nếu DELETE đã bắt đầu.
  function restore(id) {
    const record = records.get(id);
    if (record?.state !== "pending") return null;
    records.delete(id);
    return record.data;
  }

  // Khoản chi đã không còn trên máy chủ (người khác xóa, xóa thành viên): bỏ mà không gửi DELETE.
  function forget(id) {
    if (records.get(id)?.state !== "pending") return false;
    records.delete(id);
    return true;
  }

  function start(id, record, keepalive) {
    record.state = "sending";
    record.sending = send(id, { keepalive }).then(() => null, (error) => (error?.status === 404 ? null : error ?? new Error())).then((error) => {
      records.delete(id);
      if (error) onFailed(id, error, record.data);
      else onCommitted(id, record.data);
      return !error;
    });
    return record.sending;
  }

  // Gửi DELETE sau khi `wait` (PUT đang chạy của dòng) xong; mọi lần gọi cho cùng một dòng dùng chung một kết quả
  // (true: đã xóa). Dòng không còn trong hàng đợi: true.
  function commit(id, { wait = null, keepalive = false } = {}) {
    const record = records.get(id);
    if (!record) return Promise.resolve(true);
    if (!record.done) {
      record.state = "waiting";
      record.done = Promise.resolve(wait).catch(() => null).then(() => (record.state === "waiting" ? start(id, record, keepalive) : record.sending));
    }
    return record.done;
  }

  function commitAll(options = {}) {
    return Promise.all([...records.keys()].map((id) => commit(id, options)));
  }

  // Trang ẩn hoặc đang đóng: gửi ngay (keepalive, vẫn tới máy chủ khi trang đã đóng) mọi DELETE chưa gửi, không chờ
  // PUT đang chạy. Trang đóng thì không còn ai nhận lỗi: dòng không hiện lại được.
  function sendAllNow() {
    for (const [id, record] of records) {
      if (record.state === "sending") continue;
      start(id, record, true);
      record.done ??= record.sending;
    }
  }

  return {
    add,
    has: (id) => records.has(id),
    isPending,
    pendingIds,
    ids: () => [...records.keys()],
    data: (id) => records.get(id)?.data ?? null,
    restore,
    forget,
    commit,
    commitAll,
    sendAllNow,
  };
}
