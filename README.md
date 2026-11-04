# Sổ chi nhóm bạn

Website quản lý nhiều sổ chi tiêu độc lập trên Cloudflare Workers và D1.
Chi tiết tính năng, quyền truy cập và lưu ý dữ liệu nằm trong [SPEC.md](./SPEC.md).

## Mẹo dùng

- "Xuất CSV" ở tiêu đề Detail tải một bản sao của sổ về máy (mở bằng Excel hoặc
  Google Sheets); nên tải định kỳ ngoài các điểm Store.
- Xóa nhầm khoản chi: bấm "Hoàn tác" trên thông báo trong 6 giây. Sửa nhầm: nút
  "Hoàn tác"/"Làm lại" hoặc Ctrl+Z / Ctrl+Y khi con trỏ không ở trong ô nhập.
  Hoàn tác không biết thay đổi từ máy khác mà trang chưa tải về.
- Ô Chi phí nhận phép tính như `120+45`; nút "Nhân bản" chép một dòng; bấm tên
  thành viên ở Summary để xem chi tiết người đó.
- Quay lại trang sau ít nhất 30 giây, trang tự tải dữ liệu mới.
- Nút bảng màu "Đổi giao diện" ở đầu trang chọn giao diện (Than chì, Rừng xanh, Ngà & Vàng, Navy & Đồng) và chế độ Tự động/Sáng/Tối; mỗi máy tự nhớ lựa chọn của mình.

## Cấu trúc

- `worker/`: API và Worker.
- `public/`: giao diện và tài nguyên web. Giao diện tự theo chế độ sáng/tối của
  thiết bị; `robots.txt` và header `X-Robots-Tag` đề nghị máy tìm kiếm không lập
  chỉ mục trang sổ.
- `migrations/`: các thay đổi schema D1.
- `scripts/`: cấu hình secrets và deploy production.
- `tests/`: kiểm thử logic và API.
- `wrangler.toml`: cấu hình Worker và D1 production.

Không còn workflow chạy web hoặc database local, cũng không còn công cụ nhập
workbook. Các migration trong deploy chỉ áp dụng lên D1 remote.

## Yêu cầu

- Node.js 22.13 trở lên (bao gồm npm/npx; cần `node:sqlite` cho kiểm thử tích hợp).
- Tài khoản Cloudflare đã đăng nhập Wrangler.
- D1 production đã được cấu hình trong `wrangler.toml`.

Đăng nhập Wrangler nếu đây là máy mới:

```powershell
npx --yes wrangler@4 login
```

## Secrets production

Thiết lập hoặc thay đổi tài khoản Admin và mật khẩu thao tác bằng:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\change_pass.ps1
```

Hoặc chạy `scripts\change_pass.bat`. Các giá trị mật khẩu được nhập tại prompt
bảo mật và gửi trực tiếp tới Cloudflare Workers; chúng không được ghi vào file
dự án. Mật khẩu thao tác dùng chung cho tạo sổ, xóa sổ, Store và khôi phục; nó
phải khác mật khẩu Admin. Cả hai mật khẩu cần ít nhất 8 ký tự và không bắt đầu
hoặc kết thúc bằng khoảng trắng. Không deploy ứng dụng công khai trước khi thiết
lập đủ secrets.

## Deploy

Đẩy mã nguồn lên production:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\push_to_server.ps1
```

Hoặc chạy `scripts\push_to_server.bat`. Script chạy kiểm thử local trước
(dừng nếu có test lỗi), kiểm tra đăng nhập và secrets, áp dụng các migration còn
thiếu lên D1 remote (migration có thể thay đổi schema), deploy Worker cùng static
assets, rồi kiểm tra API trạng thái. Deploy không thay đổi secrets.

Log của Worker (Workers Logs, bật trong `wrangler.toml`) xem trong trang của
Worker `leoasland` trên Cloudflare dashboard, mục Logs. URL preview riêng của từng phiên
bản được tắt (`preview_urls = false`); trang chỉ chạy ở địa chỉ `workers.dev` chính.

## Kiểm thử

```powershell
node --test
```

Chạy từ thư mục gốc dự án. Lệnh tự tìm mọi file `tests\*.test.mjs`, gồm cả
kiểm thử tích hợp chạy worker thật trên SQLite (`node:sqlite`) với toàn bộ migration.

Các kiểm thử chạy trực tiếp bằng Node.js; không cần khởi động web hoặc database.
