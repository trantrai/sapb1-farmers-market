import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGet } from '@/lib/sap-service-layer'

// ============================================================
// ATP CHECK — Tồn kho khả dụng (Available-to-Promise)
// Chuỗi truy vấn SAP B1 (tự dự phòng theo phiên bản Service Layer):
//   1) GET /Items('X') THUẦN — ItemWarehouseInfoCollection là complex
//      property, được trả inline trong body trên phần lớn bản SL
//   2) Fallback: GET /Items('X')/ItemWarehouseInfoCollection (truy cập
//      trực tiếp property — OData cho phép, không cần $expand)
//   3) Chốt cuối: GET /Items('X')?$select=ItemWarehouseInfoCollection
//      (select tường minh cho bản SL cắt bớt complex property mặc định)
//   4) Dự phòng cuối: QuantityOnStock (tổng tồn toàn kho) → 1 dòng tổng hợp
// ⚠ KHÔNG dùng $expand=ItemWarehouseInfo — ItemWarehouseInfo là ComplexType,
//   KHÔNG phải navigation property → SL trả 400 "Cannot expand invalid
//   navigation property 'ItemWarehouseInfo' for entity type 'Item'".
//   Tên property đúng trên entity Item là ItemWarehouseInfoCollection.
// ⚠ KHÔNG dùng /InventoryItems — một số bản SL thật không có resource này
//   (400 "Unrecognized resource path").
// ATP = InStock − Committed + Ordered  (tồn − đã cam kết + đang về)
// Chưa cấu hình SAP → fallback tồn kho local (bảng Item.stock).
// ============================================================

interface B1InvWarehouse {
  WarehouseCode?: string
  InStock?: number | string
  /** Tên đúng theo metadata SL (ComplexType ItemWarehouseInfo) */
  Committed?: number | string
  Ordered?: number | string
  /** Biến thể tên trường trên một số phiên bản SL / DB */
  IsCommitted?: number | string
  OnOrder?: number | string
  CommittedOnStock?: number | string
  OrderedOnStock?: number | string
}
interface B1InventoryItem {
  ItemCode?: string
  ItemName?: string
  Warehouses?: B1InvWarehouse[]
}

export interface StockRow {
  warehouseCode: string
  warehouseName?: string
  inStock: number
  committed: number
  onOrder: number
  /** ATP = InStock − IsCommitted + OnOrder */
  available: number
}

const n = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

/** Warehouses[] → StockRow[] (ATP từng kho) */
function toStockRows(whs: B1InvWarehouse[]): StockRow[] {
  return whs.map((w) => {
    const inStock = n(w.InStock)
    const committed = n(w.Committed ?? w.IsCommitted ?? w.CommittedOnStock)
    const onOrder = n(w.Ordered ?? w.OnOrder ?? w.OrderedOnStock)
    return {
      warehouseCode: w.WarehouseCode ?? '',
      inStock,
      committed,
      onOrder,
      available: inStock - committed + onOrder,
    }
  })
}

const EMPTY_TOTALS = { inStock: 0, committed: 0, onOrder: 0, available: 0 }

/** Chuẩn hóa ItemWarehouseInfoCollection: mảng trực tiếp, {value:[…]} (OData v4) hoặc {results:[…]} (OData v2) */
function asWhsArray(x: unknown): B1InvWarehouse[] {
  if (Array.isArray(x)) return x as B1InvWarehouse[]
  if (x && typeof x === 'object') {
    const v = (x as { value?: unknown }).value
    if (Array.isArray(v)) return v as B1InvWarehouse[]
    const r = (x as { results?: unknown }).results
    if (Array.isArray(r)) return r as B1InvWarehouse[]
  }
  return []
}

function stockResponse(rows: StockRow[], itemCode: string, warehouseCode: string) {
  const totals = rows.reduce(
    (a, r) => ({ inStock: a.inStock + r.inStock, committed: a.committed + r.committed, onOrder: a.onOrder + r.onOrder, available: a.available + r.available }),
    EMPTY_TOTALS,
  )
  return NextResponse.json({
    ok: true,
    source: 'sap',
    itemCode,
    warehouses: rows,
    totals,
    selected: warehouseCode ? rows.find((r) => r.warehouseCode === warehouseCode) ?? null : null,
  })
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const itemCode = (req.nextUrl.searchParams.get('itemCode') ?? '').trim()
  const warehouseCode = (req.nextUrl.searchParams.get('warehouseCode') ?? '').trim()
  if (!itemCode) {
    return NextResponse.json({ ok: false, error: 'Thiếu tham số itemCode' }, { status: 400 })
  }

  const s = await loadSapSettings()

  // ---------- 1) Truy vấn trực tiếp SAP B1 (có fallback theo phiên bản SL) ----------
  if (isSapConfigured(s)) {
    const esc = itemCode.replace(/'/g, "''")
    // Bước 1: GET /Items('X') THUẦN — ItemWarehouseInfoCollection là complex
    // property, trả inline trong body trên phần lớn bản SL
    const viaItem = await sapGet<B1InventoryItem & { ItemWarehouseInfoCollection?: unknown; QuantityOnStock?: number | string }>(
      s,
      `/Items('${esc}')`,
    )
    let whs = asWhsArray(viaItem.ok ? viaItem.data?.ItemWarehouseInfoCollection : undefined)
    if (whs.length > 0) {
      return stockResponse(toStockRows(whs), itemCode, warehouseCode)
    }

    // Bước 2 (fallback): truy cập trực tiếp property /Items('X')/ItemWarehouseInfoCollection
    const child = await sapGet<unknown>(s, `/Items('${esc}')/ItemWarehouseInfoCollection`)
    whs = asWhsArray(child.ok ? child.data : undefined)
    if (whs.length > 0) {
      return stockResponse(toStockRows(whs), itemCode, warehouseCode)
    }

    // Bước 3 (chốt cuối): $select tường minh — cho bản SL cắt bớt complex
    // property trong response mặc định. (KHÔNG dùng $expand: ItemWarehouseInfo
    // là ComplexType, không phải navigation property → SL trả 400.)
    const viaSelect = await sapGet<B1InventoryItem & { ItemWarehouseInfoCollection?: unknown }>(
      s,
      `/Items('${esc}')`,
      { $select: 'ItemWarehouseInfoCollection' },
    )
    whs = asWhsArray(viaSelect.ok ? viaSelect.data?.ItemWarehouseInfoCollection : undefined)
    if (whs.length > 0) {
      return stockResponse(toStockRows(whs), itemCode, warehouseCode)
    }

    // Bước 4 (dự phòng cuối): chỉ còn tổng tồn toàn kho (QuantityOnStock) —
    // SL quá hạn chế (không trả ItemWarehouseInfoCollection ở bất kỳ dạng nào)
    // thì vẫn hiển thị được 1 dòng ATP tổng hợp thay vì báo lỗi.
    const totalOnStock = n(viaItem.ok ? viaItem.data?.QuantityOnStock : undefined)
    if (viaItem.ok && totalOnStock > 0) {
      const row: StockRow = { warehouseCode: '', inStock: totalOnStock, committed: 0, onOrder: 0, available: totalOnStock }
      return stockResponse([row], itemCode, warehouseCode)
    }

    // Cả 4 bước đều không có dữ liệu → trả lỗi cụ thể để UI/Audit chẩn đoán
    const err1 = viaItem.ok ? '/Items trả rỗng ItemWarehouseInfoCollection' : (viaItem.error ?? 'Lỗi /Items')
    const err2 = child.ok ? 'Property trả rỗng' : (child.error ?? 'Lỗi property')
    const err3 = viaSelect.ok ? '$select trả rỗng' : (viaSelect.error ?? 'Lỗi $select')
    return NextResponse.json({ ok: false, source: 'sap', error: `Không đọc được tồn kho từ SAP B1 — ${err1}; ${err2}; ${err3}` }, { status: 502 })
  }

  // ---------- 2) Fallback local (chưa cấu hình SAP) ----------
  const item = await prisma.item.findUnique({ where: { itemCode } })
  if (!item) {
    return NextResponse.json({ ok: false, source: 'local', error: `Không tìm thấy mặt hàng ${itemCode}` }, { status: 404 })
  }
  const row: StockRow = { warehouseCode: '', inStock: item.stock, committed: 0, onOrder: 0, available: item.stock }
  return NextResponse.json({
    ok: true,
    source: 'local',
    itemCode,
    warehouses: [row],
    totals: { inStock: item.stock, committed: 0, onOrder: 0, available: item.stock },
    selected: warehouseCode ? null : row,
  })
}
