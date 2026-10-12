import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGet, sapGetAll } from '@/lib/sap-service-layer'

// ============================================================
// ATP CHECK — Tồn kho khả dụng (Available-to-Promise)
// Chuỗi truy vấn SAP B1 (tự dự phòng theo phiên bản Service Layer):
//   1) GET /Items('X') THUẦN — ItemWarehouseInfo là collection CẤU TRÚC
//      được trả sẵn trong body trên phần lớn bản SL (an toàn nhất, không
//      phụ thuộc $expand mà nhiều bản SL từ chối với lỗi 201/400)
//   2) Fallback: GET /Items('X')/ItemWarehouseInfo (tập con, tự phân trang)
//   3) Chốt cuối: GET /Items('X')?$expand=ItemWarehouseInfo
//   4) Dự phòng cuối: QuantityOnStock (tổng tồn toàn kho) → 1 dòng tổng hợp
// ⚠ KHÔNG dùng /InventoryItems — một số bản SL thật không có resource này
//   (400 "Unrecognized resource path").
// ATP = InStock − Committed + OnOrder  (tồn − đã cam kết + đang về)
// Chưa cấu hình SAP → fallback tồn kho local (bảng Item.stock).
// ============================================================

interface B1InvWarehouse {
  WarehouseCode?: string
  InStock?: number | string
  IsCommitted?: number | string
  OnOrder?: number | string
  /** Biến thể tên trường trên ItemWarehouseInfo của một số phiên bản SL */
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
    const committed = n(w.IsCommitted ?? w.CommittedOnStock)
    const onOrder = n(w.OnOrder ?? w.OrderedOnStock)
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

/** Chuẩn hóa ItemWarehouseInfo/Warehouses: mảng trực tiếp hoặc {results:[…]} (OData v2) */
function asWhsArray(x: unknown): B1InvWarehouse[] {
  if (Array.isArray(x)) return x as B1InvWarehouse[]
  if (x && typeof x === 'object') {
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
    // Bước 1: GET /Items('X') THUẦN — ItemWarehouseInfo là collection cấu trúc
    // trả sẵn trong body, chạy được trên phần lớn bản SL (kể cả bản chặn $expand)
    const viaItem = await sapGet<B1InventoryItem & { ItemWarehouseInfo?: unknown; QuantityOnStock?: number | string }>(
      s,
      `/Items('${esc}')`,
    )
    let whs = asWhsArray(viaItem.ok ? viaItem.data?.ItemWarehouseInfo : undefined)
    if (whs.length > 0) {
      return stockResponse(toStockRows(whs), itemCode, warehouseCode)
    }

    // Bước 2 (fallback): tập con /Items('X')/ItemWarehouseInfo — tự phân trang
    const child = await sapGetAll<B1InvWarehouse>(s, `/Items('${esc}')/ItemWarehouseInfo`)
    if (child.ok && child.data && child.data.length > 0) {
      return stockResponse(toStockRows(child.data), itemCode, warehouseCode)
    }

    // Bước 3 (chốt cuối): $expand — cho bản SL chỉ trả kho con qua expand
    const viaExpand = await sapGet<B1InventoryItem & { ItemWarehouseInfo?: unknown }>(
      s,
      `/Items('${esc}')`,
      { $expand: 'ItemWarehouseInfo' },
    )
    whs = asWhsArray(viaExpand.ok ? viaExpand.data?.ItemWarehouseInfo : undefined)
    if (whs.length > 0) {
      return stockResponse(toStockRows(whs), itemCode, warehouseCode)
    }

    // Bước 4 (dự phòng cuối): chỉ còn tổng tồn toàn kho (QuantityOnStock) —
    // SL quá hạn chế (không trả ItemWarehouseInfo ở bất kỳ dạng nào) thì vẫn
    // hiển thị được 1 dòng ATP tổng hợp thay vì báo lỗi.
    const totalOnStock = n(viaItem.ok ? viaItem.data?.QuantityOnStock : undefined)
    if (viaItem.ok && totalOnStock > 0) {
      const row: StockRow = { warehouseCode: '', inStock: totalOnStock, committed: 0, onOrder: 0, available: totalOnStock }
      return stockResponse([row], itemCode, warehouseCode)
    }

    // Cả 4 bước đều không có dữ liệu → trả lỗi cụ thể để UI/Audit chẩn đoán
    const err1 = viaItem.ok ? '/Items trả rỗng ItemWarehouseInfo' : (viaItem.error ?? 'Lỗi /Items')
    const err2 = child.ok ? 'Tập con trả rỗng' : (child.error ?? 'Lỗi tập con')
    const err3 = viaExpand.ok ? '$expand trả rỗng' : (viaExpand.error ?? 'Lỗi $expand')
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
