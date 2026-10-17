import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// ---------- GET /api/orders/suggest-items?cardCode=XXX ----------
// Gợi ý mặt hàng dựa trên lịch sử đơn hàng của khách hàng.
// Sắp xếp: tần suất xuất hiện (số đơn có mặt hàng) DESC, tổng số lượng DESC.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const cardCode = (req.nextUrl.searchParams.get('cardCode') || '').trim()
  if (!cardCode) {
    return NextResponse.json({ error: 'Thiếu mã khách hàng (cardCode)' }, { status: 400 })
  }

  // Đọc setting khoảng thời gian + số lượng tối đa
  let settings = await prisma.appSettings.findUnique({ where: { id: 'main' } })
  if (!settings) {
    settings = await prisma.appSettings.create({ data: { id: 'main' } })
  }
  const historyDays = settings.suggestHistoryDays ?? 90
  const maxItems = settings.suggestMaxItems ?? 10
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - historyDays)

  // Lấy các đơn của khách hàng trong khoảng thời gian (kèm dòng hàng)
  // B1: cách ly DB
  const dbScope = user.databaseId ? { OR: [{ sapDatabaseId: user.databaseId }, { sapDatabaseId: "" }] } : {}
  const orders = await prisma.salesOrder.findMany({
    where: { ...dbScope, cardCode, docDate: { gte: fromDate } },
    select: {
      id: true,
      docDate: true,
      lines: {
        select: {
          itemCode: true,
          itemName: true,
          quantity: true,
          unitPrice: true,
          uom: true,
          taxCode: true,
          warehouseCode: true,
        },
      },
    },
    orderBy: { docDate: 'desc' },
  })

  // Gom theo itemCode
  interface Agg {
    itemCode: string
    itemName: string
    orderCount: number
    totalQty: number
    lastPrice: number
    lastDate: string
    uom?: string
    taxCode?: string
    warehouseCode?: string
  }
  const map = new Map<string, Agg>()
  for (const o of orders) {
    const seenInOrder = new Set<string>()
    for (const l of o.lines) {
      let agg = map.get(l.itemCode)
      if (!agg) {
        agg = {
          itemCode: l.itemCode,
          itemName: l.itemName,
          orderCount: 0,
          totalQty: 0,
          lastPrice: l.unitPrice,
          lastDate: o.docDate.toISOString(),
          uom: l.uom ?? undefined,
          taxCode: l.taxCode ?? undefined,
          warehouseCode: l.warehouseCode ?? undefined,
        }
        map.set(l.itemCode, agg)
      }
      if (!seenInOrder.has(l.itemCode)) {
        seenInOrder.add(l.itemCode)
        agg.orderCount += 1
      }
      agg.totalQty += l.quantity
      // Đơn đã sort desc theo docDate → lần gặp đầu tiên là gần nhất
      // (giữ nguyên lastPrice/lastDate/uom/taxCode/warehouseCode từ lần đầu)
    }
  }

  const items = [...map.values()]
    .sort((a, b) => b.orderCount - a.orderCount || b.totalQty - a.totalQty)
    .slice(0, maxItems)

  return NextResponse.json({ ok: true, data: items, historyDays, maxItems })
}
