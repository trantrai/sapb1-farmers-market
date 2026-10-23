---
name: security
description: Rà soát & áp dụng bảo mật — secret/credential, auth, quyền truy cập, injection, log, dependency, cấu hình deploy. Dùng khi rà soát code, trước khi merge/deploy, hoặc khi task đụng dữ liệu nhạy cảm.
---

# Security Checklist

## Secret & Credential
- Secret chỉ trong env/secret manager. Repo chỉ có `.env.example` không giá trị thật. Kiểm tra trước commit: `git diff` không chứa password/key/token/cookie/connection string thật.
- Không in secret ra log, lỗi, ảnh chụp, hay câu trả lời chat. Mask: chỉ hiện 2 ký tự cuối khi buộc phải đối chiếu.
- Tài khoản B1: service account riêng cho tích hợp, quyền tối thiểu theo việc (không `manager`, không superuser HANA). Đổi mật khẩu định kỳ; lộ → rotate ngay và rà log.
- Khoá/secret của bên thứ ba để riêng từng môi trường (dev ≠ prod), không dùng chung.

## Truy cập & Mạng
- Service Layer: HTTPS, production giữ verify chứng chỉ. Không expose port 50000 ra internet; tích hợp qua VPN/LAN/reverse proxy có auth.
- CORS: chỉ origin đã biết. Rate limit + timeout ở API nội bộ. Endpoint webhook (nếu có): bắt buộc chữ ký/HMAC hoặc token riêng + kiểm tra nguồn.
- Nguyên tắc quyền tối thiểu ở mọi lớp: DB user chỉ đọc khi chỉ cần đọc; thư mục/file cấu hình giới hạn quyền truy cập OS.

## Code
- Chống injection: tham số hoá SQL/OData filter (escape `'` trong literal OData), không nối chuỗi input vào query/URL/command.
- Validate + sanitize mọi input từ client/webhook/file import (kiểu, độ dài, whitelist enum).
- XSS: escape output mặc định của framework, không `dangerouslySetInnerHTML`/raw HTML với dữ liệu người dùng chưa sanitize.
- Upload file: kiểm tra extension + MIME + kích thước, lưu ngoài web root, tên file sinh ngẫu nhiên.
- Dependency: khoá version (lockfile), rà `npm audit`/`dotnet list package --vulnerable` trước release, không cài package lạ chưa duyệt.

## Dữ liệu & Log
- Dữ liệu cá nhân/tài chính: chỉ thu thập & log mức cần thiết; mask số tài khoản/thẻ; mã hoá khi lưu credential B1 ở DB nội bộ (AES-GCM hoặc tương đương, khoá tách riêng).
- Audit log cho thao tác ghi lên B1: ai, khi nào, entity, khoá, trước/sau rút gọn, kết quả — không kèm password/cookie.
- Backup cấu hình & DB nội bộ có mã hoá, kiểm tra khôi phục định kỳ.

## Quy trình
- Mọi thao tác phá huỷ/hàng loạt cần xác nhận rõ đích đến (môi trường, CompanyDB) trước khi chạy.
- Trước merge/deploy: chạy `/review`, kiểm tra diff secret, test auth (401/403), test 1 luồng ghi B1 ở môi trường test trước prod.
- Sự cố nghi lộ secret: dừng tích hợp → rotate credential → rà log truy cập → mới khôi phục.
