// ============================================================
// DÙNG CHUNG cho chứng từ Sales A/R Phase 1 + Phase 2:
// Báo giá bán hàng · Hóa đơn bán hàng · Phiếu ghi có phải thu · Phiếu trả
// hàng bán · Hóa đơn đặt cọc phải thu (Phase 2)
// Cấu trúc + thuật ngữ mirror theo orders-list-view / order-form-view /
// order-detail-view để đồng nhất trải nghiệm người dùng.
// ============================================================

import type { SessionUser, ModuleKey, ActionKey } from '@/lib/fm-shared'

/** Đích của nút "Sao chép sang …" trên các trang chi tiết */
export type CopyTarget =
  | 'quotation'
  | 'order'
  | 'delivery'
  | 'invoice'
  | 'creditMemo'
  | 'return'
  | 'downPayment'

/** Tên tiếng Việt chuẩn của từng loại chứng từ (không viết tắt, không lai Anh-Việt) */
export const DOC_TYPE_LABEL: Record<string, string> = {
  quotation: 'Báo giá bán hàng',
  order: 'Đơn hàng bán',
  delivery: 'Phiếu giao hàng',
  invoice: 'Hóa đơn bán hàng',
  creditMemo: 'Phiếu ghi có phải thu',
  return: 'Phiếu trả hàng bán',
  downPayment: 'Hóa đơn đặt cọc phải thu',
}

export const DOC_STATUS_LABEL: Record<string, string> = {
  Open: 'Mở',
  Closed: 'Đã đóng',
  Cancelled: 'Đã hủy',
}

/** 1 dòng chứng từ — mirror cấu trúc Line của Order */
export interface SalesDocLine {
  id: string
  lineNum?: number
  itemCode: string
  itemName: string
  uom?: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  lineTotal?: number
  discPct?: number
  discAmt?: number
  vatPct?: number
  vatAmt?: number
  grandTotal?: number
  taxCode?: string
  /** Tương đương BaseLine của SAP: id dòng chứng từ nguồn */
  sourceLineId?: string | null
}

/** Khấu trừ đặt cọc gắn trên hóa đơn (model DownPaymentDraw của API — WORKER A) */
export interface DownPaymentDrawItem {
  downPaymentId: string
  downPaymentDocNum?: number | null
  drawAmount: number
}

/** 1 chứng từ — mirror cấu trúc Order */
export interface SalesDoc {
  id: string
  /** Bản nháp chưa cấp số thật → API trả null (Phase 2); hiển thị qua docNumLabel() */
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks?: string | null
  warehouseCode?: string | null
  totalBeforeDisc: number
  discountAmt: number
  headerDiscPct?: number
  headerDiscAmt?: number
  vatAmt: number
  grandTotal: number
  createdBy?: string
  version?: number
  sapDocEntry?: number | null
  sapDocNum?: number | null
  sapSyncStatus?: string
  sapSyncError?: string | null
  sapSyncedAt?: string | null
  source?: string
  /** Nhãn + số chứng từ nguồn (để hiển thị "Tạo từ …") */
  sourceLabel?: string | null
  sourceDocNum?: number | null
  /** Phase 2 — Nháp: true = bản nháp chưa có hiệu lực (API: ?draft=true khi lưu, ?isDraft khi lọc) */
  isDraft?: boolean
  /** Loại hóa đơn: 'Item' | 'Service' | 'Reserve' (chỉ Hóa đơn bán hàng) */
  docType?: string | null
  /** Phase 2 — Hóa đơn đặt cọc: số dư chưa khấu trừ (= grandTotal − đã khấu trừ) */
  remainingAmount?: number | null
  /** Phase 2 — Khấu trừ đặt cọc đã gắn trên hóa đơn */
  draws?: DownPaymentDrawItem[]
  lines: SalesDocLine[]
}

// ---------- Chế độ SỬA (form) — mirror EditOrderData / toEditData ----------
export interface EditDocLine {
  dbId?: string
  sapLineNum?: number
  itemCode: string
  itemName: string
  uom?: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  discPct?: number
  vatPct?: number
  taxCode?: string
  sourceLineId?: string | null
}

export interface EditDocData {
  id?: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks: string | null
  warehouseCode?: string | null
  headerDiscPct?: number
  sapSyncStatus?: string
  version?: number
  /** Phase 2 — Nháp */
  isDraft?: boolean
  /** Phase 2 — Loại hóa đơn ('Item' | 'Service' | 'Reserve') */
  docType?: string | null
  /** Phase 2 — Khấu trừ đặt cọc đã gắn trên hóa đơn */
  draws?: DownPaymentDrawItem[]
  lines: EditDocLine[]
}

export interface EditDocSourceLine {
  id?: string
  lineNum?: number
  itemCode: string
  itemName: string
  uom?: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  discPct?: number
  vatPct?: number
  taxCode?: string
  sourceLineId?: string | null
}

export interface EditDocSource {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks?: string | null
  warehouseCode?: string | null
  headerDiscPct?: number
  sapSyncStatus?: string
  version?: number
  source?: string
  localId?: string | null
  /** Phase 2 — Nháp / loại hóa đơn / khấu trừ đặt cọc */
  isDraft?: boolean
  docType?: string | null
  draws?: DownPaymentDrawItem[]
  lines: EditDocSourceLine[]
}

/**
 * Dựng EditDocData từ 1 chứng từ — DÙNG CHUNG cho mọi đường vào form sửa.
 * QUAN TRỌNG: map dbId (dòng local) / sapLineNum (dòng SAP) để API PUT
 * nhận diện đúng dòng cũ — thiếu 2 trường này, PUT sẽ append TRÙNG dòng
 * trên SAP B1 (B1S-ReplaceCollectionsOnPatch coi dòng không LineNum là dòng mới).
 */
export const toEditDocData = (o: EditDocSource): EditDocData => ({
  id: o.source === 'sap' ? o.localId ?? o.id : o.id,
  docNum: o.docNum,
  cardCode: o.cardCode,
  cardName: o.cardName,
  docDate: o.docDate,
  docDueDate: o.docDueDate,
  status: o.status,
  remarks: o.remarks ?? null,
  warehouseCode: o.warehouseCode ?? null,
  headerDiscPct: o.headerDiscPct ?? 0,
  sapSyncStatus: o.sapSyncStatus ?? (o.source === 'sap' ? 'synced' : 'none'),
  version: o.version,
  isDraft: o.isDraft ?? false,
  docType: o.docType ?? null,
  draws: o.draws ?? [],
  lines: o.lines.map((l) => ({
    dbId: o.source === 'sap' ? undefined : l.id,
    sapLineNum: o.source === 'sap' ? l.lineNum : undefined,
    itemCode: l.itemCode,
    itemName: l.itemName,
    uom: l.uom,
    warehouseCode: l.warehouseCode,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discPct: l.discPct,
    vatPct: l.vatPct,
    taxCode: l.taxCode,
    sourceLineId: l.sourceLineId ?? null,
  })),
})

/** Đọc quyền RBAC (ModuleKey đã có 4 module mới) */
export function hasPerm(user: SessionUser, module: ModuleKey, action: ActionKey): boolean {
  return Boolean(user.permissions[module]?.[action])
}

/** Nút "Sao chép sang …" trên trang chi tiết */
export interface CopyButton {
  target: CopyTarget
  label: string
}

/** Cấu hình 1 loại chứng từ cho các view dùng chung */
export interface DocKindConfig {
  /** Base path API: 'quotations' | 'invoices' | 'credit-memos' | 'returns' | 'down-payments' */
  apiBase: string
  /** Key unwrap trong response API: 'quotation' | 'invoice' | 'creditMemo' | 'return' | 'downPayment' */
  docKey: string
  /** Tên chuẩn tiếng Việt: 'Báo giá bán hàng' … */
  docLabel: string
  /** Key module quyền RBAC */
  permModule: ModuleKey
  /** null = đầu luồng, không có from-source */
  fromSourceApi: string | null
  /** map sourceType → FK field gửi kèm khi lưu (tương đương BaseType/BaseEntry của SAP) */
  sourceIdField: Record<string, string>
  /** Nút copy-to trên trang chi tiết */
  copyButtons: CopyButton[]
  /** Phase 2 — hiện picker "Khấu trừ đặt cọc" trên form (chỉ Hóa đơn bán hàng) */
  enableDownPaymentDraws?: boolean
  /** Phase 2 — hiện select loại hóa đơn Hàng hóa/Dịch vụ/Dự trữ (chỉ Hóa đơn bán hàng) */
  enableDocType?: boolean
  /** Phase 2 — hiện "Số dư chưa khấu trừ" trên trang chi tiết (chỉ Hóa đơn đặt cọc) */
  showRemaining?: boolean
}

/** Nhãn hiển thị theo loại hóa đơn — 'Reserve' → "Hóa đơn bán hàng dự trữ" */
export function docLabelFor(config: DocKindConfig, docType?: string | null): string {
  if (config.enableDocType && docType === 'Reserve') return 'Hóa đơn bán hàng dự trữ'
  return config.docLabel
}

/** Options select "Loại hóa đơn" (trường docType của ArInvoice) */
export const INVOICE_DOC_TYPE_OPTIONS = [
  { value: 'Item', label: 'Hàng hóa' },
  { value: 'Service', label: 'Dịch vụ' },
  { value: 'Reserve', label: 'Dự trữ' },
] as const

export const QUOTATION_CONFIG: DocKindConfig = {
  apiBase: 'quotations',
  docKey: 'quotation',
  docLabel: 'Báo giá bán hàng',
  permModule: 'quotations',
  fromSourceApi: null, // đầu luồng — không có from-source
  sourceIdField: {},
  copyButtons: [
    { target: 'order', label: 'Sao chép sang đơn hàng bán' },
    { target: 'delivery', label: 'Sao chép sang phiếu giao hàng' },
    { target: 'invoice', label: 'Sao chép sang hóa đơn bán hàng' },
    { target: 'downPayment', label: 'Sao chép sang hóa đơn đặt cọc phải thu' },
  ],
}

export const INVOICE_CONFIG: DocKindConfig = {
  apiBase: 'invoices',
  docKey: 'invoice',
  docLabel: 'Hóa đơn bán hàng',
  permModule: 'invoices',
  fromSourceApi: '/api/invoices/from-source',
  sourceIdField: { quotation: 'sourceQuotationId', order: 'sourceOrderId', delivery: 'sourceDeliveryId' },
  copyButtons: [{ target: 'creditMemo', label: 'Sao chép sang phiếu ghi có phải thu' }],
  enableDownPaymentDraws: true, // picker khấu trừ đặt cọc trên form hóa đơn
  enableDocType: true, // select loại hóa đơn Hàng hóa / Dịch vụ / Dự trữ
}

export const CREDIT_MEMO_CONFIG: DocKindConfig = {
  apiBase: 'credit-memos',
  docKey: 'creditMemo',
  docLabel: 'Phiếu ghi có phải thu',
  permModule: 'creditMemos',
  fromSourceApi: '/api/credit-memos/from-source',
  sourceIdField: { invoice: 'sourceInvoiceId', return: 'sourceReturnId' },
  copyButtons: [], // cuối luồng — không có copy-to tiếp
}

export const RETURN_CONFIG: DocKindConfig = {
  apiBase: 'returns',
  /** API trả về key 'salesReturn' (resultKey của WORKER A) */
  docKey: 'salesReturn',
  docLabel: 'Phiếu trả hàng bán',
  permModule: 'returns',
  fromSourceApi: '/api/returns/from-source',
  sourceIdField: { delivery: 'sourceDeliveryId', invoice: 'sourceInvoiceId' },
  copyButtons: [{ target: 'creditMemo', label: 'Sao chép sang phiếu ghi có phải thu' }],
}

/** Unwrap linh hoạt response API chi tiết/lưu:
 *  API trả { ok, quotation|invoice|creditMemo|return|downPayment } hoặc { doc }
 *  hoặc { order } (orders-style) */
export function unwrapDoc(json: unknown, cfg: DocKindConfig): SalesDoc {
  const j = (json ?? {}) as Record<string, unknown>
  return (j[cfg.docKey] ?? j.doc ?? j.data ?? j.order ?? j) as SalesDoc
}

/**
 * Phase 2 — HÓA ĐƠN ĐẶT CỌC PHẢI THU (ArDownPayment / ArDownPaymentLine, do WORKER A
 * triển khai backend). Contract API giả định:
 * - GET  /api/down-payments?{q,status,from,to,isDraft,cardCode}&page&pageSize → { data, total, totalPages }
 *   (mỗi dòng: isDraft, remainingAmount, sap* fields như các chứng từ Phase 1)
 * - GET  /api/down-payments/{id} → { downPayment: {...} } (có remainingAmount)
 * - POST /api/down-payments[?draft=true] — body giống các chứng từ Phase 1
 * - PATCH /api/down-payments/{id} — cập nhật (version optimistic locking)
 * - PATCH /api/down-payments/{id}/finalize { version } — nháp → chính thức
 * - POST /api/down-payments/from-source { sourceType: 'quotation'|'order', sourceId }
 *   → { ok, downPayment } (API tạo NGAY 201, dedupe chống bấm đúp)
 * - DELETE /api/down-payments/{id}
 */
export const DOWN_PAYMENT_CONFIG: DocKindConfig = {
  apiBase: 'down-payments',
  docKey: 'downPayment',
  docLabel: 'Hóa đơn đặt cọc phải thu',
  permModule: 'downPayments',
  fromSourceApi: '/api/down-payments/from-source',
  sourceIdField: { quotation: 'sourceQuotationId', order: 'sourceOrderId' },
  copyButtons: [], // đặt cọc được khấu trừ trên hóa đơn, không sao chép tiếp
  showRemaining: true, // hiện "Số dư chưa khấu trừ" trên trang chi tiết
}

/** Số chứng từ hiển thị — bản nháp chưa cấp số thật (docNum=null) */
export function docNumLabel(docNum: number | null | undefined, isDraft?: boolean): string {
  if (docNum != null) return `#${docNum}`
  return isDraft ? '#(nháp)' : '#—'
}

export const clampPct = (n: number) => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0))
