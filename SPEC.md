# Đặc tả sản phẩm: Sổ chi tiêu nhóm

**Trạng thái:** MVP đã chốt yêu cầu, đang triển khai  
**Mục tiêu:** Thay bảng tính “File này cực kì cute” bằng một website responsive cho nhóm 1–50 người.  
**Ngôn ngữ:** Tiếng Việt · **Tiền:** VND, nhập theo nghìn đồng.

## 1. Mục tiêu và dữ liệu khởi đầu

Website giữ cách nhập dạng bảng trong Google Sheets: một khoản chi trên mỗi dòng, người trả, nội dung, số tiền và các thành viên cùng chịu khoản đó. Ứng dụng tính phần mỗi người chịu và bảng số dư cần tất toán qua Admin.

Khởi tạo dữ liệu từ tab **Detail** trong workbook tham chiếu: danh sách người và các khoản chi có dữ liệu. Không nhập các tab Back up/Template, công thức bảng tính hay trạng thái thanh toán cũ chưa xác minh. Script nhập dữ liệu chạy cục bộ; không lưu dữ liệu chi tiêu thật vào Git. Các khoản nhập từ sheet được quy đổi từ nghìn đồng sang đồng nguyên và làm tròn gần nhất.

## 2. Phạm vi MVP

- Một sổ chi tiêu chung, không tách thành từng buổi đi; toàn bộ dòng chi nằm trong cùng bảng.
- Bảng 1: người chi, ngày, nội dung, chi phí, checkbox tham gia cho từng thành viên, số người chia và số tiền trung bình/người.
- Bảng 2: mỗi người, tổng chi phí họ chịu, tổng khoản họ trả thay, khoản họ đã nộp Admin, khoản Admin đã hoàn và số dư còn phải tất toán.
- Người xem không cần tài khoản. Có thể thêm/sửa/xóa khoản chi và chọn/bỏ chọn người tham gia. Chỉ Admin được thêm, đổi tên hoặc xóa thành viên; danh sách này được dùng cho các cột ở bảng chi và bảng tổng hợp.
- Người dùng có thể báo một lần nộp tiền cho Admin (cho phép trả nhiều lần/trả một phần); khoản báo này ở trạng thái chờ cho đến khi Admin xác nhận đã nhận.
- Admin đăng nhập để quản lý thành viên, xem và xác nhận khoản nộp, ghi nhận tiền hoàn cho thành viên, và quản lý toàn bộ dữ liệu.
- Admin đăng nhập để tùy chỉnh và lưu độ rộng mọi vai trò cột trên cả bảng chi (kể cả ngày) và bảng tổng hợp. Các cột thành viên có cùng vai trò dùng chung cấu hình; cấu hình được dùng chung cho mọi khách truy cập.
- Admin đăng nhập để chỉnh cỡ chữ toàn giao diện (75%–200%); giá trị được lưu chung trong D1 và áp dụng cho tất cả người truy cập.
- Thêm khoản chi tạo ngay một dòng nháp được lưu trong D1. Mỗi thay đổi trường (bao gồm ngày) hoặc checkbox được tự lưu riêng, không cần hoàn thiện toàn bộ dòng; dòng chưa đầy đủ hoặc chưa có số tiền dương/người tham gia không ảnh hưởng Summary.
- Admin có thể tạo và khôi phục tối đa 50 điểm lưu gần nhất. Điểm lưu gồm dữ liệu cần thiết để phục hồi Detail và Summary (thành viên, khoản chi/ngày/người tham gia, khoản nộp/hoàn và điều chỉnh), không gồm cấu hình giao diện hoặc nhật ký. Khôi phục cần xác nhận, giữ cấu hình và nhật ký hiện tại.
- Admin có thể đặt tổng tiền chuyển khoản đã xác nhận cho từng thành viên ngay trong bảng tổng hợp; giá trị tổng có thể âm hoặc dương để biểu diễn khoản ròng. Chênh lệch được lưu thành bút toán điều chỉnh có audit, giữ nguyên các giao dịch gốc và được tính vào số dư.
- Trong chế độ Admin, nút **Done** ở hàng cuối bảng tổng hợp đặt tổng đã chuyển khoản bằng `Tiền phải chịu - Đã chi` cho thành viên tương ứng, thông qua bút toán điều chỉnh có audit.
- Giao diện responsive, báo lỗi/lưu thành công rõ ràng; xóa khoản chi thực hiện ngay, còn thao tác xóa thành viên có hộp thoại xác nhận.

Ngoài phạm vi: tích hợp chuyển khoản ngân hàng, nhiều loại tiền, tài khoản riêng từng thành viên, chi phí chia theo tỷ lệ/tùy ý, nhập hóa đơn bằng ảnh, nhiều sổ/nhóm.

## 3. Quyền truy cập và cảnh báo công khai

- **Khách:** đọc toàn bộ dữ liệu công khai; được tạo/sửa/xóa khoản chi; được đánh dấu người tham gia; có thể gửi yêu cầu ghi nhận đã nộp tiền cho Admin.
- **Admin:** đăng nhập; có toàn quyền với khoản chi và danh sách thành viên gốc; xác nhận tiền thành viên nộp đã nhận; ghi nhận Admin đã hoàn tiền. Chỉ Admin có thể thay đổi trạng thái thanh toán sang đã xác nhận.
- Không có tài khoản Normal cho từng người. Khách chọn tên thành viên trong danh sách để báo khoản đã nộp; vì không đăng nhập nên không thể xác minh người gửi báo cáo là chính thành viên đó.
- Website và API đọc công khai. Khách có thể sửa dữ liệu từ Internet; bất kỳ ai biết địa chỉ website đều có thể phá hoại hoặc xóa dữ liệu. Kiểm tra dữ liệu, giới hạn tần suất và nhật ký thay đổi chỉ giảm thiệt hại, không xác thực người sửa. Cần cân nhắc rủi ro và sao lưu trước khi mở website công khai.

## 4. Quy tắc dữ liệu và tiền

1. Tiền được lưu bằng số nguyên VND. Trường nhập liệu dùng đơn vị nghìn đồng, chấp nhận dấu phẩy hoặc dấu chấm thập phân; chuyển sang VND bằng cách nhân 1.000 và làm tròn đến đồng gần nhất. Ví dụ `671,2380952` nghìn đồng thành `671.238đ`.
2. Mỗi khoản có đúng một người trả; khoản chi được chia đều cho ít nhất một người tham gia đã chọn. Người trả không tự động được tính là người tham gia.
3. Chia đều bằng số đồng nguyên: lấy phần nguyên, phân bổ số đồng dư theo thứ tự thành viên ổn định trong danh sách. Tổng phần chịu luôn đúng bằng tiền khoản chi. “Số tiền 1 người” hiển thị trung bình có thể có phần thập phân để tham khảo.
4. Cho mỗi thành viên:
   - `chi_phi_chiu` = tổng phần chia của các khoản thành viên tham gia.
   - `da_tra_thay` = tổng các khoản chi mà thành viên là người trả.
   - `da_nop_admin` = tổng thanh toán từ thành viên tới Admin đã được Admin xác nhận.
   - `admin_da_hoan` = tổng thanh toán Admin đã ghi nhận hoàn cho thành viên.
   - `so_du` = `chi_phi_chiu - da_tra_thay - da_nop_admin + admin_da_hoan`.
   - Số dư dương: thành viên còn nộp cho Admin. Số dư âm: Admin còn hoàn cho thành viên. Không ghép cặp nợ giữa các thành viên.
5. Yêu cầu nộp tiền đang chờ xác nhận không thay đổi số dư. Admin hoàn tiền được ghi nhận trực tiếp là đã hoàn theo lựa chọn hiện tại.
6. Xóa thành viên là xóa cứng. Để không giữ khoản chi mất người trả/người tham gia, khi xóa thành viên hệ thống cũng xóa mọi khoản chi mà người đó trả hoặc tham gia, cùng các thanh toán liên quan; cảnh báo rõ tác động và tính lại số dư. Đây là thao tác không thể khôi phục nếu không có bản sao lưu.
7. API kiểm tra đầu vào, ràng buộc thành viên/khoản chi hợp lệ và giới hạn tần suất ghi/đăng nhập. Mật khẩu Admin và khóa phiên chỉ được lưu trong secrets phía server, không nằm trong frontend/repository.

## 5. Luồng sử dụng

1. Khách mở website, xem sổ và sửa/thêm khoản chi hoặc người tham gia.
2. Ứng dụng lưu dữ liệu và cập nhật bảng tổng hợp số dư.
3. Thành viên chọn tên của mình, gửi số tiền đã chuyển tới Admin; giao dịch hiển thị đang chờ.
4. Admin đăng nhập để quản lý danh sách thành viên. Toàn bộ thành viên xuất hiện ở bảng chi và bảng tổng hợp. Admin cũng xác nhận khoản nộp đã nhận hoặc ghi nhận khoản hoàn đã chuyển cho thành viên.
5. Bảng số dư cập nhật chỉ từ khoản nộp/hoàn đã xác nhận.

## 6. Công nghệ và triển khai

- Static frontend HTML/CSS/JavaScript, không cần build tool.
- Cloudflare Worker phục vụ frontend và API.
- Cloudflare D1 (SQLite) làm database; migrations SQL nằm trong `migrations/`.
- Cloudflare free tier dùng cho thử nghiệm; cần rà lại hạn mức, sao lưu và giá hiện hành trước khi dùng lâu dài. Không cần mua tên miền cho bản thử.
- Cấu hình Admin qua Cloudflare secrets: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`. Không đặt giá trị thật trong `wrangler.toml`, mã nguồn hay tài liệu.
- Backup/export định kỳ trước khi dùng dữ liệu thật.

## 7. Tiêu chí nghiệm thu MVP

- Tab Detail được khởi tạo với các thành viên và khoản chi có dữ liệu; giá trị nghìn đồng đã được chuyển sang đồng nguyên.
- Có thể nhập, sửa, xóa khoản chi và chọn nhiều người tham gia; số người/phần chia tự tính đúng.
- Tổng các phần chịu luôn bằng số tiền khoản chi; số dư mỗi người khớp công thức tại mục 4 và tổng nộp/hoàn được tính đúng.
- Khách chưa đăng nhập có thể sửa khoản chi nhưng không thể quản lý thành viên hoặc xác nhận thanh toán.
- Admin có thể đăng nhập, quản lý thành viên, xác nhận khoản nộp và ghi nhận khoản hoàn.
- Admin có thể cấu hình độ rộng mọi cột theo vai trò, kể cả Date, áp dụng cấu hình cho mọi người dùng và đặt lại mặc định; các cột thành viên cùng vai trò dùng chung độ rộng và số lượng cột được hiển thị; khách chưa đăng nhập không thể lưu thay đổi.
- Admin có thể cấu hình cỡ chữ, áp dụng ngay và dùng chung cho tất cả khách; các thao tác nhập tên/xác nhận/xóa dùng hộp thoại giao diện, không dùng prompt/confirm của trình duyệt.
- Admin có thể sửa tổng tiền đã chuyển khoản, bao gồm đặt về 0; bút toán điều chỉnh phải cập nhật bảng số dư và nhật ký mà không thay đổi giao dịch gốc. Nhật ký nêu riêng từng trường khoản chi thay đổi, đánh dấu/bỏ đánh dấu người tham gia và giá trị trước/sau của tổng chuyển khoản.
- Nút **Done** trong chế độ Admin đặt tiền đã chuyển khoản về `Tiền phải chịu - Đã chi` cho người tương ứng.
- Mỗi trường và trạng thái checkbox của khoản chi tự lưu độc lập; có thể tải lại trang khi dòng còn thiếu trường mà dữ liệu đã nhập vẫn còn. Dòng không hoàn chỉnh không làm sai số dư.
- Date nằm giữa Người chi và Nội dung, nhận ngày hợp lệ và được lưu cùng khoản chi.
- Admin tạo được điểm khôi phục bằng Store, danh sách giữ tối đa 50 điểm; khôi phục đúng dữ liệu nghiệp vụ nhưng không ghi đè cấu hình hoặc nhật ký.
- API hiển thị lỗi khi dữ liệu sai, thiếu quyền Admin hoặc vượt giới hạn; không báo thành công giả.
- Xóa khoản chi thực hiện ngay; xóa thành viên có cảnh báo số khoản chi và thanh toán sẽ bị xóa theo.
- Dùng được trên điện thoại/desktop và hỗ trợ HTTPS khi deploy.

## 8. Tệp trong dự án

- `SPEC.md`: yêu cầu, quy tắc và quyền truy cập.
- `README.md`: chạy local, cấu hình secrets, migration và deploy.
- `worker/index.js`: Worker/API.
- `public/`: giao diện.
- `migrations/`: schema database.
- `tools/import_detail.py`: nhập cục bộ workbook Detail sang SQL.
