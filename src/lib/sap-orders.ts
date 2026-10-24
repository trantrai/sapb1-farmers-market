// ============================================================
// ĐỌC SALE ORDER TRỰC TIẾP TỪ SAP B1 (GET /Orders → ORDR/RDR1)
// Dùng cho Danh sách đơn hàng: khi đã cấu hình Service Layer,
// danh sách lấy trực tiếp từ SAP B1 (gom đủ qua phân trang) và
// gộp với các đơn local CHƯA đẩy sang SAP (pending/none).
// ============================================================

import { sapGet, sapGetAll, type SapConfig } from './sap-service-layer'
import { vatRateMap } from './fm-items'

// ---------- Kiểu dữ liệu Service Layer ----------
interface SapOrderHeader {
  DocEntry?: number
  DocNum?: number
  CardCode?: string
  CardName?: string
  DocDate?: string
  DocDueDate?: string
  DocumentStatus?: string
  DocTotal?: number | string
  VatSum?: number | string
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
  DiscountPercent?: number | string
  /** Số tiền CK đầu chứng từ SAP đã tính (DocTotal đã trừ) */
  DocDiscount?: number | string
  Comments?: string
}

interface SapOrderLine {
  LineNum?: number
  ItemCode?: string
  ItemDescription?: string
  Quantity?: number | string
  Price?: number | string
  DiscountPercent?: number | string
  LineTotal?: number | string
  VatGroup?: string
  TaxCode?: string
  MeasureUnit?: string
  UoMCode?: string
  VatSum?: number | string
  WarehouseCode?: string
  WhsCode?: string
  /** SL còn mở trên SAP (DocumentLine.RemainingOpenQuantity) */
  RemainingOpenQuantity?: number | string
  /** SL đã giao trên SAP (DocumentLine.DeliveredQuantity) */
  DeliveredQuantity?: number | string
  /** UDF mã BOM cha của dòng thành phần BOM Template */
  U_BOMID?: string | null
}

// ---------- Kiểu dữ liệu UI (khớp Order trong orders-list-view) ----------
export interface SapOrderRow {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks: string | null
  totalBeforeDisc: number
  discountAmt: number
  /** Chiết khấu ĐẦU CHỨNG TỪ % + số tiền sau phân bổ (SAP: DiscountPercent/DocDiscount) */
  headerDiscPct: number
  headerDiscAmt: number
  vatAmt: number
  grandTotal: number
  createdBy: string
  sapDocEntry: number | null
  sapDocNum: number | null
  sapSyncStatus: 'synced'
  sapSyncedAt: null
  source: 'sap'
  /** id bản ghi local tương ứng (nếu có) — cho phép SỬA đơn từ danh sách SAP */
  localId?: string | null
  lines: SapOrderLineRow[]
}

export interface SapOrderLineRow {
  id: string
  lineNum: number
  itemCode: string
  itemName: string
  uom: string
  warehouseCode: string
  quantity: number
  unitPrice: number
  lineTotal: number
  discPct: number
  discAmt: number
  vatPct: number
  vatAmt: number
  /**
   * true = tiền VAT lấy từ Service Layer; false = SL không trả VatSum theo
   * dòng (metadata SAPB1.DocumentLine KHÔNG có property VatSum — chỉ header
   * Document mới có) nên app tự tính từ thuế suất (xem finalizeTotals).
   */
  vatAmtFromSap: boolean
  grandTotal: number
  /** Mã nhóm thuế (VatGroup/TaxCode) của dòng trên SAP — dùng khi sửa đơn */
  taxCode?: string
  /** SL còn mở theo SAP (RemainingOpenQuantity, hoặc Quantity - DeliveredQuantity) */
  sapOpenQty?: number
  /** U_BOMID của dòng (mã BOM cha) — dòng thành phần BOM Template */
  bomId?: string | null
}

/**
 * Ép số an toàn: một số cấu hình Service Layer trả số liệu dưới dạng CHUỖI
 * ("10", "32000.0") thay vì số — nếu không ép sẽ thành 0 làm hỏng chi tiết đơn.
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
function asLineArray(x: unknown): SapOrderLine[] {
  if (Array.isArray(x)) return x as SapOrderLine[]
  if (x && typeof x === 'object') {
    const r = (x as { results?: unknown }).results
    if (Array.isArray(r)) return r as SapOrderLine[]
  }
  return []
}

/** 'O'/'bost_Open' → Open, 'C'/'bost_Closed' → Closed (v1/v2 của SL khác nhau) */
export function mapSapStatus(s?: string): string {
  if (s === 'O' || s === 'bost_Open') return 'Open'
  if (s === 'C' || s === 'bost_Closed') return 'Closed'
  return s || 'Open'
}

const onlyDate = (d?: string) => (d || '').slice(0, 10)

interface MapLineCtx {
  /** Map mã nhóm thuế → thuế suất % (tra từ /VatGroups — có thể rỗng khi SL không trả) */
  vmap: Record<string, number>
  /** % chiết khấu ĐẦU CHỨNG TỪ của chứng từ — SAP tính thuế trên tiền SAU CK đầu */
  headerPct: number
}

/** Dòng hàng RDR1 → dòng của UI.
 * VAT%: ƯU TIÊN tra bảng nhóm thuế OVTG (suất thật); không tra được mới suy từ
 * VatSum — khi có CK đầu chứng từ phải chia cho phần SAU CK đầu (denom =
 * afterDisc × (1 − headerPct/100)), nếu chỉ chia LineTotal sẽ ra suất bị nhỏ đi
 * (8% thành 7.2 → hiển thị 7%) — đây là nguyên nhân chi tiết đơn sai VAT%.
 * VAT TIỀN (vatAmt): Service Layer THẬT không trả VatSum theo dòng
 * (metadata SAPB1.DocumentLine không có property này — chỉ header Document
 * mới có VatSum). Trường hợp đó đánh dấu vatAmtFromSap=false để
 * finalizeTotals tự tính VAT = làm tròn((sau CK dòng − phần CK đầu) × VAT%)
 * theo đúng công thức SAP B1 (cùng công thức order-calc khi tạo đơn). */
function mapLine(l: SapOrderLine, idx: number, ctx: MapLineCtx): SapOrderLineRow {
  const qty = num(l.Quantity)
  const price = num(l.Price)
  const lineTotalBefore = qty * price
  const afterDisc = l.LineTotal !== undefined && l.LineTotal !== null ? num(l.LineTotal) : lineTotalBefore * (1 - num(l.DiscountPercent) / 100)
  const discAmt = Math.max(0, Math.round(lineTotalBefore - afterDisc))
  const vatSumRaw = l.VatSum
  const vatAmtFromSap = vatSumRaw !== undefined && vatSumRaw !== null && vatSumRaw !== ''
  const vatAmt = vatAmtFromSap ? num(vatSumRaw) : 0
  const taxCode = l.VatGroup ?? l.TaxCode ?? ''
  const vatRate = ctx.vmap[taxCode]
  let vatPct: number
  if (typeof vatRate === 'number' && vatRate > 0) {
    vatPct = vatRate
  } else {
    const denom = ctx.headerPct > 0 ? afterDisc * (1 - ctx.headerPct / 100) : afterDisc
    vatPct = denom > 0 ? Math.round((vatAmt / denom) * 1000) / 10 : 0
  }
  // SL còn mở theo SAP: ưu tiên RemainingOpenQuantity, fallback Quantity - DeliveredQuantity
  const remOpen = l.RemainingOpenQuantity !== undefined && l.RemainingOpenQuantity !== null && l.RemainingOpenQuantity !== ''
    ? num(l.RemainingOpenQuantity)
    : Math.max(0, qty - num(l.DeliveredQuantity))
  return {
    id: `sap-${l.LineNum ?? idx}`,
    lineNum: typeof l.LineNum === 'number' ? l.LineNum : idx + 1,
    itemCode: l.ItemCode ?? '',
    itemName: l.ItemDescription ?? l.ItemCode ?? '',
    uom: l.MeasureUnit ?? l.UoMCode ?? '',
    warehouseCode: l.WarehouseCode ?? (l as { WhsCode?: string }).WhsCode ?? '',
    taxCode,
    quantity: qty,
    unitPrice: price,
    lineTotal: Math.round(lineTotalBefore),
    discPct: num(l.DiscountPercent),
    discAmt,
    vatPct,
    vatAmt: Math.round(vatAmt),
    vatAmtFromSap,
    grandTotal: Math.round(afterDisc + vatAmt),
    sapOpenQty: Math.round(remOpen * 1000) / 1000,
    bomId: typeof l.U_BOMID === 'string' && l.U_BOMID.trim() ? l.U_BOMID.trim() : null,
  }
}

function mapHeader(h: SapOrderHeader): SapOrderRow {
  const docTotal = num(h.DocTotal)
  const vatSum = num(h.VatSum)
  return {
    id: `sap-${h.DocEntry ?? h.DocNum ?? ''}`,
    docNum: h.DocNum ?? 0,
    cardCode: h.CardCode ?? '',
    cardName: h.CardName ?? h.CardCode ?? '',
    docDate: onlyDate(h.DocDate),
    docDueDate: onlyDate(h.DocDueDate),
    status: mapSapStatus(h.DocumentStatus),
    remarks: h.Comments ?? null,
    totalBeforeDisc: Math.round(docTotal - vatSum),
    discountAmt: 0,
    headerDiscPct: num(h.DiscountPercent),
    headerDiscAmt: 0, // finalizeTotals tính lại khi có dòng hàng
    vatAmt: Math.round(vatSum),
    grandTotal: Math.round(docTotal),
    createdBy: 'SAP B1',
    sapDocEntry: h.DocEntry ?? null,
    sapDocNum: h.DocNum ?? null,
    sapSyncStatus: 'synced',
    sapSyncedAt: null,
    source: 'sap',
    lines: [],
  }
}

export interface SapOrdersFilter {
  q?: string
  status?: string
  from?: string
  to?: string
}

export interface SapOrdersResult {
  ok: boolean
  data?: SapOrderRow[]
  total: number
  error?: string
  /** Một phần điều kiện truy vấn bị lỗi — dữ liệu có thể chưa đủ */
  warning?: string
}

/**
 * Dựng $filter OData CHỈ chứa các điều kiện `and` thuần cho /Orders
 * (DocumentStatus / DocDate). Trả '' khi không có điều kiện nào.
 * ⚠ QUAN TRỌNG: Service Layer thật KHÔNG hỗ trợ ngoặc tròn lẫn hàm
 * substringof trong $filter — filter kiểu `substringof('x', CardCode) eq true`
 * bị từ chối 400 "Query string error - the value 'true' of property ')' is
 * invalid". Vì vậy TÌM KIẾM theo từ khóa (q) KHÔNG đưa vào $filter: tải header
 * theo điều kiện and-only rồi lọc q ngay trên máy chủ (DocNum/CardCode/CardName).
 */
function buildBaseFilter(f: SapOrdersFilter): string {
  const base: string[] = []
  if (f.status === 'Open') base.push("DocumentStatus eq 'O'")
  if (f.status === 'Closed') base.push("DocumentStatus eq 'C'")
  if (f.from) base.push(`DocDate ge '${f.from}'`)
  if (f.to) base.push(`DocDate le '${f.to}'`)
  return base.join(' and ')
}

/** Lọc từ khóa tìm kiếm ngay trên máy chủ — không phụ thuộc $filter của SL */
function matchKeyword(h: SapOrderHeader, q: string): boolean {
  const n = q.toLowerCase()
  return (
    String(h.DocNum ?? '').includes(n) ||
    (h.CardCode ?? '').toLowerCase().includes(n) ||
    (h.CardName ?? '').toLowerCase().includes(n)
  )
}

// ---------- Cache danh sách header đơn SAP (tránh tải lại toàn bộ /Orders
// mỗi lần mở trang — GET /api/orders gọi hàm này cho mọi lần phân trang) ----------
// TTL ngắn (45 giây): đủ giảm tải khi user lật trang/tìm kiếm liên tục,
// vẫn thấy dữ liệu SAP mới sau tối đa 45s. Cache bị xóa ngay khi tạo/sửa/xóa
// đơn qua app (clearSapOrdersCache) nên thao tác của chính user luôn mới.
const ORDERS_LIST_TTL = 45_000
const ordersListCache = new Map<string, { ts: number; result: SapOrdersResult }>()

/** Xóa cache danh sách đơn SAP — gọi sau khi tạo/sửa/xóa/đóng-mở đơn */
export function clearSapOrdersCache() {
  ordersListCache.clear()
}

function listCacheKey(c: SapConfig, filter: SapOrdersFilter): string {
  return `${c.serviceLayerUrl}|${c.companyDb}|${c.sapUser}|${JSON.stringify(filter)}`
}

/**
 * Lấy TOÀN BỘ header đơn hàng bán từ SAP B1 (ORDR) khớp bộ lọc —
 * tự phân trang qua sapGetAll (chống giới hạn số bản ghi/trang của SL).
 * Chỉ lấy header (không $expand) để nhẹ — dòng hàng tải riêng khi mở chi tiết.
 * $filter chỉ dùng điều kiện and-only (DocumentStatus/DocDate); từ khóa tìm kiếm
 * được lọc tại chỗ vì SL thật không hỗ trợ substringof/ngoặc tròn.
 */
export async function fetchSapOrders(c: SapConfig, filter: SapOrdersFilter): Promise<SapOrdersResult> {
  const key = listCacheKey(c, filter)
  const cached = ordersListCache.get(key)
  if (cached && Date.now() - cached.ts < ORDERS_LIST_TTL) return cached.result

  const base = buildBaseFilter(filter)
  const baseQuery = {
    $select: 'DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,DocumentStatus,DocTotal,VatSum,Comments',
    $orderby: 'DocEntry desc',
  }
  const res = await sapGetAll<SapOrderHeader>(c, '/Orders', base ? { ...baseQuery, $filter: base } : baseQuery)
  if (!res.ok || !res.data) {
    return { ok: false, total: 0, error: res.error ?? 'Lỗi Service Layer' }
  }
  const q = (filter.q ?? '').trim()
  const headers = q ? res.data.filter((h) => matchKeyword(h, q)) : res.data
  const byEntry = new Map<number, SapOrderRow>()
  for (const h of headers) {
    const row = mapHeader(h)
    if (row.sapDocEntry != null && !byEntry.has(row.sapDocEntry)) byEntry.set(row.sapDocEntry, row)
  }
  const data = [...byEntry.values()].sort((a, b) => b.docNum - a.docNum)
  const result: SapOrdersResult = { ok: true, data, total: data.length }
  ordersListCache.set(key, { ts: Date.now(), result })
  return result
}

/**
 * Lấy chi tiết 1 đơn (kèm DocumentLines — RDR1) theo DocEntry.
 * Chuỗi dự phòng chống lỗi trên TỪNG loại Service Layer thật (mới nhất đầu tiên):
 *  1) GET /Orders(N) THUẦN — không $expand. Trên mọi phiên bản SL, DocumentLines
 *     là collection CẤU TRÚC được trả sẵn trong body, nên cách này luôn chạy được.
 *     (Một số bản SL — ví dụ metadata kiểu 'Document' — KHÔNG khai báo
 *     DocumentLines là navigation property → $expand bị từ chối lỗi 201
 *     "Cannot expand invalid navigation property", và tập con cũng có thể bị chặn.)
 *  2) GET /Orders(N)/DocumentLines (tập con, tự phân trang) — khi bước 1 lỗi
 *     hoặc không trả dòng hàng; header lấy lại song song nếu bước 1 chưa có.
 *  3) GET /Orders(N)?$expand=DocumentLines — chốt cuối cho SL chỉ trả dòng qua expand.
 * Nếu cả 3 đều không ra dòng hàng mới trả lỗi (gom thông báo từng bước để chẩn đoán).
 */
export async function fetchSapOrderDetail(
  c: SapConfig,
  docEntry: number,
): Promise<{ ok: boolean; order?: SapOrderRow; error?: string }> {
  return fetchSapDocDetail(c, 'Orders', docEntry, 'đơn')
}

/**
 * Chi tiết 1 chứng từ bán hàng bất kỳ (Orders, Quotations, Invoices, CreditNotes,
 * Returns, DownPayments…) — cùng cấu trúc Document trên Service Layer nên dùng
 * chung chuỗi dự phòng 3 bước như đơn hàng. Chỉ đọc.
 */
export async function fetchSapDocDetail(
  c: SapConfig,
  entitySet: string,
  docEntry: number,
  label = 'chứng từ',
): Promise<{ ok: boolean; order?: SapOrderRow; error?: string }> {
  // Bảng mã nhóm thuế → thuế suất (OVTG, cache 5 phút) — cho VAT% chuẩn của dòng
  const vmap = await vatRateMap(c).catch(() => ({}) as Record<string, number>)

  // ---------- Bước 1: GET thuần (tương thích mọi phiên bản SL) ----------
  const plain = await sapGet<SapOrderHeader & { DocumentLines?: unknown }>(c, `/${entitySet}(${docEntry})`)
  let header: SapOrderHeader | undefined
  if (plain.ok && plain.data) {
    header = plain.data
    const hdr = mapHeader(plain.data)
    const lines = asLineArray(plain.data.DocumentLines).map((l, i) => mapLine(l, i, { vmap, headerPct: hdr.headerDiscPct }))
    if (lines.length > 0) {
      hdr.lines = lines
      return { ok: true, order: finalizeTotals(hdr, lines, plain.data) }
    }
  }
  const plainError = plain.ok
    ? 'GET trực tiếp OK nhưng không trả DocumentLines'
    : (plain.error ?? 'Lỗi GET trực tiếp')

  // ---------- Bước 2: endpoint tập con /Orders(N)/DocumentLines ----------
  const hdrRes: { ok: boolean; data?: SapOrderHeader; error?: string } = header
    ? { ok: true, data: header }
    : await sapGet<SapOrderHeader>(c, `/${entitySet}(${docEntry})`)
  const child = await sapGetAll<SapOrderLine>(c, `/${entitySet}(${docEntry})/DocumentLines`)
  if (hdrRes.ok && hdrRes.data && child.ok && child.data) {
    const hdr = mapHeader(hdrRes.data)
    const lines = child.data.map((l, i) => mapLine(l, i, { vmap, headerPct: hdr.headerDiscPct }))
    hdr.lines = lines
    // Header OK + tập con trả rỗng (không lỗi) → đơn thực sự không có dòng
    return { ok: true, order: lines.length > 0 ? finalizeTotals(hdr, lines, hdrRes.data) : hdr }
  }
  const childError = !child.ok
    ? (child.error ?? 'Lỗi tập con DocumentLines')
    : child.data && child.data.length > 0
      ? (hdrRes.ok ? '' : (hdrRes.error ?? 'Không đọc được header'))
      : 'Tập con DocumentLines trả rỗng'

  // ---------- Bước 3: $expand (chốt cuối cho SL cũ chỉ trả dòng qua expand) ----------
  const res = await sapGet<SapOrderHeader & { DocumentLines?: unknown }>(c, `/${entitySet}(${docEntry})`, {
    $expand: 'DocumentLines',
  })
  if (res.ok && res.data) {
    const hdr = mapHeader(res.data)
    const lines = asLineArray(res.data.DocumentLines).map((l, i) => mapLine(l, i, { vmap, headerPct: hdr.headerDiscPct }))
    if (lines.length > 0) {
      hdr.lines = lines
      return { ok: true, order: finalizeTotals(hdr, lines, res.data) }
    }
  }
  const expandError = res.ok ? 'Không đọc được DocumentLines từ $expand' : (res.error ?? 'Lỗi $expand')

  // ---------- Cả 3 bước đều không ra dòng hàng ----------
  const parts = [`GET trực tiếp: ${plainError}`]
  if (childError) parts.push(`Tập con: ${childError}`)
  parts.push(`$expand: ${expandError}`)
  return { ok: false, error: `Không lấy được chi tiết ${label} từ SAP B1 — ${parts.join(' · ')}` }
}

/** Có dòng hàng → tính lại tổng theo dòng cho khớp bảng chi tiết.
 * CK đầu chứng từ được PHÂN BỔ về từng dòng theo tỷ lệ sau-CK-dòng (floor từng
 * dòng, phần dư cộng cho dòng có tiền lớn nhất — cùng công thức order-calc khi
 * tạo đơn) → tiền từng dòng TRỪ CK đầu trước thuế → tổng tiền từng dòng khớp
 * TỔNG CỘNG từng đồng.
 * VAT từng dòng: Service Layer thật KHÔNG trả VatSum theo dòng
 * (SAPB1.DocumentLine không có property này) → với dòng có vatAmtFromSap=false
 * và vatPct > 0, tự tính VAT = làm tròn((sau CK dòng − phần CK đầu) × VAT%),
 * đúng công thức SAP B1 và khớp cách tính khi tạo đơn (order-calc).
 * Dòng nào SL có trả VatSum (mock/future) thì giữ nguyên số của SAP. */
function finalizeTotals(row: SapOrderRow, lines: SapOrderLineRow[], h?: SapOrderHeader): SapOrderRow {
  if (lines.length === 0) return row
  row.totalBeforeDisc = lines.reduce((s, l) => s + l.lineTotal, 0)
  row.discountAmt = lines.reduce((s, l) => s + l.discAmt, 0)
  const baseAfter = row.totalBeforeDisc - row.discountAmt
  const docDisc = num(h?.DocDiscount)
  const headerTotal =
    docDisc > 0 ? Math.round(docDisc) : row.headerDiscPct > 0 && baseAfter > 0 ? Math.round((baseAfter * row.headerDiscPct) / 100) : 0
  // Phân bổ CK đầu chứng từ về từng dòng (floor + dồn phần dư cho dòng lớn nhất)
  const shares = lines.map(() => 0)
  if (headerTotal > 0 && baseAfter > 0) {
    let allocated = 0
    lines.forEach((l, i) => {
      const ad = l.lineTotal - l.discAmt
      const sh = Math.floor((ad * headerTotal) / baseAfter)
      shares[i] = sh
      allocated += sh
    })
    const residual = headerTotal - allocated
    if (residual !== 0) {
      const maxIdx = lines.reduce((mi, l, i) => (l.lineTotal - l.discAmt > lines[mi].lineTotal - lines[mi].discAmt ? i : mi), 0)
      shares[maxIdx] += residual
    }
    row.headerDiscAmt = headerTotal
  } else {
    row.headerDiscAmt = 0
  }
  lines.forEach((l, i) => {
    const vatBase = l.lineTotal - l.discAmt - shares[i]
    if (!l.vatAmtFromSap && l.vatPct > 0) {
      l.vatAmt = Math.round((vatBase * l.vatPct) / 100)
    }
    l.grandTotal = Math.round(vatBase + l.vatAmt)
  })
  row.vatAmt = lines.reduce((s, l) => s + l.vatAmt, 0)
  row.grandTotal = lines.reduce((s, l) => s + l.grandTotal, 0)
  return row
}
