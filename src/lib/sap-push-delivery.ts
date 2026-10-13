// ============================================================
// ĐẨY DELIVERY SANG SAP B1 (POST /DeliveryNotes → bảng ODLN/DLN1)
// Quy tắc:
//  - Chưa cấu hình Service Layer → status 'none' (chỉ lưu local)
//  - Đẩy thành công → 'synced' + lưu DocEntry/DocNum do SAP cấp
//  - Đẩy thất bại  → 'pending' + lưu thông báo lỗi (có thể "Đẩy lại")
// ============================================================

import { loadSapSettings, isSapConfigured, sapGet, sapPost, type SapConfig } from './sap-service-layer'
import { UDF_LOCAL_ID } from './sap-push-order'

export interface SapDeliveryLine {
  itemCode: string
  quantity: number
  unitPrice: number
  warehouseCode?: string | null
}

export interface SapDeliveryInput {
  /** Id SapDatabase đích */
  databaseId?: string | null
  cardCode: string
  docDate: string
  comments?: string | null
  lines: SapDeliveryLine[]
  /** Id delivery local — idempotency qua UDF U_FM_LocalId */
  localId?: string
}

export interface SapDeliveryResult {
  status: 'none' | 'pending' | 'synced' | 'error'
  docEntry?: number
  docNum?: number
  error?: string
}

const onlyDate = (d: string) => (d || '').slice(0, 10)

function buildPayload(input: SapDeliveryInput, withUdf = false) {
  return {
    CardCode: input.cardCode,
    DocDate: onlyDate(input.docDate),
    ...(input.comments?.trim() ? { Comments: input.comments.trim().slice(0, 254) } : {}),
    ...(withUdf && input.localId ? { [UDF_LOCAL_ID]: input.localId } : {}),
    DocumentLines: input.lines.map((l) => ({
      ItemCode: l.itemCode,
      Quantity: l.quantity,
      UnitPrice: l.unitPrice,
      ...(l.warehouseCode?.trim() ? { WarehouseCode: l.warehouseCode.trim() } : {}),
    })),
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

  const res = await sapPost<{ DocEntry?: number; DocNum?: number }>(settings, '/DeliveryNotes', buildPayload(input, withUdf))
  if (!res.ok) {
    return { status: 'pending', error: res.error ?? `Lỗi không xác định (HTTP ${res.status})` }
  }
  return {
    status: 'synced',
    docEntry: typeof res.data?.DocEntry === 'number' ? res.data.DocEntry : undefined,
    docNum: typeof res.data?.DocNum === 'number' ? res.data.DocNum : undefined,
  }
}
