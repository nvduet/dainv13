# Đặc tả sản phẩm: Sổ chi tiêu nhóm

**Trạng thái:** MVP đã chốt yêu cầu, đang triển khai  
**Mục tiêu:** Thay bảng tính “File này cực kì cute” bằng một website responsive cho nhóm 1–50 người.  
**Ngôn ngữ:** Tiếng Việt · **Tiền:** VND, nhập theo nghìn đồng.

## 1. Mục tiêu và dữ liệu khởi đầu

Website giữ cách nhập dạng bảng trong Google Sheets: một khoản chi trên mỗi dòng, người trả, nội dung, số tiền và các thành viên cùng chịu khoản đó. Ứng dụng tính phần mỗi người chịu và bảng số dư cần tất toán qua Admin.

Dữ liệu ban đầu lấy từ tab **Detail** trong workbook tham chiếu: danh sách người và các khoản chi có dữ liệu. Không nhập các tab Back up/Template, công thức bảng tính hay trạng thái thanh toán cũ chưa xác minh. Các khoản nhập từ sheet được quy đổi từ nghìn đồng sang đồng nguyên và làm tròn gần nhất.

## 2. Phạm vi MVP

- Một website quản lý nhiều sổ chi tiêu độc lập; mỗi sổ có link riêng, thành viên/khoản chi/nhóm thành viên/Store/nhật ký riêng. Cỡ chữ, kích thước QR và cấu hình độ rộng cột dùng chung cho mọi sổ. Sổ hiện hữu được giữ tại link `/g/chill-guys` và trang chủ vẫn mở sổ này.
- Bảng 1: người chi, ngày, nội dung, chi phí, checkbox tham gia cho từng thành viên, số người chia và số tiền trung bình/người.
- Bảng 2: mỗi người, tổng chi phí họ chịu, tổng khoản họ trả thay, khoản họ đã nộp Admin, khoản Admin đã hoàn và số dư còn phải tất toán.
- Người xem không cần tài khoản. Trên từng sổ, khách có thể thêm/sửa/xóa khoản chi và chọn/bỏ chọn người tham gia. Chỉ Admin chung được thêm, đổi tên hoặc xóa thành viên của sổ đang mở.
- Admin dùng một tài khoản chung để tạo và truy cập mọi sổ; mỗi link trỏ tới dữ liệu riêng. Tạo sổ cần mật khẩu thao tác ở lần đầu trong phiên Admin; xóa sổ luôn cần Admin nhập mật khẩu thao tác. Sổ Chill guys mặc định không thể xóa.
- **Mật khẩu thao tác:** một mật khẩu dùng chung, khác mật khẩu Admin, bảo vệ bốn thao tác tạo sổ, xóa sổ, Store và khôi phục. Tạo sổ và Store chỉ hỏi ở lần đầu trong mỗi phiên đăng nhập Admin và có hiệu lực cho mọi sổ; xóa sổ và khôi phục luôn hỏi. Bốn thao tác dùng chung một giới hạn số lần nhập mật khẩu.
- Các giao dịch nộp/hoàn đã xác nhận từ dữ liệu lịch sử vẫn được tính vào số dư; giao diện hiện tại không tạo yêu cầu nộp hoặc ghi nhận khoản hoàn mới.
- Admin đăng nhập để tùy chỉnh và lưu độ rộng mọi vai trò cột trên cả bảng chi (kể cả ngày) và bảng tổng hợp. Các cột thành viên có cùng vai trò dùng chung cấu hình; một cấu hình áp dụng cho tất cả sổ và khách truy cập. Độ rộng được lưu theo px; màn hình rộng hơn 760px hiển thị bảng bằng 0,8 lần giá trị đã lưu, điện thoại hiển thị đúng giá trị đã lưu.
- Admin đăng nhập để chỉnh cỡ chữ toàn giao diện (75%–200%); giá trị được lưu chung trong D1 và áp dụng cho tất cả người truy cập.
- Admin đăng nhập để cấu hình chiều rộng tối đa ảnh QR (80px–1600px); một giá trị được chia sẻ cho tất cả sổ. Ảnh hiển thị đúng số px đã cấu hình, không vượt quá bề rộng khung.
- Thêm khoản chi tạo ngay một dòng nháp được lưu trong D1. Mỗi thay đổi trường (bao gồm ngày) hoặc checkbox được tự lưu riêng, không cần hoàn thiện toàn bộ dòng; Summary tính độc lập theo các trường đã nhập, xem số tiền trống là 0. Số tiền khoản chi có thể dương, âm hoặc bằng 0.
- Admin có thể tạo và khôi phục tối đa 50 điểm lưu gần nhất. Điểm lưu gồm dữ liệu cần thiết để phục hồi Detail và Summary (thành viên, khoản chi/ngày/người tham gia, khoản nộp/hoàn và điều chỉnh), không gồm cấu hình giao diện hoặc nhật ký. Khôi phục cần xác nhận, giữ cấu hình và nhật ký hiện tại.
- Mỗi Store bắt buộc có lời nhắn tối đa 200 ký tự; Admin nhập mật khẩu thao tác ở lần Store (hoặc tạo sổ) đầu tiên của phiên đăng nhập, các lần Store sau trong cùng phiên không hỏi lại. Khôi phục luôn yêu cầu mật khẩu thao tác.
- Admin có thể tạo nhiều nhóm thành viên; mỗi thành viên thuộc tối đa một nhóm. Thành viên cùng nhóm đứng cạnh nhau trong Detail và Summary; Summary thêm hàng số dư gộp của mỗi nhóm.
- Nhật ký Detail được gom theo phiên hoạt động chung của ứng dụng: thay đổi từ Admin và khách trong vòng 30 phút kể từ hoạt động Detail gần nhất thuộc cùng phiên. Mỗi phiên lưu ảnh chụp trước/sau, hiển thị được hai bảng Detail và đánh dấu thêm/xóa/sửa bằng màu; giữ tối đa 999 phiên, xóa phiên cũ nhất khi vượt giới hạn.
- Admin có thể đặt tổng tiền chuyển khoản đã xác nhận cho từng thành viên ngay trong bảng tổng hợp; giá trị tổng có thể âm hoặc dương để biểu diễn khoản ròng. Chênh lệch được lưu thành bút toán điều chỉnh có audit, giữ nguyên các giao dịch gốc và được tính vào số dư.
- Trong chế độ Admin, nút **Done** ở hàng cuối bảng tổng hợp đặt tổng đã chuyển khoản bằng `Tiền phải chịu - Đã chi` cho thành viên tương ứng, thông qua bút toán điều chỉnh có audit.
- Giao diện responsive, báo lỗi/lưu thành công rõ ràng; xóa khoản chi có thể hoàn tác trong 6 giây (xem dưới), còn thao tác xóa thành viên có hộp thoại xác nhận.
- **Giao diện:** nút "Đổi giao diện" ở đầu trang (khách và Admin) cho mỗi người xem chọn một trong bốn giao diện: Than chì (mặc định), Rừng xanh (giao diện trước đây), Ngà & Vàng, Navy & Đồng, và chế độ Tự động (theo sáng/tối của thiết bị), Sáng hoặc Tối. Lựa chọn áp dụng ngay, chỉ lưu trên thiết bị đó (không gửi lên máy chủ, không đổi giao diện của người khác) và có ngay từ lúc trang hiện ở lần mở sau. Màu số dư giữ nghĩa ở mọi giao diện: đỏ là còn phải nộp Admin, xanh lá là được Admin hoàn. Giao diện tắt hiệu ứng chuyển động khi thiết bị bật giảm chuyển động. Trong lúc tải dữ liệu, các bảng hiện khung giữ chỗ. Trên màn hình cảm ứng, ô Chi phí đang nhập có nút "±" để đổi dấu, vì bàn phím số của iPhone không có dấu trừ. Thời gian của điểm lưu và nhật ký hiển thị theo giờ của thiết bị người xem; máy chủ lưu giờ UTC.
- Trên màn hình cảm ứng hoặc cửa sổ thấp, cả trang cuộn thay vì khung bảng Detail. Gợi ý "Vuốt ngang…" (dùng chuột: "Cuộn ngang…") chỉ hiện khi bảng rộng hơn khung. Cột thao tác của mỗi dòng luôn đủ chỗ cho hai nút và rộng theo cỡ chữ.
- **Tìm, lọc, sắp xếp (Detail):** ô tìm theo nội dung, không phân biệt hoa thường và dấu ("an trua" tìm được "Ăn trưa"; mọi từ phải có, thứ tự tùy ý); lọc theo người chi, người tham gia, khoảng ngày và "Thiếu thông tin" (thiếu người chi, ngày, nội dung, số tiền hoặc người tham gia); sắp xếp theo thứ tự nhập (mặc định), ngày, số tiền hoặc nội dung A→Z. Đây chỉ là cách xem: Summary và số liệu đầu trang luôn tính mọi khoản. Khi đang lọc, dòng trạng thái ghi "Đang hiển thị x/y dòng · Tổng …" kèm nút "Xóa lọc". Dòng đang sửa không biến mất hay nhảy chỗ: bộ lọc chỉ áp dụng lại khi đổi điều kiện hoặc khi rời bảng, dòng vừa thêm vẫn hiện tới khi đổi điều kiện. Cách sắp xếp được nhớ theo từng sổ trên thiết bị; bộ lọc mất khi tải lại trang. Khi thẻ Detail không đủ rộng cho cả thanh trên một dòng, trên màn hình cảm ứng và cửa sổ thấp, thanh thu gọn thành ô tìm và nút "Lọc & sắp xếp".
- **Xuất CSV:** nút "Xuất CSV" tải file `so-chi-<slug>-<YYYY-MM-DD>.csv` (UTF-8 có BOM) ngay trên trình duyệt, không gọi máy chủ. File gồm phần Detail (mọi dòng theo thứ tự nhập, kể cả giá trị đang gõ dở) và phần Summary theo thành viên; tiền là số nguyên đồng. Dấu phân cách là `;` khi trình duyệt dùng dấu phẩy thập phân, ngược lại là `,`. Ô bắt đầu bằng `=`, `+`, `-` hoặc `@` được thêm dấu `'` để bảng tính không chạy như công thức. Nút chỉ bật khi dữ liệu đã tải xong.
- **Xóa có hoàn tác:** xóa khoản chi ẩn dòng ngay (Summary tính lại ngay) và hiện "Đã xóa khoản chi." với nút "Hoàn tác" trong 6 giây; thời gian dừng đếm khi chuột đặt trên thông báo hoặc con trỏ bàn phím ở trong đó. Lệnh xóa chỉ gửi lên máy chủ khi hết thời gian, khi bấm × hoặc Esc, khi trang bị ẩn hay đóng, và trước Store, khôi phục, đăng xuất, đổi sổ hoặc tải lại dữ liệu; thiết bị khác vẫn thấy dòng tới lúc đó. Máy chủ từ chối thì dòng trở lại đúng chỗ kèm lỗi, và Store, khôi phục, đăng xuất dừng lại cho tới khi xử lý xong. Lệnh xóa gửi lúc đóng trang không báo lỗi được; nếu thất bại, dòng hiện lại ở lần tải sau.
- **Hoàn tác/làm lại thay đổi:** nút "Hoàn tác", "Làm lại" ở tiêu đề Detail và phím Ctrl/⌘+Z, Ctrl+Y hoặc Ctrl/⌘+Shift+Z khi con trỏ không ở trong ô nhập hay hộp thoại (trong ô nhập, phím tắt là hoàn tác gõ của trình duyệt). Lịch sử thuộc phiên trang hiện tại, tối đa 50 bước, mất khi tải lại hoặc đổi sổ; các lần lưu cùng một ô trong 3 giây gộp thành một bước; hoàn tác "Thêm dòng" hay "Nhân bản" là xóa dòng đó (có thông báo hoàn tác). Hoàn tác đi qua cơ chế tự lưu thường và chỉ báo thành công khi máy chủ đã lưu. Phần dữ liệu trang đã thấy bị đổi từ nơi khác được bỏ qua với thông báo "Không thể hoàn tác vì dữ liệu đã thay đổi.". **Giới hạn:** trang chỉ biết thay đổi nó đã nhận được, nên hoàn tác sẽ ghi đè thay đổi từ máy khác mà trang chưa tải về (giống gõ đè).
- **Chi tiết thành viên:** bấm tên thành viên ở tiêu đề Summary để mở hộp thoại gồm nhóm, bốn tổng, số dư kèm lời giải thích, các khoản chi người đó trả hoặc tham gia (phần chịu tính đúng như Summary) và các lần chuyển khoản, điều chỉnh, Admin hoàn.
- **Tự cập nhật khi quay lại:** trang bị ẩn hoặc rời cửa sổ ít nhất 30 giây rồi quay lại thì tải dữ liệu một lần (không hỏi máy chủ định kỳ), giữ nguyên ô đang sửa, thay đổi chưa lưu, bộ lọc và vị trí cuộn; chỉ báo "Đã cập nhật dữ liệu mới." khi có thay đổi.
- **Nhân bản và phép tính:** nút "Nhân bản" trên mỗi dòng tạo khoản mới cùng người chi, ngày, nội dung, số tiền và người tham gia, thêm vào cuối và hoàn tác được. Ô Chi phí nhận phép tính theo nghìn đồng: `+ - * /`, ngoặc, dấu phẩy hoặc chấm thập phân (vd. `120+45`, `300/2`, `1,5*3`); kết quả làm tròn và giới hạn như số thường, hiện ra khi rời ô; phép tính sai báo số tiền không hợp lệ, chia cho 0 báo "Không thể chia cho 0.". Nếu rời trang ngay khi bản sao đang được tạo, có thể còn lại một dòng trống.

Ngoài phạm vi: tích hợp chuyển khoản ngân hàng, nhiều loại tiền, tài khoản riêng từng thành viên, chi phí chia theo tỷ lệ/tùy ý, nhập hóa đơn bằng ảnh.

## 3. Quyền truy cập và cảnh báo công khai

- **Khách:** đọc toàn bộ dữ liệu công khai; được tạo/sửa/xóa khoản chi và chọn/bỏ chọn người tham gia.
- **Admin:** đăng nhập; có toàn quyền với khoản chi và danh sách thành viên gốc, đồng thời chỉnh tổng tiền chuyển khoản qua bút toán điều chỉnh.
- Website và API đọc công khai. Khách có thể sửa dữ liệu trong sổ tương ứng từ Internet; bất kỳ ai biết link đều có thể phá hoại hoặc xóa dữ liệu của sổ đó. Link riêng chỉ phân tách dữ liệu, không phải mật khẩu. Kiểm tra dữ liệu, giới hạn tần suất và nhật ký thay đổi chỉ giảm thiệt hại, không xác thực người sửa. Cần cân nhắc rủi ro và sao lưu trước khi mở website công khai.
- Trang sổ đề nghị máy tìm kiếm không lập chỉ mục (thẻ meta robots, header `X-Robots-Tag`, `robots.txt`). Đây chỉ là lời đề nghị, không phải cơ chế bảo mật: link sổ vẫn công khai với người biết link.

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
5. Các giao dịch nộp/hoàn đã xác nhận được lưu từ trước vẫn được tính vào số dư. Yêu cầu nộp đang chờ không được tính.
6. Xóa thành viên là xóa cứng. Để không giữ khoản chi mất người trả/người tham gia, khi xóa thành viên hệ thống cũng xóa mọi khoản chi mà người đó trả hoặc tham gia, cùng các thanh toán liên quan; cảnh báo rõ tác động và tính lại số dư. Đây là thao tác không thể khôi phục nếu không có bản sao lưu.
7. API kiểm tra đầu vào, ràng buộc thành viên/khoản chi hợp lệ và giới hạn tần suất ghi/đăng nhập/nhập mật khẩu thao tác. Khi vượt giới hạn, API trả lỗi kèm thời gian chờ; trang tự lưu lại các thay đổi khoản chi sau thời gian đó. Mật khẩu Admin, mật khẩu thao tác và khóa phiên chỉ được lưu trong secrets phía server, không nằm trong frontend/repository.

## 5. Luồng sử dụng

1. Khách mở website, xem sổ và sửa/thêm khoản chi hoặc người tham gia.
2. Ứng dụng lưu dữ liệu và cập nhật bảng tổng hợp số dư.
3. Thành viên chuyển khoản cho Admin. Admin ghi tổng tiền đã chuyển của từng người ngay trong Summary (lưu thành bút toán điều chỉnh), hoặc bấm **Done** khi người đó đã tất toán.
4. Admin đăng nhập để quản lý danh sách thành viên. Toàn bộ thành viên xuất hiện ở bảng chi và bảng tổng hợp. Admin có thể điều chỉnh tổng tiền chuyển khoản, Store điểm dữ liệu, và luôn cần nhập mật khẩu thao tác để khôi phục một điểm.
5. Bảng số dư cập nhật từ khoản chi, dữ liệu thanh toán lịch sử đã xác nhận và các bút toán điều chỉnh.

## 6. Công nghệ và triển khai

- Static frontend HTML/CSS/JavaScript, không cần build tool.
- Cloudflare Worker phục vụ frontend và API.
- Cloudflare D1 (SQLite) làm database; migrations SQL nằm trong `migrations/`.
- Cloudflare free tier dùng cho thử nghiệm; cần rà lại hạn mức, sao lưu và giá hiện hành trước khi dùng lâu dài. Không cần mua tên miền cho bản thử.
- `wrangler.toml` bật Workers Logs (xem log của Worker trong Cloudflare dashboard, trong hạn mức miễn phí) và tắt URL preview riêng của từng phiên bản (`preview_urls = false`), để chỉ địa chỉ chính phục vụ trang.
- Cấu hình xác thực qua Cloudflare secrets: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` và `HISTORY_RESTORE_PASSWORD` (mật khẩu thao tác) riêng biệt. Không đặt giá trị thật trong `wrangler.toml`, mã nguồn hay tài liệu.
- Backup/export định kỳ trước khi dùng dữ liệu thật: Store giữ điểm khôi phục trên máy chủ, "Xuất CSV" giữ một bản trên máy người dùng.

## 7. Tiêu chí nghiệm thu MVP

- Tab Detail được khởi tạo với các thành viên và khoản chi có dữ liệu; giá trị nghìn đồng đã được chuyển sang đồng nguyên.
- Có thể nhập, sửa, xóa khoản chi và chọn nhiều người tham gia; số người/phần chia tự tính đúng.
- Tổng các phần chịu luôn bằng số tiền khoản chi; số dư mỗi người khớp công thức tại mục 4 và tổng nộp/hoàn được tính đúng.
- Khách chưa đăng nhập có thể sửa khoản chi của sổ đang mở nhưng không thể quản lý thành viên, sổ hoặc cấu hình.
- Admin có thể tạo nhiều sổ với link riêng; dữ liệu, cấu hình, Store và nhật ký của từng sổ độc lập, và người có link không thể đọc hoặc sửa sổ khác bằng cách thay URL.
- Tạo sổ hỏi mật khẩu thao tác ở lần đầu trong phiên Admin; xóa sổ luôn hỏi mật khẩu thao tác và từ chối khi sai.
- Admin có thể đăng nhập và quản lý danh sách thành viên.
- Admin có thể cấu hình độ rộng mọi cột theo vai trò, kể cả Date, áp dụng cấu hình cho mọi người dùng và đặt lại mặc định; các cột thành viên cùng vai trò dùng chung độ rộng và số lượng cột được hiển thị; khách chưa đăng nhập không thể lưu thay đổi.
- Admin có thể cấu hình cỡ chữ, áp dụng ngay và dùng chung cho tất cả khách; thao tác nhập tên/xóa dùng hộp thoại giao diện, không dùng prompt/confirm của trình duyệt.
- Admin có thể sửa tổng tiền đã chuyển khoản, bao gồm đặt về 0; bút toán điều chỉnh phải cập nhật bảng số dư và nhật ký mà không thay đổi giao dịch gốc. Nhật ký nêu riêng từng trường khoản chi thay đổi, đánh dấu/bỏ đánh dấu người tham gia và giá trị trước/sau của tổng chuyển khoản.
- Nút **Done** trong chế độ Admin đặt tiền đã chuyển khoản về `Tiền phải chịu - Đã chi` cho người tương ứng.
- Mỗi trường và trạng thái checkbox của khoản chi tự lưu độc lập; có thể tải lại trang khi dòng còn thiếu trường mà dữ liệu đã nhập vẫn còn. Dòng không hoàn chỉnh không làm sai số dư.
- Date nằm giữa Người chi và Nội dung, nhận ngày hợp lệ và được lưu cùng khoản chi.
- Admin tạo được điểm khôi phục bằng Store, danh sách giữ tối đa 50 điểm; khôi phục chỉ thành công với mật khẩu thao tác (khác mật khẩu Admin), và không ghi đè cấu hình hoặc nhật ký.
- Admin có thể tạo/sửa/xóa nhóm; API từ chối nhóm có ít hơn hai thành viên, thành viên không tồn tại hoặc đã thuộc nhóm khác. Thành viên của nhóm đứng liền nhau và Summary tính đúng tổng số dư nhóm.
- Store yêu cầu lời nhắn không rỗng (tối đa 200 ký tự) và mật khẩu thao tác ở lần đầu trong phiên Admin; mỗi điểm hiển thị lời nhắn khi xem lại lịch sử.
- Các thay đổi Detail từ Admin và khách trong cùng khoảng hoạt động 30 phút xuất hiện trong cùng phiên nhật ký. Hai bảng trước/sau tô màu các dòng khoản chi được thêm, xóa hoặc sửa; số phiên lưu không bao giờ vượt quá 999.
- API hiển thị lỗi khi dữ liệu sai, thiếu quyền Admin hoặc vượt giới hạn; không báo thành công giả.
- Xóa khoản chi hoàn tác được trong 6 giây và chỉ gửi lên máy chủ sau đó (hoặc sớm hơn theo mục 2); lệnh xóa bị từ chối đưa dòng trở lại kèm lỗi và không bao giờ báo "Đã xóa". Xóa thành viên có cảnh báo số khoản chi và thanh toán sẽ bị xóa theo.
- Tìm, lọc và sắp xếp không đổi dữ liệu hay Summary; dòng đang sửa không nhảy chỗ; thanh công cụ đầy đủ luôn nằm trên một dòng, nếu không đủ chỗ thì thu gọn.
- File CSV mở đúng cột trong bảng tính dùng dấu phẩy thập phân (`;`) và dấu chấm thập phân (`,`); tiền là số nguyên đồng khớp Summary.
- Hoàn tác/làm lại không bao giờ báo thành công giả; hoàn tác một giá trị trang đã thấy bị đổi từ nơi khác báo "Không thể hoàn tác vì dữ liệu đã thay đổi.".
- Các tổng trong Chi tiết thành viên khớp đúng hàng của người đó trong Summary.
- Quay lại trang sau ít nhất 30 giây tải dữ liệu đúng một lần và không làm mất ô đang sửa.
- Phép tính trong ô Chi phí cho cùng kết quả như nhập số tương ứng; bản sao của một dòng có đủ năm trường của dòng gốc.
- Dùng được trên điện thoại/desktop và hỗ trợ HTTPS khi deploy.

## 8. Tệp trong dự án

- `SPEC.md`: yêu cầu, quy tắc và quyền truy cập.
- `README.md`: cấu hình Cloudflare, secrets và deploy production.
- `worker/`: Worker/API (điểm vào `worker/index.js`, bảng định tuyến `worker/router.js`).
- `public/`: giao diện.
- `migrations/`: schema database.
- `scripts/`: scripts cấu hình secrets và deploy Cloudflare.
- `tests/`: kiểm thử logic, API (worker thật trên SQLite) và các module giao diện không cần trình duyệt.
