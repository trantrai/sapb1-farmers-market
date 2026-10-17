// ============================================================
// ĐỌC CHỨNG TỪ BÁN HÀNG TỪ SAP B1 (GET dùng chung)
// EntitySet: Quotations | Invoices | CreditNotes | Returns | DownPayments
// Dùng cho danh sách gộp SAP + local ở các màn hình Phase 1/2 Sales A/R.
// ============================================================

import { loadSapSettings, isSapConfigured, sapGet } from './sap-service-layer'

export interface SapDocRow {
  docEntry: number
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
}

export type SapDocReadEntitySet = 'Quotations' | 'Invoices' | 'CreditNotes' | 'Returns' | 'DownPayments'

interface SapDocListRaw {
  value?: Array<{
    DocEntry?: number
    DocNum?: number
    CardCode?: string
    CardName?: string
    DocDate?: string
    DocDueDate?: string
    DocumentStatus?: string
  }>
}

const onlyDate = (d?: string) => (d || '').slice(0, 10)

/**
 * Đọc danh sách chứng từ từ SAP B1 Service Layer.
 * Chưa cấu hình SAP → { ok: false, rows: [], error }. KHÔNG ném exception.
 * Timeout 12s theo chuẩn sapGet (TIMEOUT_MS).
 */
export async function fetchSapDocuments(
  entitySet: SapDocReadEntitySet,
  databaseId?: string | null,
): Promise<{ ok: boolean; rows: SapDocRow[]; error?: string }> {
  const settings = await loadSapSettings(databaseId)
  if (!isSapConfigured(settings)) {
    return { ok: false, rows: [], error: 'Chưa cấu hình kết nối SAP B1' }
  }
  const res = await sapGet<SapDocListRaw>(
    settings,
    `/${entitySet}`,
    { $select: 'DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocumentStatus' },
    { audit: 'off' },
  )
  if (!res.ok || !res.data) {
    return { ok: false, rows: [], error: res.error ?? `Không đọc được ${entitySet} từ SAP (HTTP ${res.status})` }
  }
  const rows: SapDocRow[] = []
  for (const v of res.data.value ?? []) {
    if (typeof v.DocEntry !== 'number') continue
    rows.push({
      docEntry: v.DocEntry,
      docNum: typeof v.DocNum === 'number' ? v.DocNum : 0,
      cardCode: v.CardCode ?? '',
      cardName: v.CardName ?? '',
      docDate: onlyDate(v.DocDate),
      docDueDate: onlyDate(v.DocDueDate),
      status: v.DocumentStatus ?? '',
    })
  }
  return { ok: true, rows }
}
