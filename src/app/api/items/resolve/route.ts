import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadSalesItems, vatRateMap, mapItem } from '@/lib/fm-items'
import { resolveKey, type ResolvedItem } from '@/lib/item-resolve'

// ============================================================
// POST /api/items/resolve  { keys: string[] }
// "Dán danh sách dòng hàng": tra mỗi key (mã / barcode / tên) ra mặt hàng.
// Thứ tự: khớp CHÍNH XÁC mã hàng → CHÍNH XÁC barcode → tên (đủ mọi từ,
// không phân biệt hoa thường/dấu). Nhiều mặt hàng khớp tên → 'ambiguous' kèm
// tối đa 5 ứng viên để người dùng chọn. Nguồn: mirror local; mirror trống →
// danh mục mặt hàng bán trên SAP (cache).
// ============================================================

const MAX_KEYS = 200

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  let body: { keys?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 }) }
  if (!Array.isArray(body.keys)) return NextResponse.json({ error: 'Thiếu danh sách keys' }, { status: 400 })
  const keys = body.keys
    .map((k) => (typeof k === 'string' ? k.trim().slice(0, 120) : ''))
    .filter(Boolean)
    .slice(0, MAX_KEYS)
  if (keys.length === 0) return NextResponse.json({ data: [] })

  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}

  let items: ResolvedItem[] = []
  const mirrorCount = await prisma.item.count({ where: dbScope })
  if (mirrorCount > 0) {
    const [rows, vg] = await Promise.all([
      prisma.item.findMany({
        where: dbScope,
        select: { itemCode: true, itemName: true, uom: true, price: true, taxCode: true, barcode: true },
      }),
      prisma.vatGroup.findMany({ where: dbScope, select: { code: true, rate: true, category: true } }),
    ])
    const rate = new Map<string, number>()
    for (const g of vg) if (g.rate != null && (g.category === 'S' || !rate.has(g.code))) rate.set(g.code, g.rate)
    items = rows.map((r) => ({
      itemCode: r.itemCode, itemName: r.itemName, uom: r.uom, price: r.price,
      taxCode: r.taxCode ?? '', vatRate: r.taxCode ? rate.get(r.taxCode) : undefined, barcode: r.barcode ?? '',
    }))
  } else if (isSapConfigured(s)) {
    const { rows, error } = await loadSalesItems(s)
    if (rows.length === 0 && error) return NextResponse.json({ data: [], error }, { status: 502 })
    const vm = await vatRateMap(s)
    items = rows.map((r) => mapItem(r, vm))
  }

  return NextResponse.json({ data: keys.map((k) => resolveKey(k, items)) })
}
