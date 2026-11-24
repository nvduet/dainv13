// Lỗi kèm mã HTTP (0 = không nhận được phản hồi) và số giây Retry-After (nếu có) để hàng đợi lưu tự thử lại; field: ô
// mà máy chủ nói lỗi thuộc về (vd. "password": thiếu hay sai mật khẩu thao tác), để hộp thoại đánh dấu đúng ô đó.
function apiError(message, status, retryAfter = null, field = null) {
  return Object.assign(new Error(message), { status, retryAfter }, field ? { field } : {});
}

// Gọi API JSON; trang /g/<slug> tự đổi /api/... thành /api/g/<slug>/... (trừ quản lý sổ toàn cục).
export async function api(path, options = {}) {
  const activeLedger = window.location.pathname.match(/^\/g\/([a-z0-9-]+)\/?$/);
  const isGlobalLedgerManagement = /^\/api\/admin\/ledgers(?:\/[a-z0-9-]+)?$/.test(path);
  const requestPath = activeLedger && !isGlobalLedgerManagement
    ? `/api/g/${activeLedger[1]}${path.slice("/api".length)}`
    : path;
  let response;
  try {
    response = await fetch(requestPath, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      credentials: "same-origin",
    });
  } catch {
    throw apiError("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.", 0);
  }
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = /^\d+$/.test(retryAfterHeader ?? "") ? Number(retryAfterHeader) : null;
  let body;
  try {
    body = await response.json();
  } catch {
    throw apiError(response.ok
      ? "Máy chủ trả về dữ liệu không đọc được."
      : `Máy chủ trả về dữ liệu không đọc được (HTTP ${response.status}).`, response.status, retryAfter);
  }
  if (!response.ok) {
    const field = typeof body?.field === "string" ? body.field : null;
    throw apiError(body?.error || `Yêu cầu thất bại (${response.status}).`, response.status, retryAfter, field);
  }
  return body;
}
