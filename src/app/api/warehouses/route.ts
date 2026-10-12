import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGetAll } from '@/lib/sap-service-layer'

interface B1Warehouse {
  WarehouseCode?: string
  WarehouseName?: string
}

// ---------- Cache danh sách kho 60s (giống partners/items) ----------
let whCache: { ts: number; key: string; data: { warehouseCode: string; warehouseName: string }[] } | null = null
const WH_TTL = 60_000

// GET /api/warehouses — danh sách Kho hàng (OWHS) để chọn "Kho hàng xuất bán"
// Truy vấn trực tiếp SAP B1 GET /Warehouses khi đã cấu hình; chưa cấu hình → trả rỗng.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const s = await loadSapSettings()
  if (!isSapConfigured(s)) {
    return NextResponse.json({ data: [], total: 0, source: 'none' })
  }

  const cacheKey = `${s.serviceLayerUrl}|${s.companyDb}`
  if (whCache && whCache.key === cacheKey && Date.now() - whCache.ts < WH_TTL) {
    return NextResponse.json({ data: whCache.data, total: whCache.data.length, source: 'sap', cached: true })
  }

  const live = await sapGetAll<B1Warehouse>(s, '/Warehouses', {
    $select: 'WarehouseCode,WarehouseName',
    $orderby: 'WarehouseCode',
  })
  if (!live.ok || !live.data) {
    return NextResponse.json({ data: [], total: 0, source: 'sap', error: live.error ?? 'Lỗi Service Layer' })
  }
  const data = live.data
    .filter((w) => w.WarehouseCode)
    .map((w) => ({ warehouseCode: w.WarehouseCode!, warehouseName: w.WarehouseName ?? w.WarehouseCode! }))
  whCache = { ts: Date.now(), key: cacheKey, data }
  return NextResponse.json({ data, total: data.length, source: 'sap' })
}
