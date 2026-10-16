// ============================================================
// FARMERS MARKET — Import BOM: 17 quyết định đã chốt (F8)
// Nguồn: ~/workspace/bom-import-mapping/docs/decision-log.md
// Snapshot vào ImportRun.decisions mỗi khi tạo run.
// ============================================================

export interface BomDecision {
  /** Q1..Q10, NQ1..NQ7 */
  id: string
  /** Nhóm: 'mapping' | 'pipeline' */
  group: 'mapping' | 'pipeline'
  question: string
  decided: string
}

/** 17 quyết định Trải đã chốt ngày 2026-10-16 (100% ✅) */
export const BOM_DECISIONS: BomDecision[] = [
  { id: 'Q1', group: 'mapping', question: 'Mẫu sinh mã cha khi Item code trống', decided: 'Phase 1: user tự nhập mã cha đầu tiên, các mã cha còn lại tự tăng dần theo phần số cuối (giữ zero-padding; kiểm tra trùng trước khi dùng)' },
  { id: 'Q2', group: 'mapping', question: 'Barcode chính và barcode phụ', decided: 'Barcode chính ưu tiên thương mại → đầu 8 → đầu I; barcode phụ KHÔNG đưa lên SAP B1 (chỉ lưu trong canonical để tra cứu)' },
  { id: 'Q3', group: 'mapping', question: 'Loại Type (I/M/N/W) map đi đâu trên B1', decided: 'Bỏ qua (vẫn lưu trong canonical)' },
  { id: 'Q4', group: 'mapping', question: 'Bảng tra Level 7 → ItemsGroupCode đặt ở đâu', decided: 'Config trong app (bảng tra cấu hình)' },
  { id: 'Q5', group: 'mapping', question: 'Giá Price List 1 / Item.price: trước hay sau VAT', decided: 'Trước VAT (tính từ cột sau VAT nhập tay ÷ (1+thuế))' },
  { id: 'Q6', group: 'mapping', question: 'bomType cho COMBO trong app FM', decided: 'Mở rộng enum thêm assembly: BOM PRODUCT → production, BOM ASSEMBLY (COMBO) → assembly' },
  { id: 'Q7', group: 'mapping', question: 'Mã NVL chưa tồn tại trên SAP B1', decided: 'Fail-fast — dừng cả đợt, báo đúng dòng (preview đã cảnh báo trước)' },
  { id: 'Q8', group: 'mapping', question: 'Mã NCC → CardCode tra cứu thế nào', decided: 'Khớp tuyệt đối mã NCC = CardCode (không khớp → warning, bỏ qua Mainsupplier)' },
  { id: 'Q9', group: 'mapping', question: 'Kho TP trống thì dùng kho nào', decided: 'Kho mặc định trong config app' },
  { id: 'Q10', group: 'mapping', question: 'ProductTrees.Quantity', decided: '= 1 (nhất quán với định mức đã chuẩn hóa về 1 đơn vị cha)' },
  { id: 'NQ1', group: 'pipeline', question: 'Layout "file đích 2 sheet"', decided: 'Chưa có — khi nào có layout sẽ thêm ExcelTemplate, không code cứng' },
  { id: 'NQ2', group: 'pipeline', question: 'Phase 2 tự sinh Sales Order nháp từ báo giá', decided: 'Có — phase 2 sinh Sales Order NHÁP (chỉ nháp, duyệt từng dòng trước khi đẩy B1)' },
  { id: 'NQ3', group: 'pipeline', question: 'Ngưỡng cảnh báo W7 (lệch giá) / W8 (lệch margin)', decided: '1% / 3 điểm %' },
  { id: 'NQ4', group: 'pipeline', question: 'Quy tắc link MD_05 parent ↔ set trong báo giá', decided: 'Theo tên chứa nhau (không khớp → warning W9, user gán tay ở preview)' },
  { id: 'NQ5', group: 'pipeline', question: 'Lịch giao hàng: chỉ lưu trace hay đẩy draft Delivery', decided: 'Chỉ lưu trace trong canonical' },
  { id: 'NQ6', group: 'pipeline', question: 'Ưu tiên field khi các field file trỏ file khác nhau', decided: 'File BOM (IN-1) cố định; IN-2 ưu tiên "File hợp đồng"' },
  { id: 'NQ7', group: 'pipeline', question: 'Cập nhật ngược lên job Base khi run done/failed', decided: 'Không write-back. Phase 1 bắt buộc preview + phê duyệt từng đợt, không chạy tự động' },
]

/** Snapshot JSON để lưu vào ImportRun.decisions */
export function snapshotDecisions(): string {
  return JSON.stringify(
    BOM_DECISIONS.map((d) => ({ id: d.id, decided: d.decided, at: new Date().toISOString() })),
  )
}
