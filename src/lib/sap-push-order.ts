// ============================================================
// ĐẨY SALE ORDER SANG SAP B1 (POST /Orders → bảng ORDR/RDR1)
// Quy tắc: 
//  - Chưa cấu hình Service Layer → status 'none' (đơn chỉ lưu local)
//  - Đẩy thành công → 'synced' + lưu DocEntry/DocNum do SAP cấp
//  - Đẩy thất bại  → 'pending' + lưu thông báo lỗi (đơn vẫn lưu local,
//                     có thể bấm "Đẩy lại" trong danh sách đơn hàng)
// ============================================================

import { loadSapSettings, isSapConfigured, sapGet, sapPost, sapPatch, type SapConfig } from './sap-service-layer'

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
  cardCode: string
  /** YYYY-MM-DD hoặc ISO datetime — chuẩn hóa thành YYYY-MM-DD trước khi gửi */
  docDate: string
  docDueDate: string
  /** Ghi chú → Comments của SAP (tối đa 254 ký tự) */
  comments?: string | null
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
  headerDiscPct?: number
  lines: SapPushLine[]
  /**
   * Id đơn local — dùng cho idempotency khi đẩy sang SAP.
   * Nếu SAP đã định nghĩa UDF U_FM_LocalId: trước khi POST sẽ kiểm tra
   * chứng từ có UDF này chưa (tránh trùng khi retry sau timeout), và gắn
   * UDF vào payload POST. Nếu SAP chưa có UDF → bỏ qua, giữ nguyên
   * hành vi cũ (không làm hỏng đẩy đơn hiện tại).
   */
  localId?: string
}

export interface SapPushResult {
  /** none = chưa cấu hình SAP; pending = lỗi, thử lại sau; synced = OK; error = PATCH bị SL từ chối */
  status: 'none' | 'pending' | 'synced' | 'error'
  docEntry?: number
  docNum?: number
  error?: string
  /** LineNum do SAP cấp cho từng dòng (theo thứ tự dòng đẩy) — cần khi SỬA đơn (PATCH) */
  lineNums?: number[]
}

interface SapOrderResponse {
  DocEntry?: number
  DocNum?: number
  DocumentLines?: { LineNum?: number }[] | { results?: { LineNum?: number }[] }
}

const onlyDate = (d: string) => (d || '').slice(0, 10)

/** Dựng payload DocumentLines (dùng chung cho POST tạo mới và PATCH sửa đơn) */
function buildSapLines(lines: SapPushLine[], dbLineNums?: (number | null)[]) {
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

/** Dựng payload POST /Orders theo cấu trúc Document SAP B1 (OData v2) */
export function buildSapOrderPayload(input: SapPushInput, withUdf = false) {
  return {
    CardCode: input.cardCode,
    DocDate: onlyDate(input.docDate),
    DocDueDate: onlyDate(input.docDueDate),
    ...(input.comments?.trim() ? { Comments: input.comments.trim().slice(0, 254) } : {}),
    // CK đầu chứng từ: LUÔN gửi (kể cả 0) — sửa đơn về 0 phải xóa được CK cũ trên SAP
    DiscountPercent: Math.min(100, Math.max(0, Number(input.headerDiscPct) || 0)),
    // Marker idempotency — chỉ gắn khi SAP đã định nghĩa UDF này
    ...(withUdf && input.localId ? { [UDF_LOCAL_ID]: input.localId } : {}),
    DocumentLines: buildSapLines(input.lines),
  }
}

/** Tên UDF dùng làm marker idempotency trên chứng từ SAP */
export const UDF_LOCAL_ID = 'U_FM_LocalId'

interface SapOrderLookup {
  value?: Array<{ DocEntry?: number; DocNum?: number }>
}

/**
 * Tìm chứng từ SAP đã có marker localId.
 * Trả { supported: false } khi SAP chưa định nghĩa UDF (lỗi $filter) —
 * caller sẽ POST như bình thường, không gắn UDF.
 */
async function findOrderByLocalId(
  settings: SapConfig,
  localId: string,
): Promise<{ supported: boolean; doc?: { DocEntry: number; DocNum?: number } }> {
  const safe = localId.replace(/'/g, "''")
  const res = await sapGet<SapOrderLookup>(
    settings,
    '/Orders',
    { $filter: `${UDF_LOCAL_ID} eq '${safe}'`, $select: 'DocEntry,DocNum' },
    { audit: 'off' },
  )
  if (!res.ok || !res.data) return { supported: false }
  const first = res.data.value?.[0]
  if (typeof first?.DocEntry !== 'number') return { supported: true }
  return { supported: true, doc: { DocEntry: first.DocEntry, DocNum: first.DocNum } }
}

/** Đọc LineNum của các dòng từ response POST/PATCH (mảng trực tiếp hoặc {results}) */
function extractLineNums(res: SapOrderResponse | undefined): number[] | undefined {
  if (!res?.DocumentLines) return undefined
  const raw = Array.isArray(res.DocumentLines) ? res.DocumentLines : res.DocumentLines.results ?? []
  const nums = raw.map((l) => (typeof l?.LineNum === 'number' ? l.LineNum : NaN)).filter((x) => Number.isFinite(x))
  return nums.length > 0 ? nums : undefined
}

/**
 * Đẩy đơn hàng sang SAP B1. KHÔNG bao giờ ném exception — luôn trả về
 * SapPushResult để luồng lưu đơn local không bao giờ bị chặn bởi SAP.
 */
export async function pushOrderToSap(input: SapPushInput): Promise<SapPushResult> {
  const settings = await loadSapSettings()
  if (!isSapConfigured(settings)) return { status: 'none' }

  // Idempotency: trước khi POST, kiểm tra SAP đã có chứng từ mang marker
  // localId chưa — tránh tạo trùng khi retry sau timeout/response mất.
  // Nếu SAP chưa định nghĩa UDF → bỏ qua, giữ nguyên hành vi cũ.
  let withUdf = false
  if (input.localId) {
    const existing = await findOrderByLocalId(settings, input.localId)
    if (existing.supported && existing.doc) {
      // Chứng từ đã tồn tại → nhận lại, KHÔNG POST nữa
      const full = await sapGet<SapOrderResponse>(
        settings,
        `/Orders(${existing.doc.DocEntry})`,
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

  const payload = buildSapOrderPayload(input, withUdf)
  const res = await sapPost<SapOrderResponse>(settings, '/Orders', payload)
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

/** Đầu vào cho PATCH /Orders(DocEntry) — sửa chứng từ đang Open */
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

/**
 * Sửa chứng từ Sale Order đang Open trên SAP B1 (PATCH /Orders(DocEntry)).
 * KHÔNG bao giờ ném exception. Trả về status 'synced' (OK) hoặc 'error'.
 */
export async function patchOrderToSap(settings: SapConfig, input: SapPatchInput): Promise<SapPushResult> {
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
  const res = await sapPatch<SapOrderResponse>(settings, `/Orders(${input.docEntry})`, payload)
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
