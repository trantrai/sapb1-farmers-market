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
import { freshTemplateGroups, isFreshTplChild, reconcileTemplateBoms, UDF_BOM, type SapDocLine } from './sap-bom-reconcile'

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
  /** BOM (DeliveryLine.*): con Template gửi kèm cha ở bước 1, bước 2 xoá định mức gốc SAP bung (reconcileTemplateBoms) */
  isBomChild?: boolean | null
  bomGroupKey?: string | null
  bomEditable?: boolean | null
  /** Nội bộ: mã cha của con Template → U_BOMID */
  bomParentCode?: string
}

/** Dòng đơn hàng lấy TRỰC TIẾP từ SAP (không có bản ghi local): id dạng `sap-<LineNum>` */
const SAP_ORDER_LINE_RE = /^sap-(\d+)$/

export interface SapDeliveryInput extends SapDocHeaderExtras {
  /**
   * DocEntry đơn hàng nguồn trên SAP khi phiếu giao lập từ đơn CHỈ có trên SAP
   * (Delivery.sapSourceDocEntry) — dòng nguồn khi đó có id `sap-<LineNum>`.
   */
  sapSourceDocEntry?: number | null
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
    // BillToCode, ContactPersonCode, NumAtCard, TaxDate, DocCurrency+DocRate, ProjectCode, ReqDate)
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
        // BOM Template: con mang mã BOM cha
        ...(l.bomParentCode ? { [UDF_BOM]: l.bomParentCode } : {}),
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
export async function pushDeliveryToSap(rawInput: SapDeliveryInput): Promise<SapDeliveryResult> {
  const settings = await loadSapSettings(rawInput.databaseId ?? null)
  if (!isSapConfigured(settings)) return { status: 'none' }

  // BOM: con BOM khác (Production/Assembly/bán hàng) bỏ hẳn — SAP tự bung.
  // Nhóm Template → bước 1 gửi cả cha + con người dùng (giá 0, U_BOMID), SAP vẫn
  // chèn định mức gốc sau cha → bước 2 xoá khối đó (giống đơn hàng).
  const fresh = freshTemplateGroups(rawInput.lines)
  const recLines = rawInput.lines.filter((l) => !l.isBomChild || isFreshTplChild(l, fresh))
  const postIdx = recLines.map((_, i) => i)
  const input: SapDeliveryInput = {
    ...rawInput,
    lines: recLines.map((l) => (isFreshTplChild(l, fresh)
      // Con Template: giá/CK 0, mang mã cha, không liên kết dòng nguồn (chỉ cha mang BaseLine)
      ? { ...l, unitPrice: 0, discPct: 0, sourceOrderLineId: null, sourceQuotationLineId: null, bomParentCode: fresh.get(l.bomGroupKey || '') }
      : l)),
  }
  const reconcile = async (docEntry: number, docNum: number | undefined, udf: boolean, sapLines?: SapDocLine[]): Promise<SapDeliveryResult> => {
    const rec = await reconcileTemplateBoms(settings, 'DeliveryNotes', docEntry, recLines, postIdx, sapLines)
    if (rec.ok) return { status: 'synced', docEntry, docNum }
    // Có marker localId → "Đẩy lại" nhận lại chứng từ này và áp tiếp bước 2.
    // Không có marker → KHÔNG để pending (đẩy lại sẽ tạo trùng chứng từ).
    return udf
      ? { status: 'pending', error: rec.error }
      : { status: 'synced', docEntry, docNum, error: `${rec.error} — chứng từ đã tạo trên SAP với định mức gốc, cần sửa trực tiếp trên SAP B1.` }
  }

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
      // Đã có trên SAP (lần trước có thể mới xong bước 1) → áp tiếp bước 2
      if (fresh.size > 0) return reconcile(existing.doc.DocEntry, existing.doc.DocNum, true)
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
    // Đơn hàng nguồn CHỈ có trên SAP: không tra DB local mà dựng base trực tiếp
    // từ DocEntry đơn nguồn + LineNum gắn trong id dòng (`sap-<LineNum>`)
    const sapLine = orderLineId.match(SAP_ORDER_LINE_RE)
    if (sapLine) {
      if (typeof input.sapSourceDocEntry !== 'number') {
        return {
          status: 'error',
          blocked: true,
          error: 'Không thể đẩy phiếu giao hàng: thiếu DocEntry đơn hàng nguồn trên SAP B1 (sapSourceDocEntry) cho dòng lập từ đơn SAP.',
        }
      }
      bases.push({ baseType: 17, baseEntry: input.sapSourceDocEntry, baseLine: Number(sapLine[1]) })
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

  const res = await sapPost<{ DocEntry?: number; DocNum?: number; DocumentLines?: SapDocLine[] }>(settings, '/DeliveryNotes', buildPayload(input, withUdf, bases))
  if (!res.ok) {
    return { status: 'pending', error: res.error ?? `Lỗi không xác định (HTTP ${res.status})` }
  }
  const docEntry = typeof res.data?.DocEntry === 'number' ? res.data.DocEntry : undefined
  const docNum = typeof res.data?.DocNum === 'number' ? res.data.DocNum : undefined
  if (fresh.size > 0) {
    if (docEntry === undefined) {
      return withUdf
        ? { status: 'pending', error: 'SAP không trả về DocEntry — vui lòng đẩy lại' }
        : { status: 'synced', docNum, error: 'SAP không trả về DocEntry — chưa áp được định mức BOM người dùng, cần sửa trực tiếp trên SAP B1.' }
    }
    return reconcile(docEntry, docNum, withUdf, Array.isArray(res.data?.DocumentLines) ? res.data.DocumentLines : undefined)
  }
  return { status: 'synced', docEntry, docNum }
}
