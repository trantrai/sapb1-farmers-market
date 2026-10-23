---
name: sap-b1-service-layer
description: Tích hợp SAP Business One 10.0 HANA qua Service Layer OData v4 — login/session, CRUD master data & chứng từ, query $filter/$select, $batch, UDF, copy-from, Close/Cancel, đồng bộ delta, xử lý lỗi B1. Dùng cho MỌI task đụng SAP B1.
---

# SAP B1 HANA — Service Layer

Base URL: `https://<host>:50000/b1s/v2` (v2; một số bản dùng `/b1s/v1`). Mọi ghi nghiệp vụ qua đây hoặc DI API — **không ghi SQL HANA trực tiếp**.

## 1. Session
```http
POST /b1s/v2/Login
{"CompanyDB":"<DB>","UserName":"<user>","Password":"<pass>"}
→ 200, Set-Cookie: B1SESSION=<...>; ROUTEID=<...>   (SessionId trong body)
POST /b1s/v2/Logout   (khi đóng pool)
```
- Giữ cookie **cả B1SESSION + ROUTEID** (thiếu ROUTEID dễ rớt node cân bằng tải).
- Pool session theo `CompanyDB+UserName`, tái dùng; `401` → login lại **1 lần** → retry request gốc **1 lần**, vẫn 401 thì báo lỗi, không vòng lặp.
- Session timeout mặc định ~30 phút không dùng; job dài hạn kiểm tra session trước mỗi đợt.
- Credential chỉ từ env/secret manager. Tuyệt đối không log cookie/password.

## 2. CRUD & địa chỉ entity
- Đọc 1: `GET /Items('A00001')` · `GET /BusinessPartners('C20000')` · chứng từ số: `GET /Orders(123)` (DocEntry).
- Tạo: `POST /Items` → 201. Sửa: **`PATCH /Items('A00001')`** chỉ gửi field đổi. Xoá: `DELETE` — cần xác nhận, master data thường chỉ nên set `Frozen`/`Valid` thay vì xoá.
- Khoá chính: Items=`ItemCode`, BusinessPartners=`CardCode`, Warehouses=`WarehouseCode`, PriceLists=`PriceList` (số), chứng từ=`DocEntry`.
- Hành động: `POST /Orders(123)/Close`, `POST /Orders(123)/Cancel` (tương tự Invoices, DeliveryNotes...). Kiểm tra trạng thái chứng từ trước khi gọi.

## 3. Query OData — luôn hẹp để nhanh & rẻ
```
GET /Items?$select=ItemCode,ItemName,OnHand&$top=20&$skip=0&$orderby=ItemCode
GET /BusinessPartners?$filter=CardType eq 'cCustomer' and Frozen eq 'tNO'
GET /Orders?$filter=DocDate ge '2026-01-01' and DocDate le '2026-01-31'
```
- Luôn có `$select` (chỉ field dùng) + `$top/$skip` khi lấy danh sách. Đếm: `/$count` hoặc `$count=true` tuỳ bản.
- Ngày: chuỗi `'yyyy-MM-dd'`. **TimeOfDay** (vd `UpdateTime`): so với chuỗi `'HH:MM:SS'` — *không* dùng số trần, *không* dùng duration literal.
- Enum nhận tên hoặc giá trị: `"CardType":"cCustomer"` ≡ `"C"`, `Frozen: "tNO"`.
- Lọc con: `$expand=DocumentLines` khi cần, nhưng ưu tiên lấy header rồi lấy dòng riêng nếu danh sách lớn.

## 4. Chứng từ (Documents)
```json
POST /Orders
{ "CardCode":"C20000", "DocDueDate":"2026-10-30", "Comments":"...",
  "DocumentLines":[ {"ItemCode":"A00001","Quantity":2,"UnitPrice":150000,"WarehouseCode":"01"} ] }
```
- Field tạo đơn tối thiểu thường gặp: `CardCode`, `DocumentLines[].ItemCode/Quantity`. Giá/ thuế để B1 tự tính khi không có yêu cầu ghi đè.
- **Copy-from:** set ở từng dòng `BaseType` (vd 23=Quotation, 17=Order, 15=Delivery), `BaseEntry` (DocEntry nguồn), `BaseLine` (LineNum nguồn). Nguồn chưa sync/không tồn tại trên B1 → chặn, không gửi.
- Đặt cọc: `DownPayments` / liên kết qua `DocumentLines` & chứng từ `DownPayments` — kiểm tra `$metadata` của bản cài cụ thể trước khi code.
- Sau POST thành công: lưu `DocEntry` + `DocNum` về hệ thống ngoài ngay, kèm khoá ngoài để đối soát.

## 5. $batch
- `POST /$batch`, `multipart/mixed`: gom nhiều GET trong 1 batch; gom ghi trong **changeset** = nguyên tử (lỗi 1 → rollback cả changeset).
- Dùng cho: tạo chứng từ nhiều phần liên quan, upsert hàng loạt nhỏ. Batch lớn → chia đợt ≤100 request, có xác nhận trước.

## 6. UDF / UDT
- UDF header: `U_<Name>` trong payload, vd `"U_ExternalID":"EXT-001"`. Dòng chứng từ: UDF nằm trong `DocumentLines[]`.
- **Không tự bịa tên UDF**: GET 1 bản ghi mẫu hoặc đọc `$metadata` trước. UDT: truy cập qua entity `U_<TableName>` (theo cấu hình bản cài).

## 7. Đồng bộ & Upsert (playbook)
- **Upsert theo khoá ngoài:** lưu khoá hệ ngoài vào UDF (`U_ExternalID`). Tìm: `$filter=U_ExternalID eq '<id>'` → có: PATCH, chưa: POST.
- **Delta sync:** watermark theo `UpdateDate + UpdateTime` (lưu mốc lần chạy trước theo từng CompanyDB + entity). Lần đầu full load, định kỳ chạy full lại vì B1 không phát hiện được bản ghi đã xoá qua delta.
- **Idempotent inbound:** cùng 1 payload gửi lại không tạo trùng — kiểm tra khoá ngoài/DocEntry đã lưu trước khi POST.
- Xung đột đồng thời: dùng `If-Match` với ETag khi entity hỗ trợ; xung đột → đọc lại bản mới nhất rồi mới quyết định ghi đè.

## 8. Lỗi thường gặp
| Mã / Dấu hiệu | Nghĩa | Xử lý |
|---|---|---|
| `401` | Session hết hạn | Re-login 1 lần + retry 1 lần |
| `-10`, `1320000140 ... already assigned` | Trùng khoá khi POST | Upsert → chuyển PATCH |
| `400` + `code -1005/-1029`… | Thiếu field bắt buộc / sai giá trị | Đọc message gốc, đối chiếu `$metadata`, sửa payload — không retry mù |
| `-1116` / lỗi kho | Item không quản lý ở kho đã chọn | Kiểm tra warehouse/item setup trước khi gửi |
| `500` từ Service Layer | Lỗi phía B1 | Retry giới hạn + log mã gốc + traceId |

Giữ nguyên `error.code` + `error.message.value` của B1 trong log nội bộ; hiển thị người dùng bản tiếng Việt rút gọn.

## 9. Kiểm tra trước khi ghi thật
- [ ] Đúng CompanyDB đích? · [ ] Đã GET/`$metadata` xác nhận field & UDF?
- [ ] Payload tối thiểu, đúng PATCH/POST? · [ ] Có khoá ngoài/idempotency cho POST tạo mới?
- [ ] Đã có xác nhận của người dùng cho ghi/xoá/đóng/huỷ? · [ ] Plan rollback/đối soát sau ghi?
