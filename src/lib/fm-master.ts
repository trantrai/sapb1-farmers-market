// ============================================================
// DỮ LIỆU CHỦ DÙNG CHUNG (màn Đồng bộ Nhóm thuế + Đồng bộ Khách hàng)
// - loadVatGroups: /VatGroups (OVTG) + lịch sử suất /VatGroups_Lines (VTG1),
//   chọn thuế suất HIỆU LỰC HÔM NAY, cache 5 phút, 3 tầng dự phòng.
// - loadCustomers: /BusinessPartners chỉ KHÁCH HÀNG (CardType='C'), 2 tầng.
// Kiến trúc mirror giống fm-items.ts của màn Đồng bộ Mặt hàng.
// ============================================================

import { sapGet, sapGetAll, SyncCancelled, type SapGetAllOpts } from './sap-service-layer'
import { numv, type SapSessConfig, cacheKey } from './fm-items'
import { pickEffectiveVatRate, type B1VatLineRow } from './fm-shared'
import type { ProgressCb } from './fm-sync-progress'
import { deltaFilters, updateDateStr, updateTimeNum, type DeltaWatermark } from './fm-sync-delta'

export type { B1VatLineRow }

// ---------- ① NHÓM THUẾ (/VatGroups OVTG + /VatGroups_Lines VTG1) ----------
// NGUỒN ĐÚNG của %VAT là trường Rate trong bảng con VTG1 (VatGroups_Lines),
// mỗi dòng có khoảng hiệu lực DateFrom/DateTo — chọn dòng hiệu lực hôm nay.
// Cấu trúc trả về theo bản SL:
//  · SL THẬT: GET /VatGroups trả từng nhóm KÈM SẴN mảng con VatGroups_Lines
//    ngay trong response (Rate + DateFrom/DateTo) → đọc trực tiếp, không cần
//    gọi thêm tài nguyên nào (tài nguyên gốc /VatGroups_Lines KHÔNG tồn tại).
//  · OVTG cha không đáng tin cậy về Rate (nhiều bản trả thiếu/không trả) —
//    chỉ dùng làm dự phòng cuối cho bản SL/mock cũ.
//  · Dự phòng thêm: gọi /VatGroups('MÃ')/VatGroups_Lines cho từng mã còn thiếu.
export interface B1VatGroupRow {
  Code?: string
  Category?: string
  Name?: string
  Rate?: number | string // chỉ có ở bản SL cũ/mock — SL thật không trả
  VatGroups_Lines?: B1VatLineRow[] | null // mảng con VTG1 KÈM SẴN trong response (SL thật)
  /** Mốc thay đổi của SAP B1 — dùng cho đồng bộ gia tăng (delta sync) */
  UpdateDate?: string
  /** Số nguyên HHMMSS, vd 143025 = 14:30:25 */
  UpdateTime?: number | string
}

export interface VatGroupRowData {
  code: string
  category: string // 'S' | 'P'
  name: string
  rate: number | null // thuế suất % hiệu lực hôm nay (null = không tra được)
}

const MASTER_TTL = 5 * 60_000
const vatCache = new Map<string, { ts: number; rows: VatGroupRowData[] }>()

/** Ép bỏ cache nhóm thuế (theo DB; không truyền = xóa hết) */
export function clearVatGroupsCache(dbId?: string | null) {
  if (dbId) vatCache.delete(dbId)
  else vatCache.clear()
}

export async function loadVatGroups(s: SapSessConfig, onProgress?: ProgressCb, opts?: SapGetAllOpts): Promise<{ rows: VatGroupRowData[]; error?: string }> {
  const vgKey = cacheKey(s)
  const vgHit = vatCache.get(vgKey)
  if (vgHit && Date.now() - vgHit.ts < MASTER_TTL) return { rows: vgHit.rows }

  // ---------- ① Danh mục OVTG (2 tầng: phân trang nguyên văn → gọi thuần) ----------
  let groups: B1VatGroupRow[] | null = null
  onProgress?.({ phase: 'fetch', message: 'Đang lấy danh mục nhóm thuế (/VatGroups) từ SAP B1…' })
  const g1 = await sapGetAll<B1VatGroupRow>(s, '/VatGroups', {}, opts)
  if (g1.ok && g1.data) groups = g1.data
  if (!groups) {
    const g2 = await sapGet<{ value?: B1VatGroupRow[] }>(s, '/VatGroups', {})
    if (g2.ok && g2.data) groups = g2.data.value ?? []
  }
  if (!groups || groups.length === 0) {
    return { rows: [], error: g1.error ?? 'Không lấy được danh mục nhóm thuế từ /VatGroups' }
  }
  onProgress?.({ phase: 'fetch', message: `Đã nhận ${groups.length} mã nhóm thuế — đang lấy lịch sử suất thuế…`, fetched: groups.length })

  const rows = await resolveVatGroupRows(s, groups, opts)
  rows.sort((a, b) => (a.code === b.code ? (a.category < b.category ? -1 : 1) : a.code < b.code ? -1 : 1))
  vatCache.set(vgKey, { ts: Date.now(), rows })
  return { rows }
}

// ---------- Giải thuế suất hiệu lực cho các dòng OVTG thô ----------
// Gom dòng suất VTG1 (mảng con inline + 2 tầng dự phòng) rồi chọn suất hiệu
// lực hôm nay cho từng (Category, Code). Dùng chung cho toàn phần và delta.
async function resolveVatGroupRows(s: SapSessConfig, groups: B1VatGroupRow[], opts?: SapGetAllOpts): Promise<VatGroupRowData[]> {
  // Gom dòng suất theo khóa "Category|Code" (dòng có Category) hoặc "|Code" (không có)
  const byKey = new Map<string, B1VatLineRow[]>()
  const pushLine = (l: B1VatLineRow, codeOverride?: string) => {
    if (!l?.Rate && l?.Rate !== 0) return
    const code = l.Code || codeOverride
    if (!code) return
    const cat = (l.Category ?? '').toString().trim().toUpperCase()
    const key = cat === 'S' || cat === 'P' ? `${cat}|${code}` : `|${code}`
    const arr = byKey.get(key) ?? []
    arr.push(l)
    byKey.set(key, arr)
  }

  // ---------- ② NGUỒN CHÍNH: mảng con VatGroups_Lines KÈM SẴN trong response ----------
  // SL thật luôn trả child collection inline cùng từng nhóm — đây là nơi chứa Rate.
  for (const v of groups) {
    if (!v.Code) continue
    if (Array.isArray(v.VatGroups_Lines)) {
      for (const l of v.VatGroups_Lines) pushLine(l, v.Code)
    }
  }

  // ---------- ②b DỰ PHÒNG 1: tài nguyên gốc /VatGroups_Lines ----------
  // Chỉ gọi khi còn mã chưa có dòng suất (SL thật không mở tài nguyên này →
  // tránh một request 404 thừa + noise audit khi mảng inline đã đủ).
  const groupCodes = [...new Set(groups.map((v) => v.Code).filter((x): x is string => Boolean(x)))]
  const hasAnyLine = (code: string) =>
    byKey.has(`S|${code}`) || byKey.has(`P|${code}`) || byKey.has(`|${code}`)
  if (groupCodes.some((code) => !hasAnyLine(code))) {
    let lines: B1VatLineRow[] | null = null
    const l1 = await sapGetAll<B1VatLineRow>(s, '/VatGroups_Lines', {}, opts)
    if (l1.ok && l1.data) lines = l1.data
    if (!lines) {
      const l2 = await sapGet<{ value?: B1VatLineRow[] }>(s, '/VatGroups_Lines', {})
      if (l2.ok && l2.data) lines = l2.data.value ?? []
    }
    for (const l of lines ?? []) {
      if (!l?.Code) continue
      pushLine(l)
    }
  }

  // ---------- ②c DỰ PHÒNG 2: gọi tài nguyên cha cho TỪNG mã còn thiếu ----------
  if (groupCodes.some((code) => !hasAnyLine(code))) {
    for (const code of groupCodes) {
      if (hasAnyLine(code)) continue
      if (opts?.shouldCancel?.()) throw new SyncCancelled()
      const r = await sapGet<B1VatLineRow[] | { value?: B1VatLineRow[] }>(
        s,
        `/VatGroups('${encodeURIComponent(code)}')/VatGroups_Lines`,
        {},
      )
      if (!r.ok || !r.data) continue
      const rows = Array.isArray(r.data) ? r.data : (r.data.value ?? [])
      for (const l of rows) pushLine({ ...l, Code: l.Code || code }, code)
    }
  }

  const rows: VatGroupRowData[] = []
  for (const v of groups) {
    if (!v.Code) continue
    const cat = (v.Category ?? 'S').toString().trim().toUpperCase()
    const normCat = cat === 'P' ? 'P' : 'S' // giá trị lạ → coi như dòng bán
    // Nguồn ĐÚNG: VTG1 theo (Category, Code); dự phòng: dòng không phân loại, rồi cột Rate trên OVTG
    const rate = pickEffectiveVatRate(byKey.get(`${normCat}|${v.Code}`))
      ?? pickEffectiveVatRate(byKey.get(`|${v.Code}`))
      ?? (v.Rate != null ? numv(v.Rate) : null)
    rows.push({ code: v.Code, category: normCat, name: (v.Name ?? '').toString(), rate })
  }
  return rows
}

/** Lấy các dòng OVTG THÔ (kèm UpdateDate/UpdateTime) — dùng để tính mốc
 *  watermark sau lượt đồng bộ toàn phần (loadVatGroups chỉ trả dữ liệu đã giải). */
export async function loadVatGroupsRaw(s: SapSessConfig): Promise<B1VatGroupRow[]> {
  const r = await sapGetAll<B1VatGroupRow>(s, '/VatGroups', { $orderby: 'Code' })
  if (r.ok && r.data) return r.data
  const g2 = await sapGet<{ value?: B1VatGroupRow[] }>(s, '/VatGroups', {})
  if (g2.ok && g2.data) return g2.data.value ?? []
  return []
}

// ---------- ② KHÁCH HÀNG (/BusinessPartners, CardType 'C' = Customer) ----------
// Phạm vi: chỉ kéo KHÁCH HÀNG — cùng tinh thần màn Mặt hàng chỉ kéo
// SalesItem=tYES. Nhà cung cấp ('S') và khách tiềm năng ('L') không nằm
// trong phạm vi app Sale Order.
export interface B1Partner {
  CardCode: string
  CardName?: string
  CardType?: string // 'C' | 'S' | 'L' — chỉ có ở bản SL trả đủ trường
  Address?: string
  Phone1?: string
  EmailAddress?: string
  /** Người liên hệ (ComplexType — trả inline, không cần $expand) */
  /** Tên người liên hệ mặc định (OCRD.CntctPrsn — khớp ContactEmployees[].Name) */
  ContactPerson?: string
  /** AddressName của địa chỉ giao hàng / ghi hóa đơn mặc định */
  ShipToDefault?: string
  BilltoDefault?: string
  ContactEmployees?: Array<{
    InternalCode?: number
    Active?: string // 'tYES' | 'tNO'
    Name?: string
    FirstName?: string
    LastName?: string
    Phone1?: string
    MobilePhone?: string
    E_Mail?: string
  }>
  /** Địa chỉ chi tiết (ComplexType — trả inline) */
  BPAddresses?: Array<{
    AddressName?: string
    AddressType?: string // 'S' = ShipTo, 'B' = BillTo
    Street?: string
    City?: string
    ZipCode?: string
    Country?: string
  }>
  /** Mốc thay đổi của SAP B1 — dùng cho đồng bộ gia tăng (delta sync) */
  UpdateDate?: string
  /** Số nguyên HHMMSS, vd 143025 = 14:30:25 */
  UpdateTime?: number | string
}

const bpCache = new Map<string, { ts: number; rows: B1Partner[] }>()

/** Ép bỏ cache khách hàng (theo DB; không truyền = xóa hết) */
export function clearCustomersCache(dbId?: string | null) {
  if (dbId) bpCache.delete(dbId)
  else bpCache.clear()
}

export async function loadCustomers(s: SapSessConfig, onProgress?: ProgressCb, opts?: SapGetAllOpts): Promise<{ rows: B1Partner[]; error?: string }> {
  const key = cacheKey(s)
  const hit = bpCache.get(key)
  if (hit && Date.now() - hit.ts < MASTER_TTL) return { rows: hit.rows }
  // ① Lọc ngay trên SL: CardType eq 'C' (điều kiện and-only, an toàn mọi bản SL)
  onProgress?.({ phase: 'fetch', message: 'Đang lấy danh mục khách hàng (/BusinessPartners) từ SAP B1…' })
  const r1 = await sapGetAll<B1Partner>(s, '/BusinessPartners', {
    $select: 'CardCode,CardName,CardType,Address,Phone1,EmailAddress,ContactPerson,ShipToDefault,BilltoDefault,ContactEmployees,BPAddresses,UpdateDate,UpdateTime',
    $filter: `CardType eq 'C'`,
    $orderby: 'CardCode',
  }, opts)
  if (r1.ok && r1.data) {
    onProgress?.({ phase: 'fetch', message: `Đã nhận ${r1.data.length.toLocaleString('vi-VN')} khách hàng từ SAP B1…`, fetched: r1.data.length })
    bpCache.set(key, { ts: Date.now(), rows: r1.data })
    return { rows: r1.data }
  }
  // ② Dự phòng: lấy nguyên văn không $select/$filter, tự lọc khách hàng tại chỗ.
  //    Bản SL không trả CardType → coi như khách hàng (loại trừ 'S'/'L' rõ ràng).
  const r2 = await sapGetAll<B1Partner>(s, '/BusinessPartners', { $orderby: 'CardCode' }, opts)
  if (r2.ok && r2.data) {
    const rows = r2.data.filter((p) => p.CardType !== 'S' && p.CardType !== 'L')
    onProgress?.({ phase: 'fetch', message: `Đã nhận ${rows.length.toLocaleString('vi-VN')} khách hàng từ SAP B1…`, fetched: rows.length })
    bpCache.set(key, { ts: Date.now(), rows })
    return { rows }
  }
  // Cache cũ vẫn dùng được → dùng tạm thay vì báo lỗi (SL có thể đang gián đoạn)
  if (hit) return { rows: hit.rows }
  return { rows: [], error: r1.error ?? r2.error ?? 'Lỗi Service Layer' }
}

// ---------- ĐỒNG BỘ GIA TĂNG: chỉ tải khách hàng thay đổi kể từ mốc (D, T) ----------
// Chạy 2 query and-only (tránh `or`/ngoặc trong $filter — an toàn mọi bản SL),
// gộp rồi khử trùng theo CardCode tại chỗ. Chỉ nên gọi khi đã có watermark;
// lần đầu (chưa có mốc) hãy dùng loadCustomers (toàn phần).
export async function loadCustomersDelta(
  s: SapSessConfig,
  wm: DeltaWatermark,
  onProgress?: ProgressCb,
  opts?: SapGetAllOpts,
): Promise<{ rows: B1Partner[]; error?: string }> {
  const [f1, f2] = deltaFilters(`CardType eq 'C'`, wm)
  const select = 'CardCode,CardName,CardType,Address,Phone1,EmailAddress,ContactPerson,ShipToDefault,BilltoDefault,ContactEmployees,BPAddresses,UpdateDate,UpdateTime'
  onProgress?.({
    phase: 'fetch',
    message: `Đang lấy khách hàng thay đổi từ ${wm.date} (giờ SAP)…`,
  })
  const [r1, r2] = await Promise.all([
    sapGetAll<B1Partner>(s, '/BusinessPartners', { $select: select, $filter: f1, $orderby: 'CardCode' }, opts),
    sapGetAll<B1Partner>(s, '/BusinessPartners', { $select: select, $filter: f2, $orderby: 'CardCode' }, opts),
  ])
  if (!r1.ok || !r1.data) return { rows: [], error: r1.error ?? 'Lỗi Service Layer' }
  if (!r2.ok || !r2.data) return { rows: [], error: r2.error ?? 'Lỗi Service Layer' }
  // Khử trùng theo CardCode (2 query có thể giao nhau ở biên)
  const byCode = new Map<string, B1Partner>()
  for (const p of [...r1.data, ...r2.data]) {
    if (p?.CardCode) byCode.set(p.CardCode, p)
  }
  const rows = [...byCode.values()]
  onProgress?.({
    phase: 'fetch',
    message: `Đã nhận ${rows.length.toLocaleString('vi-VN')} khách hàng thay đổi từ SAP B1…`,
    fetched: rows.length,
  })
  return { rows }
}

/**
 * Trộn các dòng delta vào cache khách hàng hiện có (upsert theo CardCode) —
 * giữ cache ấm sau lượt sync gia tăng mà không phải tải lại toàn bộ.
 * Không có cache thì thôi (lần đọc sau sẽ tải đầy + cache).
 */
export function mergeCustomersCache(s: SapSessConfig, delta: B1Partner[]): void {
  const key = cacheKey(s)
  const hit = bpCache.get(key)
  if (!hit) return
  const byCode = new Map(hit.rows.map((r) => [r.CardCode, r]))
  for (const d of delta) {
    if (d?.CardCode) byCode.set(d.CardCode, d)
  }
  bpCache.set(key, { ts: Date.now(), rows: [...byCode.values()] })
}

// ---------- ĐỒNG BỘ GIA TĂNG nhóm thuế: /VatGroups rất ít dòng → ----------
// tải toàn bộ nhóm, lọc tại chỗ các dòng thay đổi theo mốc (D, T),
// rồi giải thuế suất hiệu lực cho đúng các dòng đó. Trả về VatGroupRowData
// (đã có rate) để caller upsert thẳng vào mirror.
export async function loadVatGroupsDelta(
  s: SapSessConfig,
  wm: DeltaWatermark,
  onProgress?: ProgressCb,
  opts?: SapGetAllOpts,
): Promise<{ rows: VatGroupRowData[]; changedRaw: B1VatGroupRow[]; error?: string }> {
  onProgress?.({
    phase: 'fetch',
    message: `Đang lấy nhóm thuế thay đổi từ ${wm.date} (giờ SAP)…`,
  })
  const r = await sapGetAll<B1VatGroupRow>(s, '/VatGroups', { $orderby: 'Code' }, opts)
  if (!r.ok || !r.data) return { rows: [], changedRaw: [], error: r.error ?? 'Lỗi Service Layer' }
  const changedRaw = r.data.filter((v) => {
    const d = updateDateStr(v.UpdateDate)
    if (!d) return false
    if (d > wm.date) return true
    return d === wm.date && updateTimeNum(v.UpdateTime) > wm.time
  })
  const rows = changedRaw.length > 0 ? await resolveVatGroupRows(s, changedRaw, opts) : []
  rows.sort((a, b) => (a.code === b.code ? (a.category < b.category ? -1 : 1) : a.code < b.code ? -1 : 1))
  onProgress?.({
    phase: 'fetch',
    message: `Đã nhận ${rows.length} nhóm thuế thay đổi từ SAP B1…`,
    fetched: rows.length,
  })
  return { rows, changedRaw }
}
