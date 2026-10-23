---
name: backend-api
description: Thiết kế & code backend/API (REST, auth, validate, logging, transaction, đồng bộ dữ liệu) — khi tạo/sửa endpoint, service, middleware, job nền, hoặc tầng truy cập dữ liệu.
---

# Backend API

## Kiến trúc
- Lớp: `Controller/Route → Service (nghiệp vụ) → Repository/Client (dữ liệu/B1)`. Controller mỏng, không chứa logic nghiệp vụ.
- Mọi call ra SAP B1 đi qua **một B1 client dùng chung** (skill `sap-b1-service-layer`). Không rải HttpClient khắp nơi.
- Config qua env, không hardcode host/CompanyDB/credential. Một nơi đọc config duy nhất, fail-fast khi thiếu biến bắt buộc.

## Thiết kế API
- REST nhất quán: danh từ số nhiều, version `/api/v1/...`, status code đúng nghĩa (201 tạo, 400 validate, 401/403 auth, 404, 409 trùng/xung đột, 502 khi B1 lỗi phía upstream).
- Response lỗi chuẩn 1 format: `{ code, message (tiếng Việt), detail?, traceId }`. Không trả stack trace ra ngoài.
- Phân trang `?page=&pageSize=` (mặc định 20, tối đa 100), lọc/sort qua tham số rõ tên.
- POST tạo chứng từ/tài nguyên quan trọng: hỗ trợ **idempotency key** (header `Idempotency-Key` hoặc khoá ngoài lưu DB) để retry không tạo trùng.

## Auth & phân quyền
- AuthN: JWT/session theo chuẩn repo; mật khẩu băm mạnh (bcrypt/argon2/PBKDF2), không tự chế thuật toán.
- AuthZ theo vai trò (RBAC) kiểm ở server cho mọi endpoint ghi. Không tin quyền chỉ ẩn ở UI.
- Mọi input đều validate ở server: kiểu, độ dài, khoảng giá trị, enum. Tham số hoá 100% câu SQL — không nối chuỗi.

## Độ tin cậy
- Timeout cho mọi call ra ngoài; retry giới hạn (tối đa 2–3 lần, backoff) chỉ cho lỗi mạng/5xx/401-B1, không retry lỗi 400 nghiệp vụ.
- Ghi dữ liệu nhiều bước: transaction ở DB nội bộ; với B1 dùng `$batch` changeset khi cần nguyên tử (xem skill B1).
- Job đồng bộ nền: có watermark/tiến độ, chạy lại an toàn (idempotent), ghi log kết quả từng đợt, không giữ credential trong log.
- Health endpoint `/health` không lộ thông tin nội bộ (không version DB, không connection string).

## Logging & quan sát
- Log có cấu trúc (JSON hoặc key=value), kèm `traceId` xuyên suốt request → B1 call.
- **Mask** password/token/cookie/card. Không log nguyên body request chứa dữ liệu nhạy cảm.
- Phân biệt rõ trong log: lỗi validate (400) / lỗi B1 (kèm mã B1) / lỗi hạ tầng.

## Kiểm tra trước khi giao
- [ ] Validate + RBAC ở server · [ ] Không SQL nối chuỗi · [ ] Timeout/retry đúng chỗ
- [ ] Lỗi trả format chuẩn · [ ] Test: happy path + 400 + 401/403 + B1 lỗi · [ ] Không secret trong log/code
