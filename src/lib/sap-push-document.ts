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
}

export interface SapPushInput {
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
}

/** Đầu vào cho PATCH — sửa chứng từ đang Open */
export interface SapPatchInput {
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

/** Dựng payload DocumentLines (dùng chung cho POST tạo mới và PATCH sửa) */
export function buildSapLines(lines: SapPushLine[], dbLineNums?: (number | null)[]) {
  return lines.map((l, i) => {
    const ln = dbLineNums?.[i]
    return {
      ...(typeof ln === 'number' ? { LineNum: ln } : {}),
      ItemCode: l.itemCode,
      Quantity: l.quantity,
      UnitPrice: l.unitPrice,
      DiscountPercent: Number(l.discPct) || 0,
      ...(l.taxCode ? { VatGroup: l.taxCode } : {}),
      ...(l.warehouseCode?.trim() ? { WarehouseCode: l.warehouseCode.trim() } : {}),
    }
  })
}

/** Dựng payload POST theo cấu trúc Document SAP B1 (OData v2) — mọi loại chứng từ đều dùng cấu trúc này */
export function buildSapDocPayload(input: SapPushInput, withUdf = false) {
  return {
    CardCode: input.cardCode,
    DocDate: onlyDate(input.docDate),
    DocDueDate: onlyDate(input.docDueDate),
    ...(input.comments?.trim() ? { Comments: input.comments.trim().slice(0, 254) } : {}),
    // CK đầu chứng từ: LUÔN gửi (kể cả 0) — sửa chứng từ về 0 phải xóa được CK cũ trên SAP
    DiscountPercent: Math.min(100, Math.max(0, Number(input.headerDiscPct) || 0)),
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
    DocumentLines: buildSapLines(input.lines),
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
        error: `Không kiểm tra được trùng chứng từ trên SAP (${existing.lookupError}) — chưa đẩy để tránh tạo trùng. Vui lòng thử lại.`,
      }
    }
    if (existing.supported && existing.doc) {
      // Chứng từ đã tồn tại → nhận lại, KHÔNG POST nữa
      const full = await sapGet<SapDocResponse>(
        settings,
        `/${input.entitySet}(${existing.doc.DocEntry})`,
        { $select: 'DocEntry,DocNum,DocumentLines' },
        { audit: 'off' },
      )
      return {
        status: 'synced',
        docEntry: existing.doc.DocEntry,
        docNum: existing.doc.DocNum,
        lineNums: extractLineNums(full.ok ? full.data : undefined),
      }
    }
    withUdf = existing.supported
  }

  const payload = buildSapDocPayload(input, withUdf)
  const res = await sapPost<SapDocResponse>(settings, `/${input.entitySet}`, payload)
  if (!res.ok) {
    return { status: 'pending', error: res.error ?? `Lỗi không xác định (HTTP ${res.status})` }
  }
  return {
    status: 'synced',
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
  const payload = {
    ...(input.cardCode ? { CardCode: input.cardCode } : {}),
    ...(input.docDate ? { DocDate: onlyDate(input.docDate) } : {}),
    ...(input.docDueDate ? { DocDueDate: onlyDate(input.docDueDate) } : {}),
    ...(input.comments?.trim() ? { Comments: input.comments.trim().slice(0, 254) } : {}),
    // CK đầu chứng từ: LUÔN gửi (kể cả 0) — sửa về 0 phải xóa được CK cũ trên SAP
    DiscountPercent: Math.min(100, Math.max(0, Number(input.headerDiscPct) || 0)),
    DocumentLines: buildSapLines(
      input.lines,
      input.lines.map((l) => (typeof l.lineNum === 'number' ? l.lineNum : null)),
    ),
  }
  const res = await sapPatch<SapDocResponse>(settings, `/${input.entitySet}(${input.docEntry})`, payload)
  if (!res.ok) {
    return { status: 'error', error: res.error ?? `Lỗi không xác định (HTTP ${res.status})` }
  }
  return {
    status: 'synced',
    docEntry: input.docEntry,
    docNum: typeof res.data?.DocNum === 'number' ? res.data.DocNum : undefined,
    lineNums: extractLineNums(res.data),
  }
}
