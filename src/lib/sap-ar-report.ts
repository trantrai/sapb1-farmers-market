// ============================================================
// ĐỌC CHỨNG TỪ BÁN HÀNG TỪ SAP B1 CHO BÁO CÁO (CHỈ ĐỌC)
// - Báo cáo bán hàng: /Invoices theo khoảng DocDate (kèm dòng hàng).
// - Công nợ phải thu: /Invoices + /CreditNotes còn mở (DocumentStatus Open).
// Số liệu theo SAP (nội tệ): DocTotal, PaidToDate, DocDueDate (SAP đã tính
// theo ĐKTT). Bỏ chứng từ đã hủy và chứng từ hủy (CancelStatus csCancellation).
// Gộp với chứng từ local CHƯA lên SAP để không đếm trùng.
// Cache 60s theo DB + truy vấn (báo cáo hay bấm lại).
// ============================================================

import { sapGetAll, type SapConfig } from './sap-service-layer'

export type SapArEntitySet = 'Invoices' | 'CreditNotes'

export interface SapArLine {
  itemCode: string
  itemName: string
  quantity: number
  lineTotal: number
}

export interface SapArDoc {
  docEntry: number
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  docTotal: number
  paidToDate: number
  salesPersonCode: number | null
  lines?: SapArLine[]
}

interface RawLine {
  ItemCode?: string
  ItemDescription?: string
  Quantity?: number
  LineTotal?: number
  TreeType?: string
}

interface RawDoc {
  DocEntry?: number
  DocNum?: number
  CardCode?: string
  CardName?: string
  DocDate?: string
  DocDueDate?: string
  DocTotal?: number
  PaidToDate?: number
  SalesPersonCode?: number
  Cancelled?: string
  CancelStatus?: string
  DocumentLines?: RawLine[] | { results?: RawLine[] }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)
const onlyDate = (d?: string) => (d || '').slice(0, 10)
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

/** Map dòng SAP thô → SapArDoc (thuần — test được). Bỏ chứng từ hủy/chứng từ hủy-ngược. */
export function mapSapArDocs(raw: RawDoc[], withLines = false): SapArDoc[] {
  const out: SapArDoc[] = []
  for (const r of raw) {
    if (typeof r.DocEntry !== 'number') continue
    if (r.Cancelled === 'tYES' || r.CancelStatus === 'csYes' || r.CancelStatus === 'csCancellation') continue
    const doc: SapArDoc = {
      docEntry: r.DocEntry,
      docNum: num(r.DocNum),
      cardCode: String(r.CardCode ?? ''),
      cardName: String(r.CardName ?? ''),
      docDate: onlyDate(r.DocDate),
      docDueDate: onlyDate(r.DocDueDate) || onlyDate(r.DocDate),
      docTotal: num(r.DocTotal),
      paidToDate: num(r.PaidToDate),
      salesPersonCode: typeof r.SalesPersonCode === 'number' && r.SalesPersonCode >= 0 ? r.SalesPersonCode : null,
    }
    if (withLines) {
      const ls = Array.isArray(r.DocumentLines) ? r.DocumentLines : r.DocumentLines?.results ?? []
      // Dòng thành phần do SAP bung (iIngredient) không tính riêng (đã nằm trong dòng cha)
      doc.lines = ls
        .filter((l) => l && l.TreeType !== 'iIngredient' && l.ItemCode)
        .map((l) => ({ itemCode: String(l.ItemCode), itemName: String(l.ItemDescription ?? ''), quantity: num(l.Quantity), lineTotal: num(l.LineTotal) }))
    }
    out.push(doc)
  }
  return out
}

const cache = new Map<string, { at: number; docs: SapArDoc[] }>()
const CACHE_MS = 60_000

/**
 * Đọc chứng từ cho báo cáo. KHÔNG ném exception.
 * @param opts.from/to  lọc DocDate (YYYY-MM-DD, bao gồm 2 đầu)
 * @param opts.openOnly chỉ chứng từ còn mở (công nợ)
 * @param opts.withLines kèm dòng hàng (báo cáo bán hàng — top mặt hàng)
 */
export async function fetchSapArDocs(
  s: SapConfig,
  entitySet: SapArEntitySet,
  opts: { from?: string; to?: string; openOnly?: boolean; withLines?: boolean } = {},
): Promise<{ ok: true; docs: SapArDoc[] } | { ok: false; error: string }> {
  const filters = ["Cancelled eq 'tNO'"]
  if (opts.from && isYmd(opts.from)) filters.push(`DocDate ge '${opts.from}'`)
  if (opts.to && isYmd(opts.to)) filters.push(`DocDate le '${opts.to}'`)
  if (opts.openOnly) filters.push("DocumentStatus eq 'bost_Open'")
  const fields = 'DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocTotal,PaidToDate,SalesPersonCode,Cancelled'
  const $filter = filters.join(' and ')
  const key = `${s.dbId ?? ''}|${entitySet}|${$filter}|${opts.withLines ? 1 : 0}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, docs: hit.docs }

  // CancelStatus có từ SL 9.3; bản SL không nhận field này → thử lại không có nó
  let r = await sapGetAll<RawDoc>(s, `/${entitySet}`, {
    $select: `${fields},CancelStatus${opts.withLines ? ',DocumentLines' : ''}`,
    $filter,
    $orderby: 'DocEntry',
  })
  if (!r.ok && /CancelStatus|property|invalid/i.test(r.error ?? '')) {
    r = await sapGetAll<RawDoc>(s, `/${entitySet}`, {
      $select: `${fields}${opts.withLines ? ',DocumentLines' : ''}`,
      $filter,
      $orderby: 'DocEntry',
    })
  }
  if (!r.ok || !r.data) return { ok: false, error: r.error ?? `Không đọc được ${entitySet} từ SAP B1` }
  // Khử trùng theo DocEntry (SL không hỗ trợ $skip có thể trả lặp trang)
  const seen = new Set<number>()
  const docs = mapSapArDocs(r.data, opts.withLines).filter((d) => !seen.has(d.docEntry) && (seen.add(d.docEntry), true))
  cache.set(key, { at: Date.now(), docs })
  return { ok: true, docs }
}

/** Chứng từ local đã lên SAP (đã có trong dữ liệu SAP) → bỏ khi gộp để không đếm trùng */
export const isOnSap = (d: { sapSyncStatus?: string | null; sapDocEntry?: number | null }) =>
  d.sapSyncStatus === 'synced' && typeof d.sapDocEntry === 'number'

/** Chỉ dùng trong test */
export function clearSapArCache() {
  cache.clear()
}
