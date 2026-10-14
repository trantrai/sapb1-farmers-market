// ============================================================
// ĐỌC DELIVERY TRỰC TIẾP TỪ SAP B1 (GET /DeliveryNotes → ODLN/DLN1)
// Dùng cho Danh sách giao hàng: khi đã cấu hình Service Layer,
// danh sách lấy trực tiếp từ SAP B1 (gom đủ qua phân trang) và
// gộp với các phiếu local CHƯA đẩy sang SAP (pending/none).
// ============================================================

import { sapGet, sapGetAll, type SapConfig } from './sap-service-layer'
import { mapSapStatus } from './sap-orders'

// ---------- Kiểu dữ liệu Service Layer ----------
interface SapDeliveryHeader {
  DocEntry?: number
  DocNum?: number
  CardCode?: string
  CardName?: string
  DocDate?: string
  DocumentStatus?: string
  DocTotal?: number | string
  Comments?: string
}

interface SapDeliveryLine {
  LineNum?: number
  ItemCode?: string
  ItemDescription?: string
  Quantity?: number | string
  Price?: number | string
  LineTotal?: number | string
  MeasureUnit?: string
  UoMCode?: string
  WarehouseCode?: string
  WhsCode?: string
}

// ---------- Kiểu dữ liệu UI (khớp Delivery trong deliveries-list-view) ----------
export interface SapDeliveryRow {
  id: string
  docNum: number
  docDate: string
  cardCode: string
  cardName: string
  status: string
  remarks: string | null
  grandTotal: number
  sapDocEntry: number | null
  sapDocNum: number | null
  sapSyncStatus: 'synced'
  source: 'sap'
  /** id bản ghi local tương ứng (nếu có) */
  localId?: string | null
  lines: SapDeliveryLineRow[]
}

export interface SapDeliveryLineRow {
  id: string
  lineNum: number
  itemCode: string
  itemName: string
  uom: string
  quantity: number
  unitPrice: number
  lineTotal: number
}

/**
 * Ép số an toàn: một số cấu hình Service Layer trả số liệu dưới dạng CHUỖI
 * thay vì số — nếu không ép sẽ thành 0 làm hỏng chi tiết phiếu.
 */
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const p = Number(v)
    if (Number.isFinite(p)) return p
  }
  return 0
}

/**
 * Chuẩn hóa tập dòng hàng: tùy phiên bản/mức hỗ trợ OData, Service Layer có thể
 * trả expanded collection là MẢNG trực tiếp hoặc bọc trong { results: [...] }
 * (kiểu OData v2) — xử lý cả hai để không bao giờ mất dòng hàng.
 */
function asLineArray(x: unknown): SapDeliveryLine[] {
  if (Array.isArray(x)) return x as SapDeliveryLine[]
  if (x && typeof x === 'object') {
    const r = (x as { results?: unknown }).results
    if (Array.isArray(r)) return r as SapDeliveryLine[]
  }
  return []
}

const onlyDate = (d?: string) => (d || '').slice(0, 10)

function mapLine(l: SapDeliveryLine, idx: number): SapDeliveryLineRow {
  const qty = num(l.Quantity)
  const price = num(l.Price)
  const lineTotal =
    l.LineTotal !== undefined && l.LineTotal !== null && l.LineTotal !== ''
      ? num(l.LineTotal)
      : qty * price
  return {
    id: `sap-${l.LineNum ?? idx}`,
    lineNum: typeof l.LineNum === 'number' ? l.LineNum : idx + 1,
    itemCode: l.ItemCode ?? '',
    itemName: l.ItemDescription ?? l.ItemCode ?? '',
    uom: l.MeasureUnit ?? l.UoMCode ?? '',
    quantity: qty,
    unitPrice: price,
    lineTotal: Math.round(lineTotal),
  }
}

function mapHeader(h: SapDeliveryHeader): SapDeliveryRow {
  return {
    id: `sap-${h.DocEntry ?? h.DocNum ?? ''}`,
    docNum: h.DocNum ?? 0,
    docDate: onlyDate(h.DocDate),
    cardCode: h.CardCode ?? '',
    cardName: h.CardName ?? h.CardCode ?? '',
    status: mapSapStatus(h.DocumentStatus),
    remarks: h.Comments ?? null,
    grandTotal: Math.round(num(h.DocTotal)),
    sapDocEntry: h.DocEntry ?? null,
    sapDocNum: h.DocNum ?? null,
    sapSyncStatus: 'synced',
    source: 'sap',
    lines: [],
  }
}

export interface SapDeliveriesFilter {
  q?: string
  status?: string
  from?: string
  to?: string
}

export interface SapDeliveriesResult {
  ok: boolean
  data?: SapDeliveryRow[]
  total: number
  error?: string
  /** Một phần điều kiện truy vấn bị lỗi — dữ liệu có thể chưa đủ */
  warning?: string
}

/**
 * Dựng $filter OData CHỈ chứa các điều kiện `and` thuần cho /DeliveryNotes
 * (DocumentStatus / DocDate). Trả '' khi không có điều kiện nào.
 * ⚠ Service Layer thật KHÔNG hỗ trợ ngoặc tròn lẫn hàm substringof trong
 * $filter — TÌM KIẾM theo từ khóa (q) KHÔNG đưa vào $filter: tải header theo
 * điều kiện and-only rồi lọc q ngay trên máy chủ (DocNum/CardCode/CardName).
 */
function buildBaseFilter(f: SapDeliveriesFilter): string {
  const base: string[] = []
  if (f.status === 'Open') base.push("DocumentStatus eq 'O'")
  if (f.status === 'Closed') base.push("DocumentStatus eq 'C'")
  if (f.status === 'Cancelled') base.push("DocumentStatus eq 'C'")
  if (f.from) base.push(`DocDate ge '${f.from}'`)
  if (f.to) base.push(`DocDate le '${f.to}'`)
  return base.join(' and ')
}

/** Lọc từ khóa tìm kiếm ngay trên máy chủ — không phụ thuộc $filter của SL */
function matchKeyword(h: SapDeliveryHeader, q: string): boolean {
  const n = q.toLowerCase()
  return (
    String(h.DocNum ?? '').includes(n) ||
    (h.CardCode ?? '').toLowerCase().includes(n) ||
    (h.CardName ?? '').toLowerCase().includes(n)
  )
}

// ---------- Cache danh sách header delivery SAP (tránh tải lại toàn bộ
// /DeliveryNotes mỗi lần mở trang — GET /api/deliveries gọi hàm này cho mọi
// lần phân trang) ----------
// TTL ngắn (45 giây): đủ giảm tải khi user lật trang/tìm kiếm liên tục,
// vẫn thấy dữ liệu SAP mới sau tối đa 45s. Cache bị xóa ngay khi tạo/xóa
// phiếu qua app (clearSapDeliveriesCache) nên thao tác của chính user luôn mới.
const DELIVERIES_LIST_TTL = 45_000
const deliveriesListCache = new Map<string, { ts: number; result: SapDeliveriesResult }>()

/** Xóa cache danh sách delivery SAP — gọi sau khi tạo/sửa/xóa/hủy phiếu */
export function clearSapDeliveriesCache() {
  deliveriesListCache.clear()
}

function listCacheKey(c: SapConfig, filter: SapDeliveriesFilter): string {
  return `${c.serviceLayerUrl}|${c.companyDb}|${c.sapUser}|${JSON.stringify(filter)}`
}

/**
 * Lấy TOÀN BỘ header phiếu giao hàng từ SAP B1 (ODLN) khớp bộ lọc —
 * tự phân trang qua sapGetAll (chống giới hạn số bản ghi/trang của SL).
 * Chỉ lấy header (không $expand) để nhẹ — dòng hàng tải riêng khi mở chi tiết.
 * $filter chỉ dùng điều kiện and-only (DocumentStatus/DocDate); từ khóa tìm kiếm
 * được lọc tại chỗ vì SL thật không hỗ trợ substringof/ngoặc tròn.
 */
export async function fetchSapDeliveries(c: SapConfig, filter: SapDeliveriesFilter): Promise<SapDeliveriesResult> {
  const key = listCacheKey(c, filter)
  const cached = deliveriesListCache.get(key)
  if (cached && Date.now() - cached.ts < DELIVERIES_LIST_TTL) return cached.result

  const base = buildBaseFilter(filter)
  const baseQuery = {
    $select: 'DocEntry,DocNum,CardCode,CardName,DocDate,DocumentStatus,DocTotal,Comments',
    $orderby: 'DocEntry desc',
  }
  const res = await sapGetAll<SapDeliveryHeader>(c, '/DeliveryNotes', base ? { ...baseQuery, $filter: base } : baseQuery)
  if (!res.ok || !res.data) {
    return { ok: false, total: 0, error: res.error ?? 'Lỗi Service Layer' }
  }
  const q = (filter.q ?? '').trim()
  const headers = q ? res.data.filter((h) => matchKeyword(h, q)) : res.data
  const byEntry = new Map<number, SapDeliveryRow>()
  for (const h of headers) {
    const row = mapHeader(h)
    if (row.sapDocEntry != null && !byEntry.has(row.sapDocEntry)) byEntry.set(row.sapDocEntry, row)
  }
  const data = [...byEntry.values()].sort((a, b) => b.docNum - a.docNum)
  const result: SapDeliveriesResult = { ok: true, data, total: data.length }
  deliveriesListCache.set(key, { ts: Date.now(), result })
  return result
}

/**
 * Lấy chi tiết 1 phiếu giao hàng (kèm DocumentLines — DLN1) theo DocEntry.
 * Chuỗi dự phòng chống lỗi trên TỪNG loại Service Layer thật (mới nhất đầu tiên):
 *  1) GET /DeliveryNotes(N) THUẦN — không $expand. Trên mọi phiên bản SL,
 *     DocumentLines là collection CẤU TRÚC được trả sẵn trong body.
 *  2) GET /DeliveryNotes(N)/DocumentLines (tập con, tự phân trang) — khi bước 1
 *     lỗi hoặc không trả dòng hàng; header lấy lại song song nếu bước 1 chưa có.
 *  3) GET /DeliveryNotes(N)?$expand=DocumentLines — chốt cuối.
 * Nếu cả 3 đều không ra dòng hàng mới trả lỗi (gom thông báo từng bước để chẩn đoán).
 */
export async function fetchSapDeliveryDetail(
  c: SapConfig,
  docEntry: number,
): Promise<{ ok: boolean; delivery?: SapDeliveryRow; error?: string }> {
  // ---------- Bước 1: GET thuần (tương thích mọi phiên bản SL) ----------
  const plain = await sapGet<SapDeliveryHeader & { DocumentLines?: unknown }>(c, `/DeliveryNotes(${docEntry})`)
  let header: SapDeliveryHeader | undefined
  if (plain.ok && plain.data) {
    header = plain.data
    const hdr = mapHeader(plain.data)
    const lines = asLineArray(plain.data.DocumentLines).map((l, i) => mapLine(l, i))
    if (lines.length > 0) {
      hdr.lines = lines
      return { ok: true, delivery: hdr }
    }
  }
  const plainError = plain.ok
    ? 'GET trực tiếp OK nhưng không trả DocumentLines'
    : (plain.error ?? 'Lỗi GET trực tiếp')

  // ---------- Bước 2: endpoint tập con /DeliveryNotes(N)/DocumentLines ----------
  const hdrRes: { ok: boolean; data?: SapDeliveryHeader; error?: string } = header
    ? { ok: true, data: header }
    : await sapGet<SapDeliveryHeader>(c, `/DeliveryNotes(${docEntry})`)
  const child = await sapGetAll<SapDeliveryLine>(c, `/DeliveryNotes(${docEntry})/DocumentLines`)
  if (hdrRes.ok && hdrRes.data && child.ok && child.data) {
    const hdr = mapHeader(hdrRes.data)
    const lines = child.data.map((l, i) => mapLine(l, i))
    hdr.lines = lines
    // Header OK + tập con trả rỗng (không lỗi) → phiếu thực sự không có dòng
    return { ok: true, delivery: hdr }
  }
  const childError = !child.ok
    ? (child.error ?? 'Lỗi tập con DocumentLines')
    : child.data && child.data.length > 0
      ? (hdrRes.ok ? '' : (hdrRes.error ?? 'Không đọc được header'))
      : 'Tập con DocumentLines trả rỗng'

  // ---------- Bước 3: $expand (chốt cuối cho SL cũ chỉ trả dòng qua expand) ----------
  const res = await sapGet<SapDeliveryHeader & { DocumentLines?: unknown }>(c, `/DeliveryNotes(${docEntry})`, {
    $expand: 'DocumentLines',
  })
  if (res.ok && res.data) {
    const hdr = mapHeader(res.data)
    const lines = asLineArray(res.data.DocumentLines).map((l, i) => mapLine(l, i))
    if (lines.length > 0) {
      hdr.lines = lines
      return { ok: true, delivery: hdr }
    }
  }
  const expandError = res.ok ? 'Không đọc được DocumentLines từ $expand' : (res.error ?? 'Lỗi $expand')

  // ---------- Cả 3 bước đều không ra dòng hàng ----------
  const parts = [`GET trực tiếp: ${plainError}`]
  if (childError) parts.push(`Tập con: ${childError}`)
  parts.push(`$expand: ${expandError}`)
  return { ok: false, error: `Không lấy được chi tiết phiếu giao hàng từ SAP B1 — ${parts.join(' · ')}` }
}
