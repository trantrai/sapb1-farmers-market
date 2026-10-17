// ============================================================
// ĐẨY DELIVERY SANG SAP B1 (POST /DeliveryNotes → bảng ODLN/DLN1)
// Quy tắc:
//  - Chưa cấu hình Service Layer → status 'none' (chỉ lưu local)
//  - Đẩy thành công → 'synced' + lưu DocEntry/DocNum do SAP cấp
//  - Đẩy thất bại  → 'pending' + lưu thông báo lỗi (có thể "Đẩy lại")
// ============================================================

import { loadSapSettings, isSapConfigured, sapGet, sapPost, type SapConfig } from './sap-service-layer'
import { UDF_LOCAL_ID } from './sap-push-order'
import {
  getSourceLineSpec,
  resolveSourceLineBase,
  sapDocHeaderExtras,
  type SapLineBase,
  type SapDocHeaderExtras,
} from './sap-push-document'

export interface SapDeliveryLine {
  itemCode: string
  quantity: number
  unitPrice: number
  /** Mã nhóm thuế SAP (VatGroup) */
  taxCode?: string | null
  /** Chiết khấu % của dòng (SAP: DiscountPercent) */
  discPct?: number | null
  warehouseCode?: string | null
  /** Đơn vị tính của dòng (SAP: MeasureUnit) — rỗng thì bỏ qua, SAP dùng mặc định của mặt hàng */
  uom?: string | null
  /**
   * Local id dòng đơn hàng nguồn (DeliveryLine.sourceOrderLineId).
   * Khi đẩy sẽ tra thành BaseType=17/BaseEntry/BaseLine; nguồn chưa lên
   * SAP → CHẶN đẩy.
   */
  sourceOrderLineId?: string | null
  /**
   * Local id dòng báo giá nguồn (DeliveryLine.sourceQuotationLineId).
   * Khi đẩy sẽ tra thành BaseType=23/BaseEntry/BaseLine; nguồn chưa lên
   * SAP → CHẶN đẩy.
   */
  sourceQuotationLineId?: string | null
  /**
   * Số lô của dòng (Đợt 2+3) — khi có giá trị, payload gửi
   * DocumentLines.BatchNumbers = [{ BatchNumber }]; trống → bỏ qua.
   */
  batchNumber?: string | null
}

export interface SapDeliveryInput extends SapDocHeaderExtras {
  /** Id SapDatabase đích */
  databaseId?: string | null
  cardCode: string
  docDate: string
  comments?: string | null
  /** Kho xuất hàng header (SAP DeliveryNotes.WarehouseCode) — rỗng = để SAP mặc định */
  warehouseCode?: string | null
  /**
   * CK đầu phiếu % (Đợt 2+3 — Delivery đã có headerDiscPct trên DB):
   * LUÔN gửi (kể cả 0), theo cùng quy tắc với buildSapDocPayload.
   */
  headerDiscPct?: number
  /** Ghi chú soạn/đóng gói (Đợt 2+3 — SAP DeliveryNotes.PickAndPackNotes) */
  pickAndPackNotes?: string | null
  lines: SapDeliveryLine[]
  /** Id delivery local — idempotency qua UDF U_FM_LocalId */
  localId?: string
}

export interface SapDeliveryResult {
  status: 'none' | 'pending' | 'synced' | 'error'
  docEntry?: number
  docNum?: number
  error?: string
  /**
   * true = bị CHẶN ở tầng validate trước khi đẩy (dòng nguồn của copy-from
   * chưa lên SAP). Route nên trả HTTP 400 thay vì 502.
   */
  blocked?: boolean
}

const onlyDate = (d: string) => (d || '').slice(0, 10)

function buildPayload(input: SapDeliveryInput, withUdf = false, bases?: (SapLineBase | null | undefined)[]) {
  return {
    CardCode: input.cardCode,
    DocDate: onlyDate(input.docDate),
    ...(input.comments?.trim() ? { Comments: input.comments.trim().slice(0, 254) } : {}),
    ...(input.warehouseCode?.trim() ? { WarehouseCode: input.warehouseCode.trim() } : {}),
    // CK đầu phiếu: LUÔN gửi (kể cả 0) — đồng bộ quy tắc với chứng từ bán hàng
    DiscountPercent: Math.min(100, Math.max(0, Number(input.headerDiscPct) || 0)),
    // Ghi chú soạn/đóng gói (Đợt 2+3)
    ...(input.pickAndPackNotes?.trim() ? { PickAndPackNotes: input.pickAndPackNotes.trim().slice(0, 254) } : {}),
    // Header mở rộng Đợt 2+3 (SalesPersonCode, PaymentGroupCode, ShipToCode,
    // BillToCode, NumAtCard, TaxDate, DocCurrency+DocRate, ProjectCode, ReqDate)
    // — chỉ gửi khi có giá trị
    ...sapDocHeaderExtras(input),
    ...(withUdf && input.localId ? { [UDF_LOCAL_ID]: input.localId } : {}),
    DocumentLines: input.lines.map((l, i) => {
      const b = bases?.[i]
      return {
        // Copy-from: liên kết dòng với đơn/báo giá nguồn trên SAP
        // (BaseType/BaseEntry/BaseLine) — SAP tự trừ OpenQty của nguồn.
        ...(b ? { BaseType: b.baseType, BaseEntry: b.baseEntry, BaseLine: b.baseLine } : {}),
        ItemCode: l.itemCode,
        Quantity: l.quantity,
        // Đơn vị tính: chỉ gửi khi có giá trị — rỗng thì SAP dùng mặc định của mặt hàng
        ...(l.uom?.trim() ? { MeasureUnit: l.uom.trim() } : {}),
        UnitPrice: l.unitPrice,
        // VatGroup = mã nhóm thuế của dòng; DiscountPercent = CK % của dòng
        DiscountPercent: Number(l.discPct) || 0,
        ...(l.taxCode?.trim() ? { VatGroup: l.taxCode.trim() } : {}),
        ...(l.warehouseCode?.trim() ? { WarehouseCode: l.warehouseCode.trim() } : {}),
        // Lô hàng (SAP: DocumentLines.BatchNumbers) — chỉ dòng có batchNumber
        ...(l.batchNumber?.trim() ? { BatchNumbers: [{ BatchNumber: l.batchNumber.trim() }] } : {}),
      }
    }),
  }
}

interface SapLookup {
  value?: Array<{ DocEntry?: number; DocNum?: number }>
}

async function findByLocalId(
  settings: SapConfig,
  localId: string,
): Promise<{ supported: boolean; doc?: { DocEntry: number; DocNum?: number }; lookupError?: string }> {
  const safe = localId.replace(/'/g, "''")
  const res = await sapGet<SapLookup>(
    settings,
    '/DeliveryNotes',
    { $filter: `${UDF_LOCAL_ID} eq '${safe}'`, $select: 'DocEntry,DocNum' },
    { audit: 'off' },
  )
  if (!res.ok || !res.data) {
    const msg = res.error ?? 'lỗi không rõ'
    if (/UDF|invalid|not.*defin|unknown/i.test(msg)) return { supported: false }
    return { supported: false, lookupError: msg }
  }
  const first = res.data.value?.[0]
  if (typeof first?.DocEntry !== 'number') return { supported: true }
  return { supported: true, doc: { DocEntry: first.DocEntry, DocNum: first.DocNum } }
}

/**
 * Đẩy delivery sang SAP B1. KHÔNG bao giờ ném exception.
 */
export async function pushDeliveryToSap(input: SapDeliveryInput): Promise<SapDeliveryResult> {
  const settings = await loadSapSettings(input.databaseId ?? null)
  if (!isSapConfigured(settings)) return { status: 'none' }

  let withUdf = false
  if (input.localId) {
    const existing = await findByLocalId(settings, input.localId)
    if (existing.lookupError) {
      return {
        status: 'error',
        error: `Không kiểm tra được trùng chứng từ trên SAP (${existing.lookupError}) — chưa đẩy để tránh tạo trùng. Vui lòng thử lại.`,
      }
    }
    if (existing.supported && existing.doc) {
      return { status: 'synced', docEntry: existing.doc.DocEntry, docNum: existing.doc.DocNum }
    }
    withUdf = existing.supported
  }

  // Copy-from: tra BaseType/BaseEntry/BaseLine cho các dòng có dòng nguồn
  // (sourceOrderLineId → BaseType 17, sourceQuotationLineId → BaseType 23).
  // Nguồn chưa lên SAP (thiếu sapDocEntry) → CHẶN đẩy, trả lỗi rõ ràng
  // (không lặng lẽ bỏ qua — sẽ lệch OpenQty trên SAP).
  const bases: (SapLineBase | null)[] = []
  for (const l of input.lines) {
    const orderLineId = (l.sourceOrderLineId ?? '').trim()
    const quotationLineId = (l.sourceQuotationLineId ?? '').trim()
    if (!orderLineId && !quotationLineId) {
      bases.push(null)
      continue
    }
    // 1 dòng chỉ thuộc 1 nguồn (from-order hoặc from-quotation) —
    // ưu tiên đơn hàng nếu cả 2 đều có (dữ liệu bất thường).
    const spec = getSourceLineSpec(orderLineId ? 'salesOrderLine' : 'quotationLine')
    const r = await resolveSourceLineBase(spec!, orderLineId || quotationLineId, 'phiếu giao hàng')
    if (!r.ok) {
      return { status: 'error', blocked: true, error: r.error }
    }
    bases.push(r.base)
  }

  const res = await sapPost<{ DocEntry?: number; DocNum?: number }>(settings, '/DeliveryNotes', buildPayload(input, withUdf, bases))
  if (!res.ok) {
    return { status: 'pending', error: res.error ?? `Lỗi không xác định (HTTP ${res.status})` }
  }
  return {
    status: 'synced',
    docEntry: typeof res.data?.DocEntry === 'number' ? res.data.DocEntry : undefined,
    docNum: typeof res.data?.DocNum === 'number' ? res.data.DocNum : undefined,
  }
}
