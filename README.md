# Sổ chi nhóm bạn

Website thay bảng tính chi tiêu chung cho hội bạn: ghi khoản chi theo bảng, chia đều cho người tham gia, xem số dư với Admin và ghi nhận nộp/hoàn tiền.

Đặc tả và quyền truy cập: [SPEC.md](./SPEC.md).

## Chạy thử local

Yêu cầu Node.js 22 trở lên để dùng Wrangler và Python 3 để nhập file Excel. Ứng dụng không cần cài thư viện frontend.

### Khởi động nhanh trên Windows

Từ thư mục dự án, mở PowerShell và chạy:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Local.ps1
```

Script cài Wrangler và runtime cần thiết vào `.local` ở lần chạy đầu, tạo `.dev.vars` cục bộ bằng mật khẩu Admin bạn nhập, chạy migration, nhập tab Detail và khởi động web. Mở URL local Wrangler in ra; nhấn `Ctrl+C` để dừng. Chạy lại script được; dữ liệu nhập không bị nhân đôi. Các gói và database local đều nằm trong `.local`, đã được Git bỏ qua.

Nếu vừa cài Node.js mà PowerShell báo không tìm thấy `node`, đóng/mở lại terminal. Script cũng thử tìm Node.js tại `C:\Program Files\nodejs`.

### Các bước thủ công

1. Cài Node.js LTS, sau đó từ thư mục dự án tạo database Cloudflare D1:

   ```powershell
   npm install --prefix .local\wrangler --no-audit --no-fund wrangler@4
   ```

   Nếu npm yêu cầu duyệt install script, chạy các lệnh sau để duyệt runtime Wrangler và cài runtime:

   ```powershell
   Set-Location .local\wrangler
   npm install-scripts approve esbuild workerd --allow-scripts-pin
   npm rebuild --no-audit --no-fund
   Set-Location ..\..
   ```

   Dùng Wrangler local từ đây về sau:

   ```powershell
   $wrangler = ".\.local\wrangler\node_modules\.bin\wrangler.cmd"
   & $wrangler login
   & $wrangler d1 create dainv13-group-expenses
   ```

2. Sao chép `database_id` được lệnh trả về vào `wrangler.toml`, thay giá trị `00000000-0000-0000-0000-000000000000`.

3. Tạo schema database local:

   ```powershell
   & $wrangler d1 migrations apply dainv13-group-expenses --local
   ```

4. Tạo file nhập riêng ở local từ tab Detail của workbook (file và SQL đầu ra đều nằm trong `.gitignore`):

   ```powershell
   python tools/import_detail.py "temp refer\File này cực kì cute.xlsx" --output .local\initial-detail.sql
   & $wrangler d1 execute dainv13-group-expenses --local --file .local\initial-detail.sql
   ```

   Script chỉ lấy thành viên và dòng chi có dữ liệu ở tab Detail; không lấy công thức, tab backup/template hoặc trạng thái thanh toán chưa xác minh. Các khoản đã nhập được quy đổi từ nghìn đồng sang đồng nguyên, làm tròn gần nhất.

5. Chạy website:

   ```powershell
   & $wrangler dev
   ```

   Mở địa chỉ local Wrangler in ra.

## Kiểm thử phép tính

```powershell
node --test tests/accounting.test.mjs
```

## Cấu hình đăng nhập Admin

Để thử đăng nhập local, tạo file `.dev.vars` trong thư mục gốc (không commit) với nội dung:

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=thay-bang-mat-khau-manh-rieng
ADMIN_SESSION_SECRET=thay-bang-chuoi-bi-mat-ngau-nhien-dai
```

Đặt các secrets cho môi trường Cloudflare production bằng lệnh riêng:

```powershell
& $wrangler secret put ADMIN_USERNAME
& $wrangler secret put ADMIN_PASSWORD
& $wrangler secret put ADMIN_SESSION_SECRET
```

Nhập giá trị khi Wrangler hỏi. Không dùng mật khẩu đã gửi trong trao đổi; hãy đặt mật khẩu mạnh riêng cho production. Secret phiên nên là chuỗi ngẫu nhiên dài. Không đưa `.dev.vars`, mật khẩu, hoặc secret vào Git.

Chỉ có một danh sách thành viên. Admin là người duy nhất được thêm, đổi tên hoặc xóa thành viên; toàn bộ thành viên trong danh sách được hiển thị thành cột ở bảng chi và trong bảng tổng hợp.

Sau khi đăng nhập Admin, mở mục **Cấu hình độ rộng cột** ở đầu trang để chỉnh từng vai trò cột trong bảng chi (người chi, nội dung, chi phí, cột thành viên, số người, tiền/người, xóa) và bảng tổng hợp (tên chỉ tiêu, cột thành viên). Các cột thành viên cùng dùng độ rộng theo vai trò; số lượng cột được hiển thị cạnh trường cấu hình. Admin cũng có thể chỉnh cỡ chữ toàn giao diện từ 75% đến 200%. Các cấu hình được lưu trong D1 và dùng chung cho mọi người truy cập; khách chưa đăng nhập không thể thay đổi. Thêm/đổi tên/xóa thành viên quản lý dùng hộp thoại giao diện; xóa khoản chi thực hiện ngay khi bấm nút Xóa. Admin cũng có thể sửa tổng tiền đã chuyển khoản cho từng thành viên ở bảng tổng hợp; hệ thống lưu bút toán chênh lệch và nhật ký, không sửa lịch sử giao dịch gốc.

Nhật ký quản trị ghi riêng từng thay đổi trường của khoản chi (người chi, nội dung, số tiền), thao tác đánh dấu/bỏ đánh dấu người tham gia và điều chỉnh tổng tiền chuyển khoản; nhật ký hiển thị giá trị trước/sau cho các thay đổi này.

Các thay đổi trong bảng chi được tự lưu vào D1 sau khi hoàn tất dòng; khi rời hoặc tải lại trang, các thay đổi hợp lệ còn đang chờ sẽ được gửi lưu bằng yêu cầu nền. Trạng thái lưu hiển thị dưới bảng. Dòng chưa đủ người chi, nội dung, số tiền dương hoặc người tham gia sẽ báo rõ là chưa lưu.

## Deploy

Sau khi đăng nhập Wrangler (`& $wrangler login`) và tạo D1, cập nhật `database_id` trong `wrangler.toml`. Để thiết lập credentials production mà không nhập mật khẩu vào chat, chạy script sau trong PowerShell; mật khẩu được nhập ở prompt bảo mật và khóa phiên được tạo ngẫu nhiên:

```powershell
powershell -ExecutionPolicy Bypass -File .\Set-CloudflareSecrets.ps1
```

Script dùng Wrangler local trong `.local`; các secrets được gửi trực tiếp đến Cloudflare Workers, không ghi vào tệp dự án. Không deploy ứng dụng công khai trước khi thiết lập đủ secrets Admin.

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-Cloudflare.ps1
```

Script kiểm tra đăng nhập Cloudflare và đủ secrets, áp dụng các migration còn thiếu vào D1 remote, deploy Worker/assets, rồi kiểm tra endpoint trạng thái. Dùng lại cùng lệnh sau mỗi lần muốn đưa thay đổi mới lên production. `wrangler.toml` chứa tên Worker và D1 production. Database được giữ nguyên qua các lần deploy; không có bước nhập dữ liệu local/workbook tự động. Sao lưu D1 định kỳ trước khi đưa dữ liệu thật vào.

## Quyền truy cập và sao lưu

Trang đọc công khai và khách chưa đăng nhập có thể sửa/xóa khoản chi. Điều này cho phép cả người lạ trên Internet thay đổi dữ liệu; giới hạn tần suất và nhật ký không xác minh được danh tính. Admin là người duy nhất được quản lý thành viên và xác nhận khoản nộp/ghi nhận hoàn tiền. Hãy cân nhắc kỹ trước khi dùng với dữ liệu thật.

Trước khi deploy, kiểm tra lại hạn mức Cloudflare, tạo quy trình sao lưu D1 và thử khôi phục bản sao lưu. Xóa thành viên sẽ xóa cứng các khoản chi có liên quan và thanh toán lịch sử của người đó.
