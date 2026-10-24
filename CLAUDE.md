# CLAUDE.md — Lõi (giữ <150 dòng để tiết kiệm token mỗi session)

> File này nạp vào MỌI session. Chỉ để quy tắc bất biến ở đây.
> Chi tiết theo miền để trong `.claude/skills/` — Claude chỉ nạp khi task liên quan.

## Dự án
- Hệ thống tích hợp **SAP Business One 10.0 HANA** qua **Service Layer (OData v4)**.
- Stack repo: **Next.js (App Router) + TypeScript + Prisma (SQLite) + shadcn/ui**, test bằng **Vitest**. Frontend chỉ gọi API route nội bộ (`src/app/api`), không gọi B1 trực tiếp.
- B1 client dùng chung: `src/lib/sap-service-layer.ts`; cấu hình kết nối B1 lưu mã hoá trong DB (`src/lib/fm-crypto.ts`), không qua `.env`.
- Ngôn ngữ trao đổi & comment UI: **tiếng Việt**. Code, tên biến, commit: tiếng Anh.

## Quy tắc làm việc (token-efficient)
1. **Đọc trước, đọc hẹp:** `grep`/glob tìm đúng chỗ → đọc đoạn cần thiết. Không đọc cả file/repo khi không cần.
2. **Plan trước khi sửa lớn:** task >3 file hoặc đụng schema/API B1 → trình plan ngắn, chờ duyệt, rồi mới code.
3. **Diff nhỏ, đúng scope:** không refactor ngoài yêu cầu, không đổi format toàn file.
4. **Trả lời gọn:** kết luận → thay đổi → cách kiểm chứng. Không lặp lại nội dung file đã có.
5. **Tái dùng skill:** frontend → `/frontend-design`, backend → `/backend-api`, B1 → `/sap-b1-service-layer`, rà soát → `/security`.
6. **Subagent cho việc khám phá:** giao Explore/subagent khi cần quét rộng; chỉ mang kết luận về context chính.
7. Dừng và hỏi khi: thiếu CompanyDB/entity đích, hành động ghi/xóa dữ liệu thật, mâu thuẫn yêu cầu.
8. **Nén ngữ cảnh khi còn ~20%:** auto-compact bật ở ngưỡng 80% (`.claude/settings.json` → `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80`). Trước mốc đó, chủ động chốt việc đang dở (commit/ghi chú trạng thái) để bản tóm tắt giữ đủ: task đang làm, file đã sửa, việc còn lại.

## Bảo mật — BẤT BIẾN
- **Không bao giờ** ghi password, API key, cookie `B1SESSION`, token vào code, commit, log, CLAUDE.md hay file này.
- Bí mật chỉ qua biến môi trường / secret manager — xem `.env.example` (không có giá trị thật).
- Không đọc, không in, không commit: `.env*` (trừ `.env.example`), `*.pem`, `*.key`, `id_rsa*`, thư mục secrets.
- Tài khoản B1: dùng **service account riêng, quyền tối thiểu** theo CompanyDB; không dùng `manager`.
- Ghi thật lên SAP (POST/PATCH/DELETE, `$batch`, Close/Cancel) → **xác nhận DB đích + payload trước khi chạy**.
- Không ghi thẳng SQL vào HANA cho nghiệp vụ ghi. Ghi chỉ qua Service Layer/DI API. SQL HANA chỉ đọc, tham số hoá.
- Log che (mask) password/token/cookie/số thẻ; không log nguyên payload chứa dữ liệu cá nhân.
- Kiểm TLS: production giữ `verify SSL = true`; chỉ tắt khi dev nội bộ và ghi rõ lý do.

## Quy tắc SAP B1 — tóm tắt (chi tiết: skill `sap-b1-service-layer`)
- Base: `https://<host>:50000/b1s/v2` · Login `POST /Login {CompanyDB,UserName,Password}` → cookie `B1SESSION`+`ROUTEID`.
- `401` → login lại **1 lần** rồi retry. Dùng session pool theo CompanyDB, không login mỗi request.
- Update = **PATCH** (chỉ field thay đổi), không PUT. Đọc trước khi ghi (GET/`$metadata` xác nhận field bắt buộc, UDF).
- Query luôn `$select` hẹp + `$top/$skip` phân trang. Không `$select=*` ngầm, không tải toàn bộ bảng.
- Khoá: `BusinessPartners=CardCode`, `Items=ItemCode`. UDF = `U_<Name>` — không tự bịa tên UDF.
- Lỗi trùng khoá `-10 / 1320000140` → xử lý như "đã tồn tại", chuyển sang PATCH nếu là upsert.

## Chuẩn code chung
- Tách lớp: UI → API nội bộ → Service/Handler → B1 Client. Frontend **không** chứa credential B1.
- Mọi call B1 qua **một client duy nhất**: timeout, retry có giới hạn (chỉ lỗi mạng/401/5xx), idempotency cho POST tạo chứng từ.
- Validate ở cả client (UX) và server (bắt buộc). Map lỗi B1 → thông điệp tiếng Việt thân thiện, giữ mã lỗi gốc để tra cứu.
- Test trước khi báo xong. Không commit/push khi chưa có lệnh rõ.

## Lệnh thường dùng
```bash
npm run dev        # dev server
npm run build      # prisma generate + next build (standalone)
npm test           # vitest run
npm run lint       # eslint .
npm run db:generate | npm run db:migrate   # Prisma (KHÔNG chạy db:push/db:reset khi chưa xác nhận — mất dữ liệu)
```

## Không làm
- Không tự tạo entity/field/UDF B1 không có trong `$metadata`.
- Không xoá master data hàng loạt, không chạy `$batch` lớn chưa duyệt.
- Không cài package/skill bên thứ ba hàng loạt chưa duyệt danh sách.
