// ============================================================
// DỮ LIỆU MẶT HÀNG DÙNG CHUNG (autocomplete + màn Đồng bộ Mặt hàng)
// - loadSalesItems: tải TOÀN BỘ mặt hàng bán được (SalesItem=tYES)
//   từ SAP B1 Service Layer, cache 5 phút, 2 tầng dự phòng.
// - vatRateMap: mã nhóm thuế → thuế suất % (/VatGroups, cache 5 phút).
// - mapItem: chuẩn hóa 1 dòng B1Item → shape UI.
// ============================================================

import { sapGet, sapGetAll } from './sap-service-layer'
import { pickEffectiveVatRate, type B1VatLineRow } from './fm-shared'
import type { ProgressCb } from './fm-sync-progress'

export interface B1ItemPrice {
  PriceList: number | string
  Price: number | string
}

export interface B1Item {
  ItemCode: string
  ItemName: string
  InventoryUOM?: string
  SalesUnit?: string
  BarCode?: string
  SalesVATGroup?: string
  QuantityOnStock?: number | string
  /** 'tYES'/'tNO' — chỉ có ở bản SL trả đủ trường (fallback không $select) */
  SalesItem?: string
  ItemPrices?: B1ItemPrice[]
}

import type { SapConfig } from './sap-service-layer'

/** Config phiên SAP — bí danh của SapConfig (giữ tên cũ để các module không phải sửa import) */
export type SapSessConfig = SapConfig

/** Key cache theo database — mỗi DB có cache riêng, không lẫn nhau */
export const cacheKey = (s: SapSessConfig): string =>
  s.dbId ?? `${s.serviceLayerUrl}|${s.companyDb}|${s.sapUser}`

// OData v2 của Service Layer trả số thập phân (Edm.Decimal) dạng CHUỖI
// (vd "185000.000000") — bắt buộc ép số, nếu không giá/tồn sẽ thành 0 trên SL thật
export const numv = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Chuẩn hóa tìm kiếm không phân biệt hoa/thường + dấu tiếng Việt
export const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')

// ---------- Cache TOÀN BỘ mặt hàng bán được (SalesItem) 5 phút ----------
// Tìm kiếm theo từ khóa chạy TRÊN CACHE này, KHÔNG gửi substringof lên SL vì
// nhiều bản Service Layer thật từ chối hàm/ngoặc trong $filter (lỗi 400
// "the value 'true' of property ')' is invalid"). Lượt tìm đầu tiên tải danh
// mục một lần (tự phân trang), các lần gõ sau phản hồi tức thì từ cache.
const ITEMS_TTL = 5 * 60_000
const itemsCache = new Map<string, { ts: number; rows: B1Item[] }>()

/** Ép bỏ cache danh mục mặt hàng (dùng khi muốn đồng bộ lại từ đầu) */
export function clearItemsCache(dbId?: string | null) {
  if (dbId) itemsCache.delete(dbId)
  else itemsCache.clear()
}

export async function loadSalesItems(s: SapSessConfig, onProgress?: ProgressCb): Promise<{ rows: B1Item[]; error?: string }> {
  const key = cacheKey(s)
  const hit = itemsCache.get(key)
  if (hit && Date.now() - hit.ts < ITEMS_TTL) return { rows: hit.rows }
  // ① Lọc ngay trên SL: SalesItem eq 'tYES' (điều kiện and-only, an toàn mọi bản SL)
  //    + $select gọn (đã chạy tốt trên /Items ở các bản SL thật).
  onProgress?.({ phase: 'fetch', message: 'Đang lấy danh mục mặt hàng (/Items) từ SAP B1…' })
  const r1 = await sapGetAll<B1Item>(s, '/Items', {
    $select: 'ItemCode,ItemName,InventoryUOM,SalesUnit,BarCode,SalesVATGroup,ItemPrices',
    $filter: `SalesItem eq 'tYES'`,
    $orderby: 'ItemCode',
  })
  if (r1.ok && r1.data) {
    onProgress?.({ phase: 'fetch', message: `Đã nhận ${r1.data.length.toLocaleString('vi-VN')} mặt hàng từ SAP B1…`, fetched: r1.data.length })
    itemsCache.set(key, { ts: Date.now(), rows: r1.data })
    return { rows: r1.data }
  }
  // ② Dự phòng: lấy nguyên văn không $select/$filter, tự lọc SalesItem tại chỗ
  //    (phòng bản SL không nhận $select trên /Items hoặc chặn $filter SalesItem)
  const r2 = await sapGetAll<B1Item>(s, '/Items', { $orderby: 'ItemCode' })
  if (r2.ok && r2.data) {
    const rows = r2.data.filter((i) => (i as B1Item).SalesItem !== 'tNO')
    onProgress?.({ phase: 'fetch', message: `Đã nhận ${rows.length.toLocaleString('vi-VN')} mặt hàng từ SAP B1…`, fetched: rows.length })
    itemsCache.set(key, { ts: Date.now(), rows })
    return { rows }
  }
  return { rows: [], error: r1.error ?? r2.error ?? 'Lỗi Service Layer' }
}

// ---------- Map mã nhóm thuế → thuế suất % (từ /VatGroups, cache 5 phút, theo DB) ----------
const vatRateCache = new Map<string, { ts: number; map: Record<string, number> }>()
const VAT_TTL = 5 * 60_000

export async function vatRateMap(s: SapSessConfig): Promise<Record<string, number>> {
  const key = cacheKey(s)
  const hit = vatRateCache.get(key)
  if (hit && Date.now() - hit.ts < VAT_TTL) return hit.map
  // NGUỒN ĐÚNG %VAT: mảng con VatGroups_Lines (VTG1) KÈM SẴN trong từng nhóm
  // trả về từ /VatGroups (SL thật) — chọn dòng hiệu lực hôm nay qua
  // pickEffectiveVatRate. Cột Rate trên OVTG cha chỉ là dự phòng (bản SL/mock cũ).
  const read = (rows: (B1VatGroupRowLite)[]) => {
    const map: Record<string, number> = {}
    for (const v of rows) {
      if (!v.Code) continue
      const inline = Array.isArray(v.VatGroups_Lines) ? v.VatGroups_Lines : []
      const r = pickEffectiveVatRate(inline) ?? (v.Rate != null ? numv(v.Rate) : null)
      if (r == null) continue
      const cat = (v.Category ?? 'S').toString().trim().toUpperCase()
      // Cùng mã có thể tồn tại ở cả S (bán) và P (mua) — ưu tiên suất dòng BÁN
      if (cat === 'S' || !(v.Code in map)) map[v.Code] = r
    }
    return map
  }
  let map: Record<string, number> | null = null
  // ① KHÔNG dùng $select: một số bản Service Layer trả 400 khi $select trên VatGroups.
  //    Bảng OVTG rất nhỏ nên lấy nguyên văn; vẫn tự phân trang đề phòng giới hạn số dòng/trang.
  const g1 = await sapGetAll<B1VatGroupRowLite>(s, '/VatGroups', {})
  if (g1.ok && g1.data) map = read(g1.data)
  // ② Dự phòng: 1 lần gọi thuần KHÔNG kèm $top/$skip (nếu bản SL từ chối phân trang thực thể này)
  if (!map) {
    const g2 = await sapGet<{ value?: B1VatGroupRowLite[] }>(s, '/VatGroups', {})
    if (g2.ok && g2.data) map = read(g2.data.value ?? [])
  }
  if (!map) return vatRateCache.get(key)?.map ?? {} // lỗi → dùng cache cũ nếu có, không cache lỗi
  vatRateCache.set(key, { ts: Date.now(), map })
  return map
}

/** Dạng tối thiểu của 1 dòng /VatGroups (kèm mảng con VatGroups_Lines nếu SL trả đủ) */
interface B1VatGroupRowLite {
  Code?: string
  Category?: string
  Rate?: number | string
  VatGroups_Lines?: B1VatLineRow[] | null
}

export function mapItem(it: B1Item, vatMap: Record<string, number>) {
  const price = it.ItemPrices?.find((p) => numv(p.PriceList) === 1)?.Price
  const taxCode = it.SalesVATGroup ?? ''
  return {
    id: '',
    itemCode: it.ItemCode,
    itemName: it.ItemName ?? it.ItemCode,
    uom: it.SalesUnit || it.InventoryUOM || '',
    price: numv(price),
    stock: numv(it.QuantityOnStock),
    category: '',
    taxCode,
    vatRate: taxCode && taxCode in vatMap ? vatMap[taxCode] : undefined,
    barcode: it.BarCode ?? '',
  }
}
