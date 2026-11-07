# Kế hoạch nâng cấp "Sổ chi nhóm bạn"

> File theo dõi tiến độ. Cập nhật sau mỗi bước. Có thể xóa khi mọi giai đoạn đã xong.
> Bắt đầu: 2026-11-02. Phiên Claude Code đầu tiên: `82ca8ed4`.

## 1. Nguyên tắc bắt buộc

- **Không deploy, không push lên server.** Không chạy `scripts\push_to_server.*`, `scripts\change_pass.*`, `wrangler`/`npx`. Chỉ chạy local để kiểm thử.
- **Giữ công nghệ và giới hạn free tier:** Cloudflare Workers + D1 (SQLite) + HTML/CSS/JS thuần, không build, không thư viện npm.
  - Workers Free: 10 ms CPU/request, 50 subrequest (mỗi query D1 tính 1, một `db.batch()` tính 1), 100.000 request/ngày.
  - D1 Free: 5 triệu rows read/ngày, 100.000 rows written/ngày, 100 tham số bind/query, 100 KB/câu SQL, 2 MB/giá trị.
  - Static asset miễn phí, không gọi Worker.
- **Dự án luôn ở trạng thái chạy được.** Mọi việc làm trong thư mục làm việc riêng; thư mục `code` chỉ nhận thay đổi khi một giai đoạn đã qua toàn bộ kiểm tra. Nếu phiên bị ngắt giữa chừng, code trong dự án vẫn là bản ổn định gần nhất.
- Không sửa các migration đã áp dụng (0001–0013). Chỉ thêm migration mới, an toàn với dữ liệu hiện có và với các bảng `ledger_<id>_*` đã tồn tại.

## 2. Vị trí quan trọng

| Thứ | Đường dẫn |
|---|---|
| Bản sao lưu nguyên trạng trước khi sửa | `C:\DaiNV13\DaiNV13\pyhton\restore text\code_backup_before_refactor_2026-11-02` |
| Không gian làm việc bền vững (harness test local, đặc tả, kết quả review, baseline) | `C:\DaiNV13\DaiNV13\pyhton\restore text\refactor-workspace` |
| Kết quả review đã kiểm chứng (82 phát hiện) | `refactor-workspace\review\findings.json` |
| Đặc tả từng giai đoạn | `refactor-workspace\plan\*.md` |
| Thư mục làm việc dở dang của phiên 82ca8ed4 (tạm) | `%LOCALAPPDATA%\Temp\claude\c--DaiNV13-DaiNV13-pyhton-restore-text-code\82ca8ed4-1e92-4db2-a1da-3744fb1d43c6\scratchpad\work-*` |

Chạy test không cần cài Node: VS Code có sẵn Node 24.

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" --test
```

(Hoặc dùng shim `refactor-workspace\bin\node.cmd`.) Chạy từ thư mục `code`, lệnh trên tự tìm mọi file `tests\*.test.mjs`.

## 3. Tiến độ

- [x] **GĐ0 – Chuẩn bị.** Sao lưu; harness local (D1 giả lập bằng SQLite thật, server chạy đúng `worker.fetch`, kịch bản API 100 bước, E2E giao diện 54 quan sát, ảnh chụp 9 màn hình tất định qua Chrome headless). Baseline: 24 test cũ + 16 integration test mới đều pass trên code gốc.
- [x] **GĐ1 – Review 7 chiều + kiểm chứng phản biện.** 82 phát hiện; tóm tắt ở mục 4.
- [x] **GĐ2 – Backend** (2026-11-03). Đặc tả: `plan\worker-spec.md`.
  - Tách `worker/index.js` thành `router.js` (bảng ROUTES) + các module + `routes/*.js`.
  - Sửa bảo mật và race; migration `0013`; nâng cấp schema cho từng sổ theo `schema_version`.
  - 2 reviewer, 8/8 phát hiện đã sửa. Tách `worker/index.js` thành module + bảng ROUTES khai báo quyền/rate-limit/nhật ký; sửa lỗ hổng và race; giảm chi phí D1; migration `0013`; bổ sung test.
- [x] **GĐ3 – Hợp nhất mật khẩu.** Xem mục 5 và Mốc B.
- [x] **GĐ4 – Frontend: refactor + sửa lỗi, giữ nguyên từng pixel** (2026-11-03).
  - `app.js` tách thành `public/js/*`; autosave theo id khoản chi.
  - 2 reviewer: 7 phát hiện đã sửa; 2 mục để lại có lý do (xem mục 6).
  - Kiểm tra sơ bộ khi tích hợp với GĐ2, trước vòng sửa:
    - 109/109 test pass;
    - kịch bản API chỉ khác 3 điểm có chủ đích; query D1 giảm từ 826 xuống 343;
    - E2E chỉ khác 3 điểm, đều là lỗi đã sửa;
    - 8/9 ảnh trùng từng pixel; ảnh còn lại chỉ lệch nhiễu khử răng cưa.
  - Lưu ý: ngày 2026-11-02 từng chạm giới hạn 5 giờ của tài khoản; các workflow đã resume. Đặc tả: `plan\frontend-spec.md`. Tách `app.js` thành module, autosave theo id khoản chi, sửa các lỗi mất dữ liệu.
- [x] **Mốc A – Tích hợp GĐ2+GĐ4 vào dự án** (2026-11-03).
  - 117/117 test pass ngay trong thư mục `code`.
  - Kịch bản API (UUID tất định) chỉ khác 3 điểm có chủ đích; query D1 giảm từ 826 xuống 334.
  - E2E chỉ khác 3 điểm, đều là lỗi đã sửa; 0 lỗi JS/HTTP.
  - 8/9 ảnh trùng từng pixel; ảnh còn lại lệch 8 pixel (1–2/255 mức màu), không nhìn thấy được.
  - Đã cập nhật CLAUDE.md và lệnh test trong README.
- [x] **GĐ3 → Mốc B – Hợp nhất mật khẩu + các phát hiện bổ sung của critic** (2026-11-03). Đặc tả: `plan\phase3-passwords.md`.
  - Hợp nhất mật khẩu: backend (`worker/operations-password.js`), form tạo/xóa sổ, `change_pass`.
  - Khi bị giới hạn (429): trả `Retry-After`, tự thử lại có giới hạn. Nâng hạn mức ghi của khách từ 120 lên 300 lần/15 phút, vì nhiều người dùng chung một Wi-Fi.
  - Lỗi mạng hoặc máy chủ tạm thời: tự lưu lại sau 2/5/15/30 giây; thử lại khi có mạng hoặc khi quay lại trang.
  - Cho phép nhập số tiền 0.
  - Báo tab cũ tải lại trang sau khi deploy (409).
  - `change_pass` gửi secret dạng UTF-8 và từ chối khoảng trắng ở đầu/cuối.
  - `push_to_server` không dừng khi wrangler in cảnh báo.
  - Đã bỏ PBKDF2: mỗi lần tạo/xóa sổ đỡ khoảng 11 ms CPU.
  - 2 reviewer: 11 phát hiện (2 trùng), đã sửa hết.
  - Kiểm tra khi tích hợp:
    - 136/136 test pass;
    - kịch bản API chỉ khác 25 bước, đều có chủ đích; tổng query D1 giữ nguyên 347;
    - E2E giống hệt Mốc A (54/54, 0 lỗi JS/HTTP);
    - ảnh khách trùng từng pixel; ảnh Admin chỉ khác ở hàng tạo sổ (đã bỏ ô mật khẩu xóa).
  - Đã cập nhật SPEC, README, CLAUDE.md.
  - Ảnh hưởng khi deploy: tab mở trước khi deploy sẽ được báo tải lại trang khi tick người tham gia, tạo sổ hoặc xóa sổ.
- [x] **GĐ5 → Mốc C – Giao diện mới "Hiện đại, giữ bản sắc"** (2026-11-03; chủ dự án đã chọn). Đặc tả: `plan\phase5-design.md`.
  - Giữ bố cục Summary → Detail → QR → Quản trị → Cấu hình và tông xanh lá/cam.
  - Một stylesheet có token, chế độ tối theo hệ thống. Bỏ `zoom`: chữ thường ≈ 14px (trước ≈ 9,4px), chữ trong bảng ≈ 13px. Hệ số bảng `--table-scale` 0,8 trên desktop, 1 trên điện thoại.
  - Thẻ bo góc, bóng nhẹ; Quản trị và Cấu hình dùng một kiểu thẻ; tiêu đề và cột đầu bảng dính.
  - Hiệu ứng thêm/xóa dòng, thông báo, hộp thoại (tắt khi thiết bị bật giảm chuyển động); khung giữ chỗ khi tải.
  - Nút "±" cho ô Chi phí trên màn hình cảm ứng; giờ hiển thị theo giờ máy người xem; chặn máy tìm kiếm (meta, `X-Robots-Tag`, `robots.txt`).
  - Truy cập: tương phản ≥ 4,5:1 cả sáng lẫn tối, vùng chạm đủ lớn, focus không bị cột dính che, hỗ trợ chế độ tương phản cao của Windows.
  - Review: 3 reviewer, 26 phát hiện. Vòng sửa 1: 22 sửa hết, 3 sửa một phần, 1 để chủ dự án quyết. QA cuối tìm thêm 1 lỗi cao (Summary cắt số tiền 7–8 chữ số), đã sửa ở vòng 2. Còn 6 mục mức thấp: 3 mục đưa vào GĐ6 (P6-0), 3 mục chờ chủ dự án quyết (mục 6).
  - Kiểm tra khi tích hợp:
    - 143/143 test pass ngay trong thư mục `code`;
    - kịch bản API chỉ khác bước 90 (HTML trang); 347 query, 1143 câu lệnh như Mốc B;
    - E2E: 54/54 quan sát giống Mốc B, 0 lỗi JS/HTTP. Khoảng 1/3 số lượt có thêm 1 PUT lưu tạm số tiền đang gõ dở. Nguyên nhân là hàng đợi tự lưu (có từ GĐ4) gửi ngay phần đang chờ khi một lần lưu xong; sẽ sửa ở P6-0d;
    - CSP 0 vi phạm; bộ ảnh 68 ảnh sáng/tối tất định, 0 lỗi;
    - độ trễ gõ phím trên máy chậm 4 lần không đổi (trung vị 32–37ms ở cả hai bản).
  - Thay đổi chủ dự án sẽ thấy:
    - chữ to hơn nên desktop 1400px hiện ≈ 16 cột thành viên (trước ≈ 22);
    - bảng Detail trên desktop cuộn trong khung riêng;
    - ảnh QR hiển thị đúng số px cấu hình (to hơn khoảng 1,5 lần trước);
    - Summary trên desktop dùng chữ 12px.
- [x] **GĐ6 → Mốc D – Tính năng mới** (chủ dự án đã chọn). Đặc tả: `plan\phase6-features.md`. **Đã tích hợp vào `code` ngày 2026-11-04** (216 test).
  - Workflow `wf_f1b0165f-eee` (2026-11-03 14:08 → 2026-11-04 00:44, bị ngắt một lần lúc 17:04 và chạy tiếp lúc 20:05):
    - 2 agent triển khai → 3 reviewer, 42 phát hiện (3 cao, 13 trung bình, 26 thấp);
    - sửa vòng 1: 33 phát hiện đã sửa, 9 phát hiện để chủ dự án quyết hoặc ghi vào tài liệu;
    - QA tìm thêm 2 lỗi trung bình, đã sửa ở vòng 2;
    - orchestrator sửa thêm 3 lỗi thấp QA còn để lại: "±" che phép tính trên điện thoại; thanh lọc để "Sắp xếp" một mình xuống dòng ở 1366px; "Xóa lọc" bật bàn phím điện thoại.
  - Kiểm tra cuối do orchestrator tự chạy:
    - 216/216 test;
    - API chỉ khác bước 90 (HTML trang), 347 query;
    - E2E 3 lần: 54/54 quan sát, 0 lỗi, 62–63 request. Không còn PUT số tiền đang gõ dở (P6-0d); Mốc C có 1–2 PUT như vậy mỗi lần;
    - CSP 0 vi phạm;
    - G3: 504 + 76 kiểm tra trình duyệt;
    - ảnh: 128 ảnh (64 kịch bản × sáng/tối), 2 lần chạy giống hệt từng điểm ảnh.
  - Baseline Mốc D:
    - `scratchpad\checkpoint-d`;
    - `harness\scenario-v2-checkpoint-d.json`, `harness\e2e-checkpoint-d-csp.json`;
    - `harness\visual\shots\checkpoint-d`, `harness\visual\checks-checkpoint-d`.
    
    Bộ ảnh 64 kịch bản nay nằm trong `harness\visual`, script trình duyệt G3 trong `harness\cdp` (`run-g3.sh`).
  - Các mục đã làm (P6-0):
    - điện thoại cuộn cả trang như trước;
    - các ô Cấu hình thẳng hàng trên điện thoại;
    - gợi ý "Vuốt ngang" chỉ hiện khi bảng tràn;
    - tự lưu chờ hết thời gian gõ, không gửi số đang gõ dở.
  1. Tìm, lọc và sắp xếp khoản chi.
  2. Xuất CSV / sao lưu (Detail + Summary, mở được bằng Excel). Từ 2026-11-05 thay bằng file .xlsx 2 sheet.
  3. Hoàn tác khi xóa khoản chi.
  4. Hoàn tác khi chỉnh sửa (ô chi phí, nội dung, người chi, ngày, tick người tham gia).
  5. Xem chi tiết từng thành viên (bấm tên trong Summary).
  6. Tự làm mới dữ liệu khi quay lại tab/ứng dụng.
  7. Nhân bản dòng; ô Chi phí hiểu phép tính đơn giản (120+45, 300/2).
- [x] **GĐ6b – Bộ giao diện** (chủ dự án yêu cầu 2026-11-03: khoảng 4 giao diện, có sáng/tối, đổi tùy thích, theo xu hướng hiện đại, sang trọng). Đặc tả: `plan\phase6b-themes.md`; bảng màu đã kiểm tương phản: `plan\themes\themes.mjs`. **Đã tích hợp vào `code` ngày 2026-11-04** (226 test).
  - Kết quả:
    - nút bảng màu "Đổi giao diện" ở đầu trang mở bảng chọn (popover trên máy tính, bảng trượt từ dưới trên điện thoại);
    - lựa chọn áp dụng trước khi trang hiện (`js/theme-boot.js`), không gọi máy chủ;
    - mỗi màu viết một lần cho cả sáng và tối, nên mọi giao diện theo chế độ của máy kể cả khi tắt JavaScript.
  - Kiểm tra (orchestrator tự chạy):
    - 226/226 test;
    - API chỉ khác bước 90, 347 query;
    - E2E 2 lần giống hệt Mốc D;
    - CSP 0 vi phạm ở cả 4 giao diện × sáng/tối và khi đổi trực tiếp;
    - G3: 580/580;
    - ảnh: 156 ảnh Than chì, 2 lần chạy giống hệt;
    - Rừng xanh ép buộc: 128 ảnh khác Mốc D chỉ ở vùng nút mới trên đầu trang (thấp nhất dòng 140);
    - 704 cặp màu đạt WCAG ở cả 8 tổ hợp;
    - tiêu đề có chân của Ngà & Vàng hiện đủ dấu tiếng Việt.
  - Orchestrator thêm màu dự phòng cho trình duyệt chưa có `color-mix()` (Safari < 16.2, Chrome < 111), để cột cố định, thông báo lỗi và diff không bị trong suốt. Kiểm bằng cách giả lập trình duyệt cũ (`harness\visual\nomix-check.mjs`): 31/31 đạt.
  - `styles.css` nay khoảng 63 KB (ngân sách đặt ban đầu 55 KB). Orchestrator chấp nhận: khi nén chỉ tăng khoảng 2,4 KB, file tĩnh không tốn request Worker; muốn về 55 KB phải bỏ bớt giao diện.
  - Baseline: `scratchpad\checkpoint-6b`, `harness\scenario-v2-checkpoint-6b.json`, `harness\e2e-checkpoint-6b-csp.json`, `harness\visual\shots\checkpoint-6b` (+ `-rung`), `harness\visual\checks-checkpoint-6b`.
  - Trang xem thử bảng màu (bản duyệt trước khi làm): https://claude.ai/artifact/DeNkVjEJsvgL5gG2nof3Zh
  - Bốn giao diện:
    - Than chì: đen trắng tối giản, **là mặc định** (chủ dự án chọn 2026-11-03);
    - Rừng xanh: giao diện GĐ5, giữ nguyên;
    - Ngà & Vàng: quiet luxury, nền ngà, tiêu đề có chân, chi tiết vàng champagne;
    - Navy & Đồng: navy sâu phối đồng thau.
  - Mỗi giao diện có bản sáng và tối, cộng chế độ Tự động.
  - **Mỗi người tự chọn** (chủ dự án chọn): mỗi máy tự nhớ lựa chọn; không có cài đặt chung của Admin, không tốn request hay D1. Màu số dư giữ nghĩa ở mọi giao diện. Mã QR luôn trên nền trắng.
  - Làm từ 2026-11-04 01:16 đến 03:20:
    - một agent triển khai theo `plan\phase6b-brief.md`;
    - orchestrator tự chạy lại mọi kiểm tra và xem ảnh trước khi tích hợp.
- [x] **GĐ7 – Hoàn tất** (2026-11-04).
  - `wrangler.toml`: bật Workers Logs (`[observability] enabled = true`) và đặt `preview_urls = false`. Script deploy vẫn kiểm tra địa chỉ `workers.dev` chính, nên không bị ảnh hưởng.
  - Tài liệu:
    - SPEC §5 bước 3 không còn nói thành viên gửi yêu cầu chuyển khoản "đang chờ" (giao diện đã bỏ từ trước);
    - SPEC §6 thêm Workers Logs và URL preview, §8 thêm `tests/`;
    - README thêm chỗ xem log;
    - CLAUDE.md ghi nâng cấp đã xong.
  - Kiểm thử toàn bộ, chạy trên chính thư mục `code`:
    - 226/226 test;
    - API: 105 bước giống hệt Mốc 6b, 347 query;
    - E2E 2 lần giống hệt Mốc 6b;
    - CSP 0 vi phạm, cả 4 giao diện;
    - G3: 580/580;
    - 156 ảnh giống hệt Mốc 6b từng điểm ảnh;
    - kiểm tra hành vi và giả lập trình duyệt cũ (31/31) đều đạt.
  - Bản chốt của GĐ7: `scratchpad\checkpoint-7`.
- [x] **Bổ sung – Xóa điểm khôi phục** (chủ dự án yêu cầu 2026-11-04: "xóa điểm khôi phục, dùng chung pass khôi phục"). Đã tích hợp cùng ngày (227 test).
  - Nút × cạnh "Khôi phục" ở mỗi điểm lưu. Luôn hỏi mật khẩu thao tác, như xóa sổ, kể cả khi phiên đã xác thực cho Store.
  - Chỉ xóa đúng điểm đó; dữ liệu sổ không đổi; ghi một dòng `delete`/`history_point` vào `audit_log`.
  - API mới `DELETE /api/admin/history-points/:id`, 3 query D1. Dùng chung giới hạn số lần nhập mật khẩu thao tác.
  - Sửa kèm một race có sẵn trong hộp thoại dùng chung (`ui.js`): sự kiện `close` của hộp thoại trước đến muộn có thể làm hộp thoại vừa mở lại trả về Hủy (gặp khi bấm Esc rồi mở lại ngay). Ảnh hưởng mọi hộp thoại, không riêng tính năng này.
  - Kiểm tra:
    - 227/227 test;
    - API, E2E và CSP giống hệt Mốc 6b;
    - G3: 580 + 20 kiểm tra mới (`harness\cdp\g3-delete-point.mjs`, máy tính và điện thoại);
    - ảnh: chỉ vùng nút của danh sách điểm lưu đổi; ở cỡ chữ 200%, cụm nút xuống dòng dưới.
  - Bản chốt: `scratchpad\checkpoint-8`, baseline `*-checkpoint-8*`.
- [x] **Sửa lỗi – Cỡ chữ nhỏ không áp dụng cho ô nhập trên điện thoại** (chủ dự án báo 2026-11-05). Tích hợp cùng ngày (230 test).
  - Nguyên nhân: trên điện thoại, ô nhập có cỡ tối thiểu 16px (để iPhone không tự phóng to), nên khi chọn cỡ chữ dưới 90%, các ô của bảng Detail vẫn 16px.
  - Sửa:
    - ô nhập 16px ở mức 90% trở lên, nhỏ dần theo tỉ lệ khi chọn nhỏ hơn (75% → 13,3px), nên giao diện mặc định không đổi;
    - `js/viewport.js` thêm `maximum-scale=1` chỉ trên iPhone/iPad để Safari không tự phóng to.
  - Kiểm tra:
    - 230/230 test;
    - E2E, CSP, G3 (thêm `g3-font-scale.mjs`, 53 kiểm tra) đều đạt;
    - 156 ảnh giống hệt Mốc 8.
  - Bản chốt: `scratchpad\checkpoint-9`, baseline `*-checkpoint-9*`.
- [x] **Bổ sung 2026-11-05 – Summary trong diff phiên, hoàn tác Summary, xuất Excel** (chủ dự án yêu cầu). Tích hợp cùng ngày (244 test).
  1. Diff phiên nhật ký có thêm hai bảng Summary trước/sau, gồm cả chuyển khoản (chủ dự án chọn).
     - Ảnh chụp phiên có thêm `transfers`: tổng chuyển khoản từng người, đọc trong cùng lô nên không thêm query.
     - `PUT /api/admin/payments/total` (ô "Đã chuyển khoản", nút Done) nay được ghi vào phiên: từ 3 lên 6 query mỗi lần, lưu lại cùng tổng thì 5.
     - Phiên cũ không có `transfers`: dùng tổng của phía còn lại, hoặc tổng hiện tại, kèm ghi chú.
  2. Hoàn tác/làm lại cho "Đã chuyển khoản" và Done: chung lịch sử với Detail (nút Hoàn tác/Làm lại, Ctrl+Z / Ctrl+Y); bị từ chối nếu trang đã thấy tổng đổi từ nơi khác.
  3. Xuất Excel (chủ dự án chọn .xlsx 2 sheet, thay CSV):
     - sheet "Detail" và sheet "Summary" bố trí như trên web, kèm hàng "Nhóm";
     - tạo ngay trên trình duyệt (`js/xlsx.js`, không thư viện);
     - đã đọc lại bằng openpyxl và LibreOffice; chưa mở thử bằng Microsoft Excel thật.
  - Kiểm tra:
    - 244/244 test;
    - API: chỉ khác bước 67 (thêm `transfers`) và 90 (HTML trang); 347 → 356 query;
    - E2E: chỉ khác tiêu đề và ô tô màu của dialog diff;
    - CSP sạch;
    - G3: 15 script, thêm `g3-xlsx` (66) và `g3-summary-history` (16);
    - ảnh: chỉ đổi cụm nút tiêu đề Detail ("Xuất Excel"), dialog diff và thông báo xuất file.
  - Bản chốt: `scratchpad\checkpoint-10`, baseline `*-checkpoint-10*`.
- [x] **Bổ sung 2026-11-05 – Chuyển "Cấu hình" xuống dưới Detail, giao diện mặc định Ngà & Vàng – Sáng** (chủ dự án yêu cầu). Tích hợp cùng ngày (244 test).
  1. Thứ tự trang: tổng quan, Summary, Detail, **Cấu hình**, QR, khu Admin. Chỉ dời khối HTML, không đổi CSS hay chức năng.
  2. Máy chưa từng chọn giao diện thấy **Ngà & Vàng, Sáng** (chủ dự án chọn "mọi người xem", không chỉ Admin).
     - Áp dụng cả khi thiết bị đang ở chế độ tối, khi bộ nhớ trình duyệt bị chặn, khi giá trị lưu không hợp lệ và khi tắt JavaScript.
     - Ai đã chọn giao diện trên máy mình thì vẫn giữ lựa chọn đó.
     - `DEFAULT_THEME` trong `js/theme.js`, `theme-boot.js` và thuộc tính tĩnh `<html data-skin="nga" data-mode="light">` trong `index.html` phải khớp nhau (test `frontend-theme` kiểm tra).
  - Kiểm tra:
    - 244/244 test;
    - API: chỉ khác bước 90 (HTML trang); 356 query như Mốc 10;
    - E2E giống hệt, 0 lỗi; CSP sạch; G3 15 script đều đạt;
    - kiểm tra giao diện (theme-check) đã đổi sang mặc định mới, đều đạt;
    - touch target chỉ đổi thứ tự dòng;
    - contrast và độ vừa Summary giống Mốc 10;
    - ảnh: 106 ảnh khác và 34 ảnh đổi kích thước, đúng dự kiến (đổi giao diện mặc định, dời Cấu hình). Ảnh "dark" của các kịch bản mặc định nay là giao diện sáng, vì mặc định ép Sáng.
  - Bản chốt: `scratchpad\checkpoint-11` (= `code`), baseline `*-checkpoint-11*`.
  - **Chưa deploy.** Khi chủ dự án muốn đưa lên server, chạy `scripts\push_to_server.bat`.
    - Lần deploy đó sẽ áp dụng migration mới `0013_cheaper_audit_log_retention.sql` (thêm ở GĐ2) lên D1 remote.
    - Các sổ khác sổ mặc định được nâng cấp schema dần, ở lần đầu mở sau deploy.
    - Nên Store từng sổ trên trang hiện tại trước khi deploy, để có điểm khôi phục. Nút "Xuất Excel" chỉ có sau khi deploy bản mới.
    - Mật khẩu thao tác (`HISTORY_RESTORE_PASSWORD`) phải được đặt bằng `scripts\change_pass.bat` trước; script deploy sẽ dừng nếu thiếu.

## 4. Kết quả review chính (đã kiểm chứng)

**Chi phí D1 (nghiêm trọng nhất).** Mỗi lần autosave tốn khoảng 5.600–8.700 rows read. Nguyên nhân: trigger `audit_log_keep_latest_999` quét khoảng 2.000 dòng mỗi lần ghi nhật ký, cộng `COUNT(*)`/`NOT IN` trên `audit_sessions`. Quota 5 triệu rows/ngày vì vậy chỉ đủ khoảng 575–885 lần lưu cho toàn bộ các sổ. Sau khi sửa còn khoảng 650 rows. Mỗi lần lưu dùng 18–19 query, sẽ giảm còn khoảng 4–6.

**Bảo mật.**
- `GET /api/admin/audit/<id>` thiếu kiểm tra Admin.
- Có thể gọi quản lý sổ qua `/api/g/<slug>/admin/ledgers`, làm hỏng index/trigger của sổ khác.
- Số lần đoán mật khẩu được nhân lên theo số sổ.
- Request bị từ chối vẫn đọc toàn bộ bảng.
- Giới hạn 100 KB của body bị vượt được.
- Chưa có security headers.

**Race và độ tin cậy.**
- Tổng chuyển khoản bị cộng delta 2 lần khi có request đồng thời.
- Vị trí trùng và vượt giới hạn 50 thành viên.
- Ghi dữ liệu thành công nhưng vẫn trả 500.
- Tạo sổ không nguyên tử, có thể để lại sổ "mồ côi".

**Frontend.**
- Tick người tham gia từ điện thoại khác bị ghi đè.
- Lưu tổng chuyển khoản dở dang (ví dụ 50đ thay vì 50.000đ).
- Trên Safari, nhấn Esc ở hộp thoại bị coi là xác nhận.
- Chữ vừa gõ biến mất khi bấm "+ Add line".
- Trạng thái "Có thay đổi chưa lưu…" bị kẹt.
- Danh sách nhật ký không tải sau khi đăng nhập.
- Không nhập được dấu trừ trong ô chuyển khoản.

**Test.** 24 test cũ không chạy câu SQL nào: 6/6 lỗi SQL cố ý cài vào đều lọt qua. Đã bổ sung integration test với SQLite thật.

## 5. GĐ3 – Mô hình mật khẩu mới (theo yêu cầu chủ dự án)

- **Mật khẩu Admin:** chỉ dùng để đăng nhập (`ADMIN_USERNAME`/`ADMIN_PASSWORD`).
- **Mật khẩu thao tác dùng chung** (secret `HISTORY_RESTORE_PASSWORD`, giữ tên cũ để không phải cấu hình lại): dùng cho tạo sổ, xóa sổ, Store điểm khôi phục, khôi phục và xóa điểm khôi phục (bổ sung 2026-11-04). Đặt bằng `scripts\change_pass.bat`.
  - Tạo sổ và Store: hỏi một lần cho mỗi phiên đăng nhập Admin, dùng chung cho mọi sổ trong phiên. Chủ dự án đã chọn cách này.
  - Xóa sổ, Khôi phục và Xóa điểm khôi phục: luôn hỏi lại, vì đây là thao tác phá hủy.
  - Form tạo sổ bỏ ô "Mật khẩu xóa" riêng. Các sổ cũ đã có mật khẩu xóa riêng chuyển sang dùng mật khẩu thao tác.
- `change_pass`: hai mật khẩu không bị giới hạn độ dài hoặc khoảng trắng ở đầu/cuối, nhưng phải khác nhau và không được để trống.

## 6. Đề xuất cần chủ dự án quyết định (chưa làm)

- Giới hạn số khoản chi mỗi sổ (ví dụ 1.000). Mục đích: tránh chạm giới hạn 10 ms CPU và 2 MB/giá trị.
- Cache `/api/state` để chống spam đọc. Rủi ro: dữ liệu hiển thị có thể cũ vài giây.
- Nén snapshot nhật ký/điểm lưu. Lợi ích: sổ rất lớn không làm đầy 500 MB của D1.
- Link sổ có hậu tố ngẫu nhiên, để không đoán được link từ tên sổ.
- Khôi phục điểm lưu có khôi phục cả nhóm thành viên hay không (hiện tại: giữ nhóm hiện có).
- `preview_urls = false` trong `wrangler.toml`, để các phiên bản cũ không còn truy cập được qua URL preview. Đã đưa vào GĐ7.
- Ô "Số tiền/Ng" đang làm tròn tới nghìn, trong khi SPEC §4.3 nói có thể có phần thập phân. Đồng dư đang chia theo thứ tự hiển thị, nên khi tạo nhóm có thể dịch 1đ sang người khác. Cần quyết định: theo SPEC, hay sửa SPEC cho khớp code.
- Hỏi xác nhận trước khi đóng tab nếu còn thay đổi chưa lưu (`beforeunload`).
- Thứ tự lưu khi đóng tab lúc một lần lưu đang chạy dở: lần gửi sau có thể bị lần gửi trước ghi đè. Bản gốc cũng mắc lỗi này, nên đây không phải hồi quy. Muốn sửa cần cơ chế phiên bản dòng hoặc số thứ tự ở backend.
- Tự tải lại trang khi có phiên bản mới, thông qua header phiên bản của Worker.
- Từ GĐ3, request xóa sổ không kèm mật khẩu không còn bị giới hạn số lần riêng. Mỗi request như vậy cần phiên Admin và chỉ tốn 1 lượt đọc D1. Thêm lại giới hạn riêng nếu muốn.
- Khi console Windows dùng code page 65001 (UTF-8), secret gửi qua `change_pass` bị thêm ký tự BOM ở đầu, kể cả mật khẩu chỉ gồm ký tự ASCII. Đây là hành vi sẵn có của .NET, có cả trước GĐ3. Mật khẩu hiện tại vẫn đăng nhập được, nên nhiều khả năng console của chủ dự án không dùng code page này. Có thể sửa bằng `[Console]::InputEncoding`, nhưng cần chủ dự án thử trên máy thật.

- Giao diện mới (GĐ5):
  - Bảng Detail trên điện thoại: GĐ6 cho cuộn cả trang như trước (P6-0a), khung cuộn riêng với tiêu đề dính chỉ còn trên desktop. Có thể đổi lại nếu muốn tiêu đề dính cả trên điện thoại.
  - Ảnh QR giữ đúng số px đã cấu hình (hiện tại), hay thu nhỏ như trước. Có thể chỉnh trong Cấu hình.
  - Chữ gợi ý "Chọn người" và "mm/dd/yyyy" ở dòng nháp bị cắt với độ rộng cột mặc định: tăng độ rộng mặc định hoặc rút gọn chữ.
  - Summary trên desktop: chữ 12px ở hệ số 0,8 (hiện tại), hay hệ số 1 với chữ 13px và bảng rộng hơn.
  - Khung giữ chỗ khi tải vẫn làm trang dịch nhẹ với Admin, sổ trống và sổ dài.

- Tính năng mới (GĐ6):
  - **Hoàn tác có thể ghi đè thay đổi từ máy khác mà trang chưa tải về.** Nút Hoàn tác vẫn báo thành công, kèm giá trị cũ sai. Sửa triệt để: dùng PUT có điều kiện ở worker. Trang gửi kèm giá trị mong đợi; nếu dữ liệu đã đổi, máy chủ trả 409 "Không thể hoàn tác vì dữ liệu đã thay đổi." Cách này không tốn thêm query D1, vì worker vẫn đọc dòng đó. Đề xuất làm ở GĐ7 nếu chủ dự án đồng ý. Hiện giới hạn này đã ghi trong SPEC và README.
  - Trên màn hình cảm ứng, cả trang cuộn (P6-0a). Với sổ rất dài (khoảng 1.000 dòng), việc vẽ trang tốn hơn khi dùng khung cuộn riêng.
  - Bộ lọc/sắp xếp áp dụng lại khi rời bảng, không phải khi rời từng dòng, để dòng vừa chuyển tới không nhảy chỗ.
  - Chia cho 0 trong ô Chi phí có thông báo riêng "Không thể chia cho 0.".
  - Trên điện thoại 360–375px, thông báo (toast) che các nút ở tiêu đề Detail.
  - Đổi tiêu đề cột "Xóa" thành "Thao tác" (hiện trình đọc màn hình đọc là "Xóa hoặc nhân bản"); độ rộng tối thiểu của cột này.
  - Giới hạn đã ghi trong SPEC:
    - rời trang ngay khi bản sao đang được tạo thì còn lại một dòng trống;
    - xóa rồi tải lại trang ngay có thể vẫn thấy dòng đó.
  - File Excel chưa có hàng "Admin đã hoàn" (bảng Summary trên web cũng không hiện; Số dư đã tính khoản này). Sheet Summary có thêm hàng "Nhóm" mà trang web không có; có thể bỏ nếu không cần.
  - Hộp Chi tiết thành viên: ngày khoản chi theo định dạng của trình duyệt, ngày chuyển khoản theo dấu thời gian (giống nhật ký).
  - Số trên nút "Lọc & sắp xếp" đếm cả khi đang dùng cách sắp xếp khác mặc định.

- Bộ giao diện (GĐ6b):
  - Ngà & Vàng và Navy & Đồng viết hoa nhãn ô tổng quan và tiêu đề cột Detail (nét riêng theo bản xem thử). Có thể bỏ nếu thấy khó đọc.
  - Ngà & Vàng sáng: ảnh QR có nền trắng riêng, nên thành ô vuông trắng trên nền ngà. Có thể thêm viền trắng như chế độ tối cho đồng bộ.
  - Bảng chọn không dùng hiệu ứng kính mờ (tùy chọn trong đặc tả), để giữ dung lượng CSS.

## 7. Nếu phiên làm việc bị ngắt: cách tiếp tục

1. Đọc file này. Các mục `[x]` đã nằm trong thư mục `code`.
2. Nếu có giai đoạn đang chạy dở, thư mục làm việc của nó có thể vẫn còn trong scratchpad của phiên cũ (mục 2). Đối chiếu bằng `git diff --no-index` với bản sao lưu, chạy lại test rồi mới tích hợp. Nếu không chắc chắn thì làm lại giai đoạn đó theo đặc tả trong `refactor-workspace\plan`.
3. Sau khi tích hợp một giai đoạn, chạy toàn bộ kiểm tra:
   - `node --test`;
   - harness: `refactor-workspace\harness`, xem `plan\common.md`.
   
   Sau đó đánh dấu `[x]` vào mục tương ứng và ghi ngày.
