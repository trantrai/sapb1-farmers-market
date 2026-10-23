// ============================================================
// "Sao chép từ" (Copy From) chuẩn SAP B1 — cấu hình dùng chung cho
// CopyFromPicker và các form tạo chứng từ (client-safe: không import
// module máy chủ).
// Ma trận copy-from (target ← source):
// - Đơn hàng bán      ← Báo giá bán hàng
// - Phiếu giao hàng   ← Đơn hàng bán
// - Hóa đơn bán hàng  ← Báo giá bán hàng, Đơn hàng bán, Phiếu giao hàng
// - Phiếu trả hàng bán ← Phiếu giao hàng, Hóa đơn bán hàng
// - Phiếu ghi có phải thu ← Hóa đơn bán hàng, Phiếu trả hàng bán
// - Hóa đơn đặt cọc phải thu ← Báo giá bán hàng, Đơn hàng bán
// - Báo giá bán hàng  ← (đầu luồng — không có)
// ============================================================

/** Loại chứng từ đích của "Sao chép từ" */
export type CopyFromTarget = 'order' | 'delivery' | 'invoice' | 'creditMemo' | 'return' | 'downPayment'

/** Loại chứng từ nguồn (khớp sourceType của API from-source / DOC_TYPE_LABEL) */
export type CopyFromSourceKey = 'quotation' | 'order' | 'delivery' | 'invoice' | 'return'

/** 1 loại chứng từ nguồn khả dụng cho 1 target */
export interface CopyFromSourceOpt {
  /** 'quotation' | 'order' | 'delivery' | 'invoice' | 'return' */
  key: CopyFromSourceKey
  /** GET list API của loại nguồn: '/api/quotations' | '/api/orders' | ... */
  listApi: string
}

/**
 * Ma trận copy-from: mỗi target → danh sách loại nguồn hợp lệ (theo SAP B1).
 */
export const COPY_FROM_SOURCES: Record<CopyFromTarget, CopyFromSourceOpt[]> = {
  order: [{ key: 'quotation', listApi: '/api/quotations' }],
  delivery: [
    { key: 'quotation', listApi: '/api/quotations' },
    { key: 'order', listApi: '/api/orders' },
  ],
  invoice: [
    { key: 'quotation', listApi: '/api/quotations' },
    { key: 'order', listApi: '/api/orders' },
    { key: 'delivery', listApi: '/api/deliveries' },
  ],
  creditMemo: [
    { key: 'invoice', listApi: '/api/invoices' },
    { key: 'return', listApi: '/api/returns' },
  ],
  return: [
    { key: 'delivery', listApi: '/api/deliveries' },
    { key: 'invoice', listApi: '/api/invoices' },
  ],
  downPayment: [
    { key: 'quotation', listApi: '/api/quotations' },
    { key: 'order', listApi: '/api/orders' },
  ],
}

/** 1 dòng hàng trong payload prefill (?prefill=1) */
export interface PrefillLine {
  itemCode: string
  itemName: string
  barcode?: string | null
  uom?: string
  warehouseCode?: string | null
  taxCode?: string | null
  quantity: number
  unitPrice: number
  discPct?: number
  vatPct?: number
  /** true = dòng thành phần con của mặt hàng BOM */
  isBomChild?: boolean
  bomGroupKey?: string | null
  bomEditable?: boolean
  bomQtyPerParent?: number | null
  /** Tương đương BaseLine của SAP: id dòng chứng từ nguồn */
  sourceLineId?: string | null
  /** Mã tài khoản kế toán (chỉ có ý nghĩa khi target là hóa đơn dịch vụ) */
  accountCode?: string | null
}

/**
 * Payload prefill "Sao chép từ" — API ?prefill=1 trả về trong
 * { ok: true, prefill }, form điền vào state rồi để user kiểm tra/lưu.
 */
export interface PrefillDoc {
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  remarks: string
  headerDiscPct: number
  warehouseCode?: string | null
  lines: PrefillLine[]
  /** sourceType của API from-source ('quotation' | 'order' | 'delivery' | 'invoice' | 'return') */
  sourceType: string
  sourceId: string
  sourceDocNum: number | null
  /** Nhãn tiếng Việt: 'báo giá bán hàng', 'đơn hàng bán', ... */
  sourceLabel: string
}

/** Request POST prefill (?prefill=1) cho 1 cặp target × source */
export interface PrefillRequest {
  url: string
  body: Record<string, string>
}

/**
 * Dựng request prefill cho picker:
 * - order ← quotation → POST /api/orders/from-quotation?prefill=1 { quotationId }
 * - delivery ← order → POST /api/deliveries/from-order?prefill=1 { orderId }
 * - delivery ← quotation → POST /api/deliveries/from-quotation?prefill=1 { quotationId }
 * - còn lại → POST /api/{base}/from-source?prefill=1 { sourceType, sourceId }
 */
export function copyFromPrefillRequest(
  target: CopyFromTarget,
  sourceType: CopyFromSourceKey,
  sourceId: string,
): PrefillRequest {
  if (target === 'order') {
    return { url: '/api/orders/from-quotation?prefill=1', body: { quotationId: sourceId } }
  }
  if (target === 'delivery') {
    if (sourceType === 'quotation') {
      return { url: '/api/deliveries/from-quotation?prefill=1', body: { quotationId: sourceId } }
    }
    return { url: '/api/deliveries/from-order?prefill=1', body: { orderId: sourceId } }
  }
  const apiBase =
    target === 'invoice'
      ? 'invoices'
      : target === 'creditMemo'
        ? 'credit-memos'
        : target === 'return'
          ? 'returns'
          : 'down-payments'
  return { url: `/api/${apiBase}/from-source?prefill=1`, body: { sourceType, sourceId } }
}
