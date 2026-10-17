# Sổ chi nhóm bạn

Website thay bảng tính chi tiêu chung cho hội bạn: ghi khoản chi theo bảng, chia đều cho người tham gia và xem số dư với Admin.

Đặc tả và quyền truy cập: [SPEC.md](./SPEC.md).

## Chạy thử local

Yêu cầu Node.js 22 trở lên để dùng Wrangler và Python 3 để nhập file Excel. Ứng dụng không cần cài thư viện frontend.

### Khởi động nhanh trên Windows

Từ thư mục dự án, mở PowerShell và chạy:

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Local.ps1
```

Script cài Wrangler và runtime cần thiết vào `.local` ở lần chạy đầu, tạo `.dev.vars` cục bộ bằng mật khẩu Admin và mật khẩu khôi phục riêng bạn nhập, chạy migration, nhập tab Detail và khởi động web. Mở URL local Wrangler in ra; nhấn `Ctrl+C` để dừng. Chạy lại script được; dữ liệu nhập không bị nhân đôi. Các gói và database local đều nằm trong `.local`, đã được Git bỏ qua.

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
node --test tests\accounting.test.mjs tests\worker.test.mjs
```

## Cấu hình đăng nhập Admin

Để thử đăng nhập local, tạo file `.dev.vars` trong thư mục gốc (không commit) với nội dung:

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=thay-bang-mat-khau-manh-rieng
ADMIN_SESSION_SECRET=thay-bang-chuoi-bi-mat-ngau-nhien-dai
HISTORY_RESTORE_PASSWORD=mat-khau-khoi-phuc-rieng-khac-admin
```

Script `Set-CloudflareSecrets.ps1` cấu hình các secrets production. Mật khẩu Admin và mật khẩu khôi phục chỉ cần có ít nhất một ký tự; không có yêu cầu độ dài khác. Hãy dùng mật khẩu mạnh và không chia sẻ chúng. Secret phiên được tạo ngẫu nhiên dài. Không đưa `.dev.vars`, mật khẩu, hoặc secret vào Git.

Mật khẩu khôi phục điểm dữ liệu là secret riêng, bắt buộc khác mật khẩu Admin. `Start-Local.ps1` sẽ hỏi mật khẩu này nếu chưa có trong `.dev.vars`. Script thiết lập secrets production sẽ hỏi cả mật khẩu Admin và mật khẩu khôi phục riêng, sau đó lưu cả hai vào Cloudflare. Chạy lại script này khi muốn đổi một trong hai mật khẩu; deploy không thay đổi secrets.

Khi chọn **Khôi phục**, Admin vẫn phải đăng nhập và nhập thêm mật khẩu khôi phục riêng. Máy chủ từ chối restore nếu secret này chưa được cấu hình hoặc trùng với mật khẩu Admin.

Chỉ có một danh sách thành viên. Admin là người duy nhất được thêm, đổi tên hoặc xóa thành viên; toàn bộ thành viên trong danh sách được hiển thị thành cột ở bảng chi và trong bảng tổng hợp.

Sau khi đăng nhập Admin, mở mục **Cấu hình độ rộng cột** ở đầu trang để chỉnh từng vai trò cột trong bảng chi (người chi, Date, nội dung, chi phí, cột thành viên, số người, tiền/người, xóa) và bảng tổng hợp (tên chỉ tiêu, cột thành viên). Các cột thành viên cùng dùng độ rộng theo vai trò; số lượng cột được hiển thị cạnh trường cấu hình. Admin cũng có thể chỉnh cỡ chữ toàn giao diện từ 75% đến 200%. Các cấu hình được lưu trong D1 và dùng chung cho mọi người truy cập; khách chưa đăng nhập không thể thay đổi. Thêm/đổi tên/xóa thành viên quản lý dùng hộp thoại giao diện; xóa khoản chi thực hiện ngay khi bấm nút Xóa. Admin cũng có thể sửa tổng chuyển khoản theo giá trị VND có dấu (âm hoặc dương) cho từng thành viên ở bảng tổng hợp hoặc nhấn **Done** để đặt tổng này thành `Tiền phải chịu - Đã chi`; hệ thống lưu bút toán chênh lệch và nhật ký, không sửa lịch sử giao dịch gốc.

Nhật ký quản trị ghi riêng từng thay đổi trường của khoản chi (người chi, ngày, nội dung, số tiền), thao tác đánh dấu/bỏ đánh dấu người tham gia và điều chỉnh tổng tiền chuyển khoản; nhật ký hiển thị giá trị trước/sau cho các thay đổi này. Mỗi thay đổi được gửi lưu riêng, không cần hoàn thiện cả dòng. Nút thêm khoản chi tạo ngay một dòng nháp trong D1; Summary được tính ngay theo các trường đã nhập dù dòng chưa hoàn tất. Khi chưa nhập số tiền, giá trị tính toán được xem là 0.

Khoản chi có thể là số dương hoặc âm (ví dụ khoản hoàn/điều chỉnh giảm); phần tiền mỗi người được chia đều và phần dư được phân bổ ổn định theo thứ tự thành viên. Admin có thể bấm **Store** để tạo một điểm khôi phục dữ liệu Detail/Summary. Mỗi điểm gồm danh sách thành viên, khoản chi/ngày/người tham gia, giao dịch lịch sử và điều chỉnh cần thiết để dựng lại Summary; không chứa cấu hình giao diện hay nhật ký. Giữ tối đa 50 điểm gần nhất. Chọn **Khôi phục** sẽ thay thế dữ liệu nghiệp vụ bằng điểm đã chọn, giữ nguyên cấu hình giao diện và nhật ký, đồng thời yêu cầu mật khẩu khôi phục riêng.

## Deploy

Sau khi đăng nhập Wrangler (`& $wrangler login`) và tạo D1, cập nhật `database_id` trong `wrangler.toml`. Để thiết lập username Admin, mật khẩu Admin và mật khẩu khôi phục production mà không nhập mật khẩu vào chat, chạy script sau trong PowerShell; hai mật khẩu được nhập ở prompt bảo mật và khóa phiên được tạo ngẫu nhiên:

```powershell
powershell -ExecutionPolicy Bypass -File .\Set-CloudflareSecrets.ps1
```

Script hỏi username Admin, mật khẩu Admin và mật khẩu khôi phục riêng (không được trùng nhau), rồi gửi các secrets trực tiếp đến Cloudflare Workers mà không ghi vào tệp dự án. Chạy lại script này khi muốn đổi thông tin đăng nhập hoặc mật khẩu khôi phục. Không deploy ứng dụng công khai trước khi thiết lập đủ secrets.

```powershell
powershell -ExecutionPolicy Bypass -File .\Deploy-Cloudflare.ps1
```

Script deploy kiểm tra đăng nhập Cloudflare và đủ bốn secrets (username Admin, mật khẩu Admin, secret phiên và mật khẩu khôi phục), áp dụng các migration còn thiếu vào D1 remote, deploy Worker/assets, rồi kiểm tra endpoint trạng thái. Nếu thiếu secret, script yêu cầu chạy script thiết lập secrets trước. Chạy lại lệnh deploy này sau mỗi lần muốn đưa thay đổi mới lên production; mật khẩu sẽ không bị hỏi hoặc đổi trong quá trình deploy. `wrangler.toml` chứa tên Worker và D1 production. Database được giữ nguyên qua các lần deploy; không có bước nhập dữ liệu local/workbook tự động. Sao lưu D1 định kỳ trước khi đưa dữ liệu thật vào.

## Quyền truy cập và sao lưu

Trang đọc công khai và khách chưa đăng nhập có thể sửa/xóa khoản chi. Điều này cho phép cả người lạ trên Internet thay đổi dữ liệu; giới hạn tần suất và nhật ký không xác minh được danh tính. Admin là người duy nhất được quản lý thành viên và chỉnh tổng chuyển khoản. Hãy cân nhắc kỹ trước khi dùng với dữ liệu thật.

Trước khi deploy, kiểm tra lại hạn mức Cloudflare, tạo quy trình sao lưu D1 và thử khôi phục bản sao lưu. Xóa thành viên sẽ xóa cứng các khoản chi có liên quan và thanh toán lịch sử của người đó.
