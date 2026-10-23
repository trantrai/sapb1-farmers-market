---
description: Kiểm tra kết nối SAP B1 Service Layer — chỉ đọc, an toàn
argument-hint: [entity tuỳ chọn, vd Items]
---

Kiểm tra tích hợp B1 (CHỈ ĐỌC, không ghi dữ liệu):
1. Đọc cấu hình kết nối B1 của app (lưu mã hoá trong DB, xem `src/lib/sap-service-layer.ts` / `src/lib/fm-crypto.ts`) — chỉ báo có/thiếu, không in giá trị secret: base URL, CompanyDB, user.
2. Thử Login → báo trạng thái + thời gian đáp ứng, sau đó Logout. Không in cookie/session.
3. GET `$metadata` rút gọn: xác nhận entity `$ARGUMENTS` (mặc định `Items`) tồn tại, liệt kê field bắt buộc + UDF của nó.
4. GET 1 bản ghi mẫu của entity đó với `$top=1` + `$select` hẹp để xác nhận quyền đọc.
Báo kết quả dạng bảng ngắn: bước / trạng thái / ghi chú. Lỗi thì kèm mã lỗi B1 gốc và hướng khắc phục.
