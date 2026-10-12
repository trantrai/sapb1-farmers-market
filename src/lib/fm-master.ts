// ============================================================
// DỮ LIỆU CHỦ DÙNG CHUNG (màn Đồng bộ Nhóm thuế + Đồng bộ Khách hàng)
// - loadVatGroups: /VatGroups (OVTG) + lịch sử suất /VatGroups_Lines (VTG1),
//   chọn thuế suất HIỆU LỰC HÔM NAY, cache 5 phút, 3 tầng dự phòng.
// - loadCustomers: /BusinessPartners chỉ KHÁCH HÀNG (CardType='C'), 2 tầng.
// Kiến trúc mirror giống fm-items.ts của màn Đồng bộ Mặt hàng.
// ============================================================

import { sapGet, sapGetAll } from './sap-service-layer'
import { numv, type SapSessConfig, cacheKey } from './fm-items'
import { pickEffectiveVatRate, type B1VatLineRow } from './fm-shared'
import type { ProgressCb } from './fm-sync-progress'

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

export async function loadVatGroups(s: SapSessConfig, onProgress?: ProgressCb): Promise<{ rows: VatGroupRowData[]; error?: string }> {
  const vgKey = cacheKey(s)
  const vgHit = vatCache.get(vgKey)
  if (vgHit && Date.now() - vgHit.ts < MASTER_TTL) return { rows: vgHit.rows }

  // ---------- ① Danh mục OVTG (2 tầng: phân trang nguyên văn → gọi thuần) ----------
  let groups: B1VatGroupRow[] | null = null
  onProgress?.({ phase: 'fetch', message: 'Đang lấy danh mục nhóm thuế (/VatGroups) từ SAP B1…' })
  const g1 = await sapGetAll<B1VatGroupRow>(s, '/VatGroups', {})
  if (g1.ok && g1.data) groups = g1.data
  if (!groups) {
    const g2 = await sapGet<{ value?: B1VatGroupRow[] }>(s, '/VatGroups', {})
    if (g2.ok && g2.data) groups = g2.data.value ?? []
  }
  if (!groups || groups.length === 0) {
    return { rows: [], error: g1.error ?? 'Không lấy được danh mục nhóm thuế từ /VatGroups' }
  }
  onProgress?.({ phase: 'fetch', message: `Đã nhận ${groups.length} mã nhóm thuế — đang lấy lịch sử suất thuế…`, fetched: groups.length })

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
    const l1 = await sapGetAll<B1VatLineRow>(s, '/VatGroups_Lines', {})
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
  rows.sort((a, b) => (a.code === b.code ? (a.category < b.category ? -1 : 1) : a.code < b.code ? -1 : 1))
  vatCache.set(vgKey, { ts: Date.now(), rows })
  return { rows }
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
  ContactEmployees?: Array<{
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
}

const bpCache = new Map<string, { ts: number; rows: B1Partner[] }>()

/** Ép bỏ cache khách hàng (theo DB; không truyền = xóa hết) */
export function clearCustomersCache(dbId?: string | null) {
  if (dbId) bpCache.delete(dbId)
  else bpCache.clear()
}

export async function loadCustomers(s: SapSessConfig, onProgress?: ProgressCb): Promise<{ rows: B1Partner[]; error?: string }> {
  const key = cacheKey(s)
  const hit = bpCache.get(key)
  if (hit && Date.now() - hit.ts < MASTER_TTL) return { rows: hit.rows }
  // ① Lọc ngay trên SL: CardType eq 'C' (điều kiện and-only, an toàn mọi bản SL)
  onProgress?.({ phase: 'fetch', message: 'Đang lấy danh mục khách hàng (/BusinessPartners) từ SAP B1…' })
  const r1 = await sapGetAll<B1Partner>(s, '/BusinessPartners', {
    $select: 'CardCode,CardName,CardType,Address,Phone1,EmailAddress,ContactEmployees,BPAddresses',
    $filter: `CardType eq 'C'`,
    $orderby: 'CardCode',
  })
  if (r1.ok && r1.data) {
    onProgress?.({ phase: 'fetch', message: `Đã nhận ${r1.data.length.toLocaleString('vi-VN')} khách hàng từ SAP B1…`, fetched: r1.data.length })
    bpCache.set(key, { ts: Date.now(), rows: r1.data })
    return { rows: r1.data }
  }
  // ② Dự phòng: lấy nguyên văn không $select/$filter, tự lọc khách hàng tại chỗ.
  //    Bản SL không trả CardType → coi như khách hàng (loại trừ 'S'/'L' rõ ràng).
  const r2 = await sapGetAll<B1Partner>(s, '/BusinessPartners', { $orderby: 'CardCode' })
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
