# Sổ chi nhóm bạn

Website quản lý nhiều sổ chi tiêu độc lập trên Cloudflare Workers và D1.
Chi tiết tính năng, quyền truy cập và lưu ý dữ liệu nằm trong [SPEC.md](./SPEC.md).

## Cấu trúc

- `worker/`: API và Worker.
- `public/`: giao diện và tài nguyên web.
- `migrations/`: các thay đổi schema D1.
- `scripts/`: cấu hình secrets và deploy production.
- `tests/`: kiểm thử logic và API.
- `wrangler.toml`: cấu hình Worker và D1 production.

Không còn workflow chạy web hoặc database local, cũng không còn công cụ nhập
workbook. Các migration trong deploy chỉ áp dụng lên D1 remote.

## Yêu cầu

- Node.js 22 trở lên (bao gồm npm/npx).
- Tài khoản Cloudflare đã đăng nhập Wrangler.
- D1 production đã được cấu hình trong `wrangler.toml`.

Đăng nhập Wrangler nếu đây là máy mới:

```powershell
npx --yes wrangler@4 login
```

## Secrets production

Thiết lập hoặc thay đổi tài khoản Admin và mật khẩu khôi phục bằng:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\change_pass.ps1
```

Các giá trị mật khẩu được nhập tại prompt bảo mật và gửi trực tiếp tới
Cloudflare Workers; chúng không được ghi vào file dự án. Mật khẩu khôi phục
phải khác mật khẩu Admin. Không deploy ứng dụng công khai trước khi thiết lập
đủ secrets.

## Deploy

Đẩy mã nguồn lên production:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\push_to_server.ps1
```

Hoặc chạy `scripts\push_to_server.bat`. Script kiểm tra đăng nhập và secrets, áp dụng
các migration còn thiếu lên D1 remote, deploy Worker cùng static assets, rồi
kiểm tra API trạng thái. Deploy không thay đổi dữ liệu hiện có hay secrets.

## Kiểm thử

```powershell
node --test tests\accounting.test.mjs tests\worker.test.mjs
```

Các kiểm thử chạy trực tiếp bằng Node.js; không cần khởi động web hoặc database.
