import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadSalesItems, vatRateMap, mapItem } from '@/lib/fm-items'
import { IMPORT_MAX_ROWS, matchImportRows, type ImportItem } from '@/lib/order-import'

// ============================================================
// POST /api/orders/import-match  body { rows: [{ code, name }] }
// Khớp các dòng Excel với danh mục mặt hàng: mã hàng → mã vạch → tên gần đúng.
// Một request cho cả file (thay vì tra từng mã). CHỈ ĐỌC: ưu tiên mirror local
// đã đồng bộ; mirror trống mà có cấu hình SAP → dùng cache danh mục SAP (5 phút).
// ============================================================

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create && !user.permissions.orders?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo/sửa đơn hàng' }, { status: 403 })
  }

  const body = await req.json().catch(() => null)
  const raw: unknown[] = Array.isArray(body?.rows) ? body.rows : []
  if (raw.length === 0) return NextResponse.json({ error: 'Không có dòng nào để khớp' }, { status: 400 })
  if (raw.length > IMPORT_MAX_ROWS) {
    return NextResponse.json({ error: `Tối đa ${IMPORT_MAX_ROWS} dòng mỗi lần nhập` }, { status: 400 })
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 200) : '')
  const rows = raw.map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    return { code: str(o.code), name: str(o.name) }
  })

  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}

  let catalog: ImportItem[] = []
  let source: 'mirror' | 'sap' | 'local' = 'local'
  if ((await prisma.item.count({ where: dbScope })) > 0) {
    source = 'mirror'
    const [items, vgRows] = await Promise.all([
      prisma.item.findMany({
        where: dbScope,
        select: { itemCode: true, itemName: true, uom: true, price: true, taxCode: true, barcode: true },
      }),
      prisma.vatGroup.findMany({ where: dbScope, select: { code: true, rate: true, category: true } }),
    ])
    // Thuế suất theo mã thuế (ưu tiên nhóm BÁN) — giống /api/items
    const rateMap = new Map<string, number>()
    for (const g of vgRows) {
      if (g.rate == null) continue
      if (g.category === 'S' || !rateMap.has(g.code)) rateMap.set(g.code, g.rate)
    }
    catalog = items.map((it) => ({ ...it, vatRate: it.taxCode ? rateMap.get(it.taxCode) ?? null : null }))
  } else if (isSapConfigured(s)) {
    source = 'sap'
    const { rows: b1, error } = await loadSalesItems(s)
    if (b1.length === 0 && error) return NextResponse.json({ error }, { status: 502 })
    const vatMap = await vatRateMap(s)
    catalog = b1.map((it) => mapItem(it, vatMap))
  }

  const matches = matchImportRows(rows, catalog)
  return NextResponse.json({ ok: true, source, catalogSize: catalog.length, matches })
}
