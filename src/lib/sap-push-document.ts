// ============================================================
// ĐẨY CHỨNG TỪ BÁN HÀNG SANG SAP B1 (POST/PATCH dùng chung)
// EntitySet SAP B1 Service Layer:
//  - Orders        → Đơn hàng bán (ORDR/RDR1)
//  - Quotations    → Báo giá bán hàng (OQUT/QUT1)
//  - DeliveryNotes → Phiếu giao hàng (ODLN/DLN1)
//  - Invoices      → Hóa đơn bán hàng (OINV/INV1)
//  - CreditNotes   → Phiếu ghi có phải thu (ORIN/RIN1)
//  - Returns       → Phiếu trả hàng bán (ORDN/RDN1)
//  - DownPayments  → Hóa đơn đặt cọc phải thu (ODPI/DPI1)
// Quy tắc (kế thừa từ sap-push-order):
//  - Chưa cấu hình Service Layer → status 'none' (chỉ lưu local)
//  - Đẩy thành công → 'synced' + lưu DocEntry/DocNum do SAP cấp
//  - Đẩy thất bại  → 'pending' + lưu thông báo lỗi (retry sau)
//  - Chứng từ NHÁP (isDraft=true) → KHÔNG đẩy, trả 'none' (guard ở tầng push)
//  - KHÔNG bao giờ ném exception — luôn trả SapPushResult.
// Phase 2: Invoices hỗ trợ DocType Service (dDocument_Service),
// ReserveInvoice=tYES (hóa đơn dự trữ) và DownPaymentsToDraw
// (khấu trừ đặt cọc) — theo $metadata Service Layer (Document,
// DownPaymentToDraw, DownPaymentTypeEnum.dptInvoice).
// ============================================================

import { loadSapSettings, isSapConfigured, sapGet, sapPost, sapPatch, type SapConfig } from './sap-service-layer'
import { db as prisma } from './db'
import { classifySapPostFailure, withMarker, type SapSyncErrorKind } from './sap-sync-retry'
import { freshTemplateGroups, isFreshTplChild, reconcileTemplateBoms, type SapDocLine } from './sap-bom-reconcile'

/** Entity set chứng từ bán hàng trên Service Layer (OData v2) */
export type SapDocEntitySet =
  | 'Orders'
  | 'Quotations'
  | 'DeliveryNotes'
  | 'Invoices'
  | 'CreditNotes'
  | 'Returns'
  | 'DownPayments'

export interface SapPushLine {
  itemCode: string
  quantity: number
  unitPrice: number
  /** Chiết khấu % của dòng (SAP: DiscountPercent) */
  discPct?: number
  /** Mã nhóm thuế SAP (SalesVATGroup) → VatGroup */
  taxCode?: string | null
  /** Kho xuất của dòng (SAP: WarehouseCode — OWHS) */
  warehouseCode?: string | null
  /** Đơn vị tính của dòng (SAP: MeasureUnit) — rỗng thì bỏ qua, SAP dùng mặc định của mặt hàng */
  uom?: string | null
  /**
   * Local id của dòng chứng từ nguồn (copy-from/copy-to chuẩn SAP B1).
   * Khi đẩy, module tự tra DB để gắn BaseType/BaseEntry/BaseLine vào payload —
   * nếu nguồn chưa lên SAP thì CHẶN đẩy (không lặng lẽ bỏ qua).
   */
  sourceLineId?: string | null
  /**
   * Mã tài khoản kế toán của dòng (SAP: DocumentLines.AccountCode).
   * Hóa đơn dịch vụ (DocType=dDocument_Service): dòng BẮT BUỘC gửi
   * AccountCode thay vì ItemCode.
   */
  accountCode?: string | null
  /**
   * Số lô của dòng (Đợt 2+3) — khi có giá trị, payload gửi
   * DocumentLines.BatchNumbers = [{ BatchNumber }]; trống → bỏ qua,
   * giữ nguyên hành vi cũ.
   */
  batchNumber?: string | null
  /**
   * BOM: dòng cha và các dòng con cùng `bomGroupKey`. Nhóm BOM Template
   * (con sửa được — bomEditable ≠ false): SAP LUÔN tự bung công thức khi nhận
   * dòng cha (TreeType=iNotATree bị bỏ qua — đã xác nhận trên SAP thật), nên
   * đẩy 2 bước (sap-bom-reconcile.ts): gửi cha + dòng con người dùng (SL đã
   * chỉnh, giá 0, U_BOMID = mã cha) → xoá khối định mức gốc SAP chèn sau cha.
   */
  isBomChild?: boolean
  bomGroupKey?: string | null
  bomEditable?: boolean | null
}

/** UDF dòng chứng từ lưu mã BOM cha của dòng thành phần */
export const UDF_BOM_ID = 'U_BOMID'

/** Lấy các trường BOM của dòng (DB/calc line) để truyền vào push/PATCH */
export function bomLineFields(l: { isBomChild?: boolean | null; bomGroupKey?: string | null; bomEditable?: boolean | null }) {
  return { isBomChild: l.isBomChild ?? false, bomGroupKey: l.bomGroupKey ?? null, bomEditable: l.bomEditable ?? null }
}

/** Nhóm BOM Template trong danh sách dòng: bomGroupKey → mã mặt hàng cha */
function templateBomGroups(lines: SapPushLine[]): Map<string, string> {
  const parents = new Map<string, string>()
  const kids = new Map<string, SapPushLine[]>()
  for (const l of lines) {
    const gk = l.bomGroupKey || ''
    if (!gk) continue
    if (l.isBomChild) kids.set(gk, [...(kids.get(gk) ?? []), l])
    else parents.set(gk, l.itemCode)
  }
  const out = new Map<string, string>()
  for (const [gk, parentCode] of parents) {
    const children = kids.get(gk) ?? []
    // Production/Assembly: con khóa theo công thức (bomEditable=false) → giữ hành vi cũ
    if (children.length > 0 && children.every((c) => c.bomEditable !== false)) out.set(gk, parentCode)
  }
  return out
}

/**
 * Header mở rộng Đợt 2+3 — các trường SAP B1 gửi kèm trong payload
 * Document khi CÓ GIÁ TRỊ; trống thì bỏ qua (giữ nguyên hành vi SAP
 * mặc định), trừ DiscountPercent đã luôn gửi ở chỗ khác.
 */
export interface SapDocHeaderExtras {
  /** Nhân viên bán hàng (SAP: Documents.SalesPersonCode) */
  salesPersonCode?: number | null
  /** Điều khoản thanh toán (SAP: Documents.PaymentGroupCode) */
  paymentGroupCode?: number | null
  /** Địa chỉ giao hàng (SAP: Documents.ShipToCode) */
  shipToCode?: string | null
  /** Địa chỉ ghi hóa đơn (SAP: Documents.BillToCode) */
  billToCode?: string | null
  /** Người liên hệ (SAP: Documents.ContactPersonCode = ContactEmployees.InternalCode) */
  contactPersonCode?: number | null
  /** Số PO / tham chiếu của KH (SAP: Documents.NumAtCard) */
  numAtCard?: string | null
  /** Ngày tính thuế (SAP: Documents.TaxDate) — YYYY-MM-DD hoặc Date */
  taxDate?: string | Date | null
  /** Tiền tệ chứng từ (SAP: Documents.DocCurrency) */
  docCurrency?: string | null
  /** Tỷ giá (SAP: Documents.DocRate) — chỉ gửi kèm DocCurrency khi ≠ VND */
  docRate?: number | null
  /** Mã dự án (SAP: Documents.ProjectCode) */
  projectCode?: string | null
  /** Ngày cần giao (SAP: Documents.ReqDate) — YYYY-MM-DD hoặc Date */
  reqDate?: string | Date | null
}

export interface SapPushInput extends SapDocHeaderExtras {
  /** Id SapDatabase đích — luôn đẩy đúng DB đã ghi nhận khi tạo (chống lẫn DB) */
  databaseId?: string | null
  /**
   * true = chứng từ đang là NHÁP → KHÔNG đẩy sang SAP, trả { status: 'none' }.
   * Guard ở tầng push để mọi luồng (tạo/finalize/retry) đều an toàn.
   */
  isDraft?: boolean
  cardCode: string
  /** YYYY-MM-DD hoặc ISO datetime — chuẩn hóa thành YYYY-MM-DD trước khi gửi */
  docDate: string
  docDueDate: string
  /** Ghi chú → Comments của SAP (tối đa 254 ký tự) */
  comments?: string | null
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
  headerDiscPct?: number
  /**
   * Hóa đơn bán hàng: 'Item' | 'Service' | 'Reserve'.
   * Service → DocType=dDocument_Service; Reserve → ReserveInvoice=tYES
   * (theo $metadata: Document.DocType : BoDocumentTypes,
   * Document.ReserveInvoice : BoYesNoEnum).
   */
  invoiceDocType?: 'Item' | 'Service' | 'Reserve'
  /**
   * Hóa đơn bán hàng: danh sách khấu trừ đặt cọc →
   * DownPaymentsToDraw: [{ DocEntry, AmountToDraw, DownPaymentType: 'dptInvoice' }]
   * (theo $metadata: DownPaymentToDraw, DownPaymentTypeEnum).
   * Chỉ gồm các đặt cọc đã synced (có sapDocEntry).
   */
  draws?: Array<{ downPaymentDocEntry: number; drawAmount: number }>
  lines: SapPushLine[]
  /**
   * Id bản ghi local — dùng cho idempotency khi đẩy sang SAP.
   * Nếu SAP đã định nghĩa UDF U_FM_LocalId: trước khi POST sẽ kiểm tra
   * chứng từ có UDF này chưa (tránh trùng khi retry sau timeout), và gắn
   * UDF vào payload POST. Nếu SAP chưa có UDF → bỏ qua, giữ nguyên
   * hành vi cũ (không làm hỏng đẩy chứng từ hiện tại).
   */
  localId?: string
}

export interface SapPushDocumentInput extends SapPushInput {
  /** Entity set đích trên Service Layer */
  entitySet: SapDocEntitySet
}

export interface SapPushResult {
  /** none = chưa cấu hình SAP; pending = lỗi, thử lại sau; synced = OK; error = PATCH bị SL từ chối */
  status: 'none' | 'pending' | 'synced' | 'error'
  docEntry?: number
  docNum?: number
  error?: string
  /** LineNum do SAP cấp cho từng dòng (theo thứ tự dòng đẩy) — cần khi SỬA (PATCH) */
  lineNums?: number[]
  /**
   * true = bị CHẶN ở tầng validate trước khi đẩy (ví dụ: chứng từ nguồn của
   * copy-from chưa lên SAP). Route nên trả HTTP 400 thay vì 502.
   */
  blocked?: boolean
  /** Loại lỗi khi đẩy thất bại — quyết định có tự thử lại không (xem sap-sync-retry) */
  errorKind?: SapSyncErrorKind
  /** Chứng từ được gửi kèm UDF marker U_FM_LocalId (tra lại được, chống trùng) */
  udf?: boolean
}

/**
 * Đầu vào cho PATCH — sửa chứng từ đang Open.
 * Địa chỉ giao/ghi hóa đơn + người liên hệ (ShipToCode/BillToCode/
 * ContactPersonCode) gửi kèm khi có giá trị để thay đổi trên form lên SAP.
 */
export interface SapPatchInput extends Pick<SapDocHeaderExtras, 'shipToCode' | 'billToCode' | 'contactPersonCode'> {
  docEntry: number
  cardCode?: string
  docDate?: string
  docDueDate?: string
  comments?: string | null
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
  headerDiscPct?: number
  /** Dòng đã tồn tại trên SAP phải kèm lineNum (để cập nhật đúng dòng);
   * dòng mới không có lineNum; dòng bị bỏ khỏi danh sách sẽ bị XÓA
   * (header B1S-ReplaceCollectionsOnPatch=true) */
  lines: (SapPushLine & { lineNum?: number | null })[]
  /**
   * Loại hóa đơn local: 'Item' | 'Service' | 'Reserve'. Khi là 'Service'
   * (SAP: DocType=dDocument_Service) các dòng gửi AccountCode thay vì
   * ItemCode — chuẩn SAP B1 cho dòng dịch vụ.
   */
  invoiceDocType?: 'Item' | 'Service' | 'Reserve'
}

export interface SapPatchDocumentInput extends SapPatchInput {
  /** Entity set đích trên Service Layer */
  entitySet: SapDocEntitySet
}

interface SapDocResponse {
  DocEntry?: number
  DocNum?: number
  DocumentLines?: { LineNum?: number }[] | { results?: { LineNum?: number }[] }
}

const onlyDate = (d: string) => (d || '').slice(0, 10)

// ============================================================
// COPY-FROM → BaseType/BaseEntry/BaseLine
// Khi chứng từ được sao chép từ chứng từ nguồn (copy-from/copy-to chuẩn
// SAP B1), mỗi dòng mang sourceLineId (local id của dòng nguồn). Lúc đẩy
// sang SAP B1 phải gắn BaseType/BaseEntry/BaseLine vào DocumentLines để
// SAP trừ OpenQty của nguồn — nếu không SAP coi là chứng từ độc lập và
// cho phép giao/hóa đơn trùng.
// ============================================================

/** Liên kết base SAP B1 của 1 dòng copy-from (gắn vào DocumentLines khi POST) */
export interface SapLineBase {
  /** Object type SAP B1 của chứng từ nguồn: 23=báo giá, 17=đơn hàng, 15=giao hàng, 13=hóa đơn, 14=ghi có, 16=trả hàng */
  baseType: number
  /** DocEntry của chứng từ nguồn trên SAP */
  baseEntry: number
  /** LineNum của dòng nguồn trên SAP */
  baseLine: number
}

/** Mô tả 1 loại dòng nguồn có thể tra cứu trong DB */
export interface SourceLineSpec {
  /** Prisma delegate của bảng dòng nguồn */
  lineDelegate: 'quotationLine' | 'salesOrderLine' | 'deliveryLine' | 'arInvoiceLine' | 'salesReturnLine'
  /** Prisma delegate của bảng header nguồn */
  headerDelegate: 'quotation' | 'salesOrder' | 'delivery' | 'arInvoice' | 'salesReturn'
  /** Tên FK trên dòng → header */
  headerFk: string
  /** Object type SAP B1 (BaseType): 23=báo giá, 17=đơn hàng, 15=giao hàng, 13=hóa đơn, 16=trả hàng */
  baseType: number
  /** Tên tiếng Việt của chứng từ nguồn (dùng trong câu lỗi) */
  label: string
  /**
   * Model dòng có field sapLineNum không. DeliveryLine KHÔNG có sapLineNum
   * → suy BaseLine từ lineNum local (xem localLineToSapLineNum).
   */
  hasSapLineNum: boolean
}

const SOURCE_LINE_SPECS: SourceLineSpec[] = [
  { lineDelegate: 'quotationLine', headerDelegate: 'quotation', headerFk: 'quotationId', baseType: 23, label: 'báo giá bán hàng', hasSapLineNum: true },
  { lineDelegate: 'salesOrderLine', headerDelegate: 'salesOrder', headerFk: 'orderId', baseType: 17, label: 'đơn hàng bán', hasSapLineNum: true },
  { lineDelegate: 'deliveryLine', headerDelegate: 'delivery', headerFk: 'deliveryId', baseType: 15, label: 'phiếu giao hàng', hasSapLineNum: false },
  { lineDelegate: 'arInvoiceLine', headerDelegate: 'arInvoice', headerFk: 'invoiceId', baseType: 13, label: 'hóa đơn bán hàng', hasSapLineNum: true },
  { lineDelegate: 'salesReturnLine', headerDelegate: 'salesReturn', headerFk: 'returnId', baseType: 16, label: 'phiếu trả hàng bán', hasSapLineNum: true },
]

/** Lấy spec tra cứu theo tên delegate bảng dòng (dùng cho delivery: 2 FK riêng biệt) */
export function getSourceLineSpec(lineDelegate: SourceLineSpec['lineDelegate']): SourceLineSpec | undefined {
  return SOURCE_LINE_SPECS.find((s) => s.lineDelegate === lineDelegate)
}

/**
 * Ma trận dòng nguồn hợp lệ cho từng entity set đích (theo copy-from SAP B1):
 * - Orders       ← báo giá (23) — đơn tạo từ /api/orders/from-quotation
 * - Invoices     ← báo giá (23), đơn hàng (17), giao hàng (15)
 * - CreditNotes  ← hóa đơn (13), trả hàng (16)
 * - Returns      ← giao hàng (15), hóa đơn (13)
 * - DownPayments ← báo giá (23), đơn hàng (17)
 * - Quotations   = đầu luồng, không có nguồn
 * - DeliveryNotes không đẩy qua hàm resolveCopyFromBases này
 *   (qua sap-push-delivery — 2 FK riêng biệt: sourceOrderLineId/sourceQuotationLineId)
 */
const ENTITY_SOURCE_SPECS: Record<SapDocEntitySet, SourceLineSpec[]> = {
  Orders: [getSourceLineSpec('quotationLine')!],
  Quotations: [],
  DeliveryNotes: [],
  Invoices: [
    getSourceLineSpec('quotationLine')!,
    getSourceLineSpec('salesOrderLine')!,
    getSourceLineSpec('deliveryLine')!,
  ],
  CreditNotes: [getSourceLineSpec('arInvoiceLine')!, getSourceLineSpec('salesReturnLine')!],
  Returns: [getSourceLineSpec('deliveryLine')!, getSourceLineSpec('arInvoiceLine')!],
  DownPayments: [getSourceLineSpec('quotationLine')!, getSourceLineSpec('salesOrderLine')!],
}

/** Tên tiếng Việt của chứng từ đích (dùng trong câu lỗi chặn đẩy) */
const ENTITY_LABEL: Record<SapDocEntitySet, string> = {
  Orders: 'đơn hàng bán',
  Quotations: 'báo giá bán hàng',
  DeliveryNotes: 'phiếu giao hàng',
  Invoices: 'hóa đơn bán hàng',
  CreditNotes: 'phiếu ghi có phải thu',
  Returns: 'phiếu trả hàng bán',
  DownPayments: 'hóa đơn đặt cọc phải thu',
}

export type ResolveBaseResult = { ok: true; base: SapLineBase } | { ok: false; error: string }

/**
 * Quy đổi lineNum local (đếm từ 1) → LineNum trên SAP (đếm từ 0).
 * Chính xác vì mọi chứng từ được POST lên SAP theo đúng thứ tự lineNum
 * (đủ cả dòng con BOM), và dòng chỉ bị đánh số lại khi PATCH — lúc đó
 * sapLineNum đã được lưu lại từ response nên không đi qua hàm này.
 */
export function localLineToSapLineNum(lineNum: number): number {
  return Math.max(0, Number(lineNum) - 1)
}

/**
 * Dựng base từ bản ghi dòng nguồn ĐÃ tải (bước 2 của tra cứu).
 * KHÔNG ném exception — trả { ok:false } để caller CHẶN đẩy.
 */
async function baseFromSourceLine(
  spec: SourceLineSpec,
  line: any,
  targetLabel: string,
): Promise<ResolveBaseResult> {
  const header = await (prisma as any)[spec.headerDelegate].findUnique({
    where: { id: line[spec.headerFk] },
    select: { sapDocEntry: true, docNum: true },
  })
  // Nguồn chưa lên SAP (thiếu sapDocEntry) → CHẶN: đẩy lúc này sẽ tạo chứng
  // từ độc lập trên SAP, đơn nguồn vẫn còn OpenQty → giao/hóa đơn trùng.
  if (!header || typeof header.sapDocEntry !== 'number') {
    return {
      ok: false,
      error:
        `Không thể đẩy ${targetLabel}: ${spec.label} nguồn` +
        `${header?.docNum != null ? ` #${header.docNum}` : ''} chưa được đẩy lên SAP B1 ` +
        `(chưa có DocEntry). Hãy đẩy ${spec.label} nguồn lên SAP trước, rồi đẩy lại.`,
    }
  }
  // BaseLine = LineNum của dòng nguồn TRÊN SAP (đếm từ 0). Có sapLineNum (SAP
  // trả về khi đẩy/sửa) → dùng luôn; thiếu (DeliveryLine, chứng từ đẩy trước
  // khi có cột) → suy từ lineNum local (đếm từ 1). Phiếu giao hàng lưu dòng con
  // BOM ngay sau dòng cha — cùng vị trí SAP tự bung khi nhận dòng cha — nên
  // lineNum local vẫn khớp LineNum trên SAP.
  const baseLine =
    spec.hasSapLineNum && typeof line.sapLineNum === 'number'
      ? line.sapLineNum
      : localLineToSapLineNum(line.lineNum)
  return { ok: true, base: { baseType: spec.baseType, baseEntry: header.sapDocEntry, baseLine } }
}

/**
 * Tra cứu 1 dòng nguồn trong DB → BaseType/BaseEntry/BaseLine.
 * KHÔNG ném exception. Trả { ok:false } khi:
 * - không tìm thấy dòng nguồn (id lạ / không thuộc loại nguồn hợp lệ), hoặc
 * - chứng từ nguồn CHƯA được đẩy lên SAP (thiếu sapDocEntry) → caller phải
 *   CHẶN đẩy (không được lặng lẽ bỏ qua, sẽ lệch OpenQty trên SAP).
 */
export async function resolveSourceLineBase(
  spec: SourceLineSpec,
  sourceLineId: string,
  targetLabel: string,
): Promise<ResolveBaseResult> {
  const line = await (prisma as any)[spec.lineDelegate].findUnique({ where: { id: sourceLineId } })
  if (!line) {
    return {
      ok: false,
      error: `Không tìm thấy dòng ${spec.label} nguồn (id ${sourceLineId}) — chưa đẩy ${targetLabel} để tránh lệch liên kết trên SAP B1.`,
    }
  }
  return baseFromSourceLine(spec, line, targetLabel)
}

export type ResolveBasesResult = { ok: true; bases: (SapLineBase | null)[] } | { ok: false; error: string }

/**
 * Tra BaseType/BaseEntry/BaseLine cho mọi dòng có sourceLineId của 1 chứng từ
 * sắp đẩy. Dòng không có sourceLineId → base null (chứng từ độc lập, giữ nguyên).
 * Dừng và trả { ok:false } ngay khi gặp dòng nguồn không tra được — caller CHẶN đẩy.
 */
export async function resolveCopyFromBases(
  entitySet: SapDocEntitySet,
  lines: Array<{ sourceLineId?: string | null }>,
  targetLabel?: string,
): Promise<ResolveBasesResult> {
  const label = targetLabel ?? ENTITY_LABEL[entitySet] ?? entitySet
  const specs = ENTITY_SOURCE_SPECS[entitySet] ?? []
  const bases: (SapLineBase | null)[] = []
  for (const l of lines) {
    const srcId = (l?.sourceLineId ?? '').trim()
    if (!srcId) {
      bases.push(null)
      continue
    }
    // id dòng là cuid global-unique → chỉ 1 bảng nguồn chứa nó
    let done: ResolveBaseResult | null = null
    for (const spec of specs) {
      const line = await (prisma as any)[spec.lineDelegate].findUnique({ where: { id: srcId } })
      if (line) {
        done = await baseFromSourceLine(spec, line, label)
        break
      }
    }
    if (!done) {
      return {
        ok: false,
        error: `Không tìm thấy dòng chứng từ nguồn (id ${srcId}) trong các loại nguồn hợp lệ của ${label} — chưa đẩy để tránh lệch liên kết trên SAP B1.`,
      }
    }
    if (!done.ok) return done
    bases.push(done.base)
  }
  return { ok: true, bases }
}

/** Chuẩn hóa ngày thành YYYY-MM-DD cho các trường Date của SAP (TaxDate, ReqDate) */
const isoDateOnly = (v: string | Date | null | undefined): string | undefined => {
  if (!v) return undefined
  if (typeof v === 'string') {
    const s = v.slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined
  }
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return undefined
  const y = v.getUTCFullYear()
  const m = String(v.getUTCMonth() + 1).padStart(2, '0')
  const d = String(v.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Dựng các trường header SAP B1 mở rộng (Đợt 2+3) — chỉ gửi khi CÓ GIÁ TRỊ.
 * Dùng chung cho mọi entity set chứng từ (buildSapDocPayload) và Delivery
 * (sap-push-delivery) để hành vi nhất quán.
 */
export function sapDocHeaderExtras(input: SapDocHeaderExtras): Record<string, unknown> {
  const currency = (input.docCurrency ?? '').trim().toUpperCase()
  const taxDate = isoDateOnly(input.taxDate)
  const reqDate = isoDateOnly(input.reqDate)
  return {
    ...(typeof input.salesPersonCode === 'number' ? { SalesPersonCode: input.salesPersonCode } : {}),
    ...(typeof input.paymentGroupCode === 'number' ? { PaymentGroupCode: input.paymentGroupCode } : {}),
    ...(input.shipToCode?.trim() ? { ShipToCode: input.shipToCode.trim() } : {}),
    ...(input.billToCode?.trim() ? { BillToCode: input.billToCode.trim() } : {}),
    ...(typeof input.contactPersonCode === 'number' ? { ContactPersonCode: input.contactPersonCode } : {}),
    ...(input.numAtCard?.trim() ? { NumAtCard: input.numAtCard.trim().slice(0, 100) } : {}),
    ...(taxDate ? { TaxDate: taxDate } : {}),
    // DocCurrency + DocRate: CHỈ gửi khi tiền tệ khác VND — tiền VND để SAP
    // dùng mặc định của hệ thống (tránh ép sai tỷ giá).
    ...(currency && currency !== 'VND'
      ? {
          DocCurrency: currency,
          ...(typeof input.docRate === 'number' && input.docRate > 0 ? { DocRate: input.docRate } : {}),
        }
      : {}),
    ...(input.projectCode?.trim() ? { ProjectCode: input.projectCode.trim() } : {}),
    ...(reqDate ? { ReqDate: reqDate } : {}),
  }
}

/**
 * Lấy các trường header mở rộng từ bản ghi chứng từ local (Prisma) để truyền
 * vào push/PATCH — dùng chung cho mọi luồng (tạo/finalize/đẩy lại/sửa) để
 * không luồng nào bỏ sót trường nào.
 */
export function headerExtrasFromRecord(r: {
  salesPersonCode?: number | null
  paymentGroupCode?: number | null
  shipToCode?: string | null
  billToCode?: string | null
  contactPersonCode?: number | null
  numAtCard?: string | null
  taxDate?: Date | string | null
  docCurrency?: string | null
  docRate?: number | null
  projectCode?: string | null
  reqDate?: Date | string | null
}): SapDocHeaderExtras {
  return {
    salesPersonCode: r.salesPersonCode ?? null,
    paymentGroupCode: r.paymentGroupCode ?? null,
    shipToCode: r.shipToCode ?? null,
    billToCode: r.billToCode ?? null,
    contactPersonCode: r.contactPersonCode ?? null,
    numAtCard: r.numAtCard ?? null,
    taxDate: r.taxDate ?? null,
    docCurrency: r.docCurrency ?? null,
    docRate: r.docRate ?? null,
    projectCode: r.projectCode ?? null,
    reqDate: r.reqDate ?? null,
  }
}

/** Dựng payload DocumentLines (dùng chung cho POST tạo mới và PATCH sửa) */
export function buildSapLines(
  lines: SapPushLine[],
  dbLineNums?: (number | null)[],
  bases?: (SapLineBase | null | undefined)[],
  invoiceDocType?: 'Item' | 'Service' | 'Reserve',
) {
  // Hóa đơn dịch vụ (SAP: Documents.DocType = dDocument_Service): dòng là
  // dòng dịch vụ — chuẩn SAP B1 bắt buộc dùng AccountCode, không dùng ItemCode.
  const isServiceDoc = invoiceDocType === 'Service'
  const tplGroups = templateBomGroups(lines)
  return lines.map((l, i) => {
    const ln = dbLineNums?.[i]
    const b = bases?.[i]
    const acct = (l.accountCode ?? '').toString().trim()
    const tplParent = l.bomGroupKey ? tplGroups.get(l.bomGroupKey) : undefined
    const isTplChild = !!tplParent && !!l.isBomChild
    return {
      ...(typeof ln === 'number' ? { LineNum: ln } : {}),
      // Copy-from: liên kết dòng với chứng từ/dòng nguồn trên SAP
      // (BaseType/BaseEntry/BaseLine) — SAP tự trừ OpenQty của nguồn.
      ...(b ? { BaseType: b.baseType, BaseEntry: b.baseEntry, BaseLine: b.baseLine } : {}),
      // Dòng dịch vụ gửi AccountCode thay vì ItemCode (chuẩn SAP B1).
      // Dòng cha BOM Template ĐÃ có trên SAP: không gửi lại ItemCode — đặt lại
      // mã mặt hàng cha có thể làm SAP bung công thức thêm lần nữa.
      ...(isServiceDoc ? { AccountCode: acct } : typeof ln === 'number' && tplParent && !l.isBomChild ? {} : { ItemCode: l.itemCode }),
      Quantity: l.quantity,
      // Đơn vị tính: chỉ gửi khi có giá trị — rỗng thì SAP dùng mặc định của mặt hàng
      ...(l.uom?.trim() ? { MeasureUnit: l.uom.trim() } : {}),
      UnitPrice: isTplChild ? 0 : l.unitPrice,
      DiscountPercent: isTplChild ? 0 : Number(l.discPct) || 0,
      // BOM Template: con mang mã BOM cha
      ...(isTplChild ? { [UDF_BOM_ID]: tplParent } : {}),
      ...(l.taxCode ? { VatGroup: l.taxCode } : {}),
      ...(l.warehouseCode?.trim() ? { WarehouseCode: l.warehouseCode.trim() } : {}),
      // Lô hàng (SAP: DocumentLines.BatchNumbers) — chỉ dòng có batchNumber
      ...(l.batchNumber?.trim() ? { BatchNumbers: [{ BatchNumber: l.batchNumber.trim() }] } : {}),
    }
  })
}

/** Dựng payload POST theo cấu trúc Document SAP B1 (OData v2) — mọi loại chứng từ đều dùng cấu trúc này */
export function buildSapDocPayload(
  input: SapPushInput,
  withUdf = false,
  lineBases?: (SapLineBase | null | undefined)[],
) {
  return {
    CardCode: input.cardCode,
    DocDate: onlyDate(input.docDate),
    DocDueDate: onlyDate(input.docDueDate),
    ...(input.comments?.trim() ? { Comments: input.comments.trim().slice(0, 254) } : {}),
    // CK đầu chứng từ: LUÔN gửi (kể cả 0) — sửa chứng từ về 0 phải xóa được CK cũ trên SAP
    DiscountPercent: Math.min(100, Math.max(0, Number(input.headerDiscPct) || 0)),
    // Header mở rộng Đợt 2+3 (SalesPersonCode, PaymentGroupCode, ShipToCode,
    // BillToCode, ContactPersonCode, NumAtCard, TaxDate, DocCurrency+DocRate, ProjectCode, ReqDate)
    // — chỉ gửi khi có giá trị
    ...sapDocHeaderExtras(input),
    // Hóa đơn dịch vụ / hóa đơn dự trữ (Phase 2)
    ...(input.invoiceDocType === 'Service' ? { DocType: 'dDocument_Service' } : {}),
    ...(input.invoiceDocType === 'Reserve' ? { ReserveInvoice: 'tYES' } : {}),
    // Khấu trừ đặt cọc dần (Phase 2) — chỉ các đặt cọc đã có DocEntry trên SAP
    ...(input.draws?.length
      ? {
          DownPaymentsToDraw: input.draws.map((d) => ({
            DocEntry: d.downPaymentDocEntry,
            AmountToDraw: d.drawAmount,
            DownPaymentType: 'dptInvoice',
          })),
        }
      : {}),
    // Marker idempotency — chỉ gắn khi SAP đã định nghĩa UDF này
    ...(withUdf && input.localId ? { [UDF_LOCAL_ID]: input.localId } : {}),
    DocumentLines: buildSapLines(input.lines, undefined, lineBases, input.invoiceDocType),
  }
}

/** Tên UDF dùng làm marker idempotency trên chứng từ SAP */
export const UDF_LOCAL_ID = 'U_FM_LocalId'

interface SapDocLookup {
  value?: Array<{ DocEntry?: number; DocNum?: number }>
}

/**
 * Tìm chứng từ SAP đã có marker localId.
 * Trả { supported: false } khi SAP chưa định nghĩa UDF (lỗi $filter) —
 * caller sẽ POST như bình thường, không gắn UDF.
 */
async function findDocByLocalId(
  settings: SapConfig,
  entitySet: SapDocEntitySet,
  localId: string,
): Promise<{ supported: boolean; doc?: { DocEntry: number; DocNum?: number }; lookupError?: string }> {
  const safe = localId.replace(/'/g, "''")
  const res = await sapGet<SapDocLookup>(
    settings,
    `/${entitySet}`,
    { $filter: `${UDF_LOCAL_ID} eq '${safe}'`, $select: 'DocEntry,DocNum' },
    { audit: 'off' },
  )
  // M1: phân biệt "UDF chưa định nghĩa" (an toàn POST) vs "lookup lỗi thoáng qua"
  // (KHÔNG an toàn — chứng từ có thể đã tồn tại, POST sẽ gây trùng).
  if (!res.ok || !res.data) {
    const msg = res.error ?? 'lỗi không rõ'
    // UDF chưa định nghĩa → SAP trả 400 với thông báo cụ thể
    if (/UDF|invalid|not.*defin|unknown/i.test(msg)) return { supported: false }
    return { supported: false, lookupError: msg }
  }
  const first = res.data.value?.[0]
  if (typeof first?.DocEntry !== 'number') return { supported: true }
  return { supported: true, doc: { DocEntry: first.DocEntry, DocNum: first.DocNum } }
}

/**
 * Kiểm tra (CHỈ ĐỌC) DB SAP đã định nghĩa UDF U_FM_LocalId trên chứng từ chưa:
 * thử $filter theo một localId không tồn tại. KHÔNG tạo UDF.
 */
export async function checkLocalIdUdf(
  settings: SapConfig,
  entitySet: SapDocEntitySet = 'Orders',
): Promise<{ supported: boolean; error?: string }> {
  const r = await findDocByLocalId(settings, entitySet, '__fm_udf_probe__')
  return r.lookupError ? { supported: false, error: r.lookupError } : { supported: r.supported }
}

/** Đọc LineNum của các dòng từ response POST/PATCH (mảng trực tiếp hoặc {results}) */
function extractLineNums(res: SapDocResponse | undefined): number[] | undefined {
  if (!res?.DocumentLines) return undefined
  const raw = Array.isArray(res.DocumentLines) ? res.DocumentLines : res.DocumentLines.results ?? []
  const nums = raw.map((l) => (typeof l?.LineNum === 'number' ? l.LineNum : NaN)).filter((x) => Number.isFinite(x))
  return nums.length > 0 ? nums : undefined
}

/**
 * Đẩy chứng từ bán hàng sang SAP B1. KHÔNG bao giờ ném exception — luôn trả về
 * SapPushResult để luồng lưu local không bao giờ bị chặn bởi SAP.
 */
export async function pushDocumentToSap(input: SapPushDocumentInput): Promise<SapPushResult> {
  // Phase 2: chứng từ nháp KHÔNG bao giờ đẩy sang SAP (guard ở tầng push)
  if (input.isDraft) return { status: 'none' }

  const settings = await loadSapSettings(input.databaseId)
  if (!isSapConfigured(settings)) return { status: 'none' }

  // BOM Template: bước 1 gửi cả dòng cha + dòng con người dùng (giá 0, U_BOMID);
  // SAP vẫn chèn định mức gốc sau cha → bước 2 (reconcileTemplateBoms) xoá khối đó.
  const fresh = freshTemplateGroups(input.lines)
  const postIdx = input.lines.map((_, i) => i)
  // Con Template không liên kết dòng nguồn (giữ như trước: chỉ cha mang BaseLine)
  const postLines = input.lines.map((l) => (isFreshTplChild(l, fresh) ? { ...l, sourceLineId: null } : l))

  // Idempotency: trước khi POST, kiểm tra SAP đã có chứng từ mang marker
  // localId chưa — tránh tạo trùng khi retry sau timeout/response mất.
  // Nếu SAP chưa định nghĩa UDF → bỏ qua, giữ nguyên hành vi cũ.
  let withUdf = false
  if (input.localId) {
    const existing = await findDocByLocalId(settings, input.entitySet, input.localId)
    if (existing.lookupError) {
      // M1: lookup lỗi thoáng qua → KHÔNG POST (tránh trùng chứng từ),
      // trả lỗi để user retry sau.
      return {
        status: 'error',
        errorKind: 'safe',
        error: `Không kiểm tra được trùng chứng từ trên SAP (${existing.lookupError}) — chưa đẩy để tránh tạo trùng. Vui lòng thử lại.`,
      }
    }
    if (existing.supported && existing.doc) {
      // Chứng từ đã tồn tại → nhận lại, KHÔNG POST nữa. Có BOM Template: lần
      // trước có thể mới xong bước 1 (SAP đã bung định mức gốc) → áp tiếp bước 2.
      if (fresh.size > 0) {
        const rec = await reconcileTemplateBoms(settings, input.entitySet, existing.doc.DocEntry, input.lines, postIdx)
        if (!rec.ok) return { status: 'pending', errorKind: 'safe', udf: true, error: rec.error }
        return { status: 'synced', udf: true, docEntry: existing.doc.DocEntry, docNum: existing.doc.DocNum, lineNums: rec.lineNums }
      }
      const full = await sapGet<SapDocResponse>(
        settings,
        `/${input.entitySet}(${existing.doc.DocEntry})`,
        { $select: 'DocEntry,DocNum,DocumentLines' },
        { audit: 'off' },
      )
      return {
        status: 'synced',
        udf: true,
        docEntry: existing.doc.DocEntry,
        docNum: existing.doc.DocNum,
        lineNums: extractLineNums(full.ok ? full.data : undefined),
      }
    }
    withUdf = existing.supported
  }

  // Copy-from: tra BaseType/BaseEntry/BaseLine cho các dòng có sourceLineId.
  // Nguồn chưa lên SAP (thiếu sapDocEntry) → CHẶN đẩy, trả lỗi rõ ràng
  // (không lặng lẽ bỏ qua — sẽ lệch OpenQty trên SAP).
  const baseRes = await resolveCopyFromBases(input.entitySet, postLines)
  if (!baseRes.ok) {
    return { status: 'error', blocked: true, errorKind: 'business', error: baseRes.error }
  }

  const payload = buildSapDocPayload({ ...input, lines: postLines }, withUdf, baseRes.bases)
  const res = await sapPost<SapDocResponse>(settings, `/${input.entitySet}`, payload)
  if (!res.ok) {
    return {
      status: 'pending',
      errorKind: withMarker(classifySapPostFailure(res), withUdf),
      udf: withUdf,
      error: res.error ?? `Lỗi không xác định (HTTP ${res.status})`,
    }
  }
  if (fresh.size > 0) {
    const docEntry = res.data?.DocEntry
    const docNum = typeof res.data?.DocNum === 'number' ? res.data.DocNum : undefined
    if (typeof docEntry !== 'number') {
      // POST đã thành công → chứng từ có thể đã tạo: chỉ tự thử lại khi có UDF tra lại được
      return { status: 'pending', errorKind: withMarker('unknown', withUdf), udf: withUdf, error: 'SAP không trả về DocEntry — sẽ thử đẩy lại' }
    }
    const created = res.data?.DocumentLines
    const sapLines = (Array.isArray(created) ? created : created?.results ?? []) as SapDocLine[]
    const rec = await reconcileTemplateBoms(settings, input.entitySet, docEntry, input.lines, postIdx, sapLines)
    if (!rec.ok) {
      // Có marker localId → "Đẩy lại" sẽ nhận lại chứng từ này và áp tiếp bước 2.
      // Không có marker → KHÔNG để pending (đẩy lại sẽ tạo trùng chứng từ): ghi
      // nhận đã tạo kèm cảnh báo để sửa định mức trực tiếp trên SAP.
      return withUdf
        ? { status: 'pending', errorKind: 'safe', udf: true, error: rec.error }
        : { status: 'synced', udf: false, docEntry, docNum, error: `${rec.error} — chứng từ đã tạo trên SAP với định mức gốc, cần sửa trực tiếp trên SAP B1.` }
    }
    return { status: 'synced', udf: withUdf, docEntry, docNum, lineNums: rec.lineNums }
  }
  return {
    status: 'synced',
    udf: withUdf,
    docEntry: typeof res.data?.DocEntry === 'number' ? res.data.DocEntry : undefined,
    docNum: typeof res.data?.DocNum === 'number' ? res.data.DocNum : undefined,
    lineNums: extractLineNums(res.data),
  }
}

/**
 * Sửa chứng từ bán hàng đang Open trên SAP B1 (PATCH /{EntitySet}(DocEntry)).
 * KHÔNG bao giờ ném exception. Trả về status 'synced' (OK) hoặc 'error'.
 */
export async function patchDocumentToSap(settings: SapConfig, input: SapPatchDocumentInput): Promise<SapPushResult> {
  // Nhóm BOM Template MỚI thêm khi sửa: bước 1 gửi cả cha + con người dùng,
  // bước 2 xoá khối định mức gốc SAP vừa bung sau cha.
  const fresh = freshTemplateGroups(input.lines)
  const sendIdx = input.lines.map((_, i) => i)
  const sendLines = input.lines
  const payload = {
    ...(input.cardCode ? { CardCode: input.cardCode } : {}),
    ...(input.docDate ? { DocDate: onlyDate(input.docDate) } : {}),
    ...(input.docDueDate ? { DocDueDate: onlyDate(input.docDueDate) } : {}),
    ...(input.comments?.trim() ? { Comments: input.comments.trim().slice(0, 254) } : {}),
    // CK đầu chứng từ: LUÔN gửi (kể cả 0) — sửa về 0 phải xóa được CK cũ trên SAP
    DiscountPercent: Math.min(100, Math.max(0, Number(input.headerDiscPct) || 0)),
    ...sapDocHeaderExtras({
      shipToCode: input.shipToCode,
      billToCode: input.billToCode,
      contactPersonCode: input.contactPersonCode,
    }),
    DocumentLines: buildSapLines(
      sendLines,
      sendLines.map((l) => (typeof l.lineNum === 'number' ? l.lineNum : null)),
      undefined,
      input.invoiceDocType,
    ),
  }
  const res = await sapPatch<SapDocResponse>(settings, `/${input.entitySet}(${input.docEntry})`, payload)
  if (!res.ok) {
    return { status: 'error', error: res.error ?? `Lỗi không xác định (HTTP ${res.status})` }
  }
  if (fresh.size > 0) {
    // Thứ tự LineNum trên SAP sau bước 1: dòng cũ (theo LineNum) rồi dòng mới theo thứ tự gửi
    const posted = [
      ...sendIdx.filter((i) => typeof input.lines[i].lineNum === 'number')
        .sort((a, b) => (input.lines[a].lineNum as number) - (input.lines[b].lineNum as number)),
      ...sendIdx.filter((i) => typeof input.lines[i].lineNum !== 'number'),
    ]
    const rec = await reconcileTemplateBoms(settings, input.entitySet, input.docEntry, input.lines, posted)
    if (!rec.ok) return { status: 'error', docEntry: input.docEntry, error: rec.error }
    return { status: 'synced', docEntry: input.docEntry, lineNums: rec.lineNums }
  }
  return {
    status: 'synced',
    docEntry: input.docEntry,
    docNum: typeof res.data?.DocNum === 'number' ? res.data.DocNum : undefined,
    lineNums: extractLineNums(res.data),
  }
}
