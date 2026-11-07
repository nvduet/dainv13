// Viewport theo thiết bị. Ô nhập nhỏ hơn 16 px (cỡ chữ Admin dưới mặc định trên điện thoại, mọi cỡ trên iPad) làm
// Safari iOS tự phóng to trang khi chạm vào ô. maximum-scale=1 tắt việc tự phóng to đó, còn người dùng vẫn phóng to
// bằng hai ngón (iOS 10 trở đi). Chỉ dùng cho iPhone/iPad: Android không tự phóng to, và maximum-scale=1 ở đó chặn
// cả việc phóng to bằng tay.
export const BASE_VIEWPORT = "width=device-width, initial-scale=1";

// iPadOS báo platform "MacIntel" như máy Mac; khác ở chỗ có màn hình cảm ứng.
export function isAppleTouchDevice({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

export function viewportContent(appleTouch) {
  return appleTouch ? `${BASE_VIEWPORT}, maximum-scale=1` : BASE_VIEWPORT;
}
