import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/dashboard/stats?range=7|30 — số liệu biểu đồ dashboard
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  // B1: cách ly DB
  const dbScope = user.databaseId ? { sapDatabaseId: user.databaseId } : {}
  const sp = req.nextUrl.searchParams
  const range = sp.get('range') === '30' ? 30 : 7

  const end = new Date()
  end.setHours(23, 59, 59, 999)
  const start = new Date()
  start.setDate(start.getDate() - (range - 1))
  start.setHours(0, 0, 0, 0)

  // Doanh số theo ngày (dựa trên grandTotal của đơn trong khoảng)
  const orders = await prisma.salesOrder.findMany({
    where: { ...dbScope, docDate: { gte: start, lte: end } },
    select: { docDate: true, grandTotal: true },
  })

  const byDay = new Map<string, number>()
  for (let i = 0; i < range; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const key = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
    byDay.set(key, 0)
  }
  for (const o of orders) {
    const d = new Date(o.docDate)
    const key = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + (o.grandTotal ?? 0))
  }
  const revenueByDay = [...byDay.entries()].map(([day, total]) => ({ day, total: Math.round(total) }))

  // Top 5 khách hàng theo doanh số
  const topCustomersRaw = await prisma.salesOrder.groupBy({
    by: ['cardCode', 'cardName'],
    where: { ...dbScope, docDate: { gte: start, lte: end } },
    _sum: { grandTotal: true },
    _count: { _all: true },
    orderBy: { _sum: { grandTotal: 'desc' } },
    take: 5,
  })
  const topCustomers = topCustomersRaw.map((c) => ({
    cardCode: c.cardCode,
    cardName: c.cardName,
    total: Math.round(c._sum.grandTotal ?? 0),
    orderCount: c._count._all,
  }))

  // Top 5 mặt hàng bán chạy theo số lượng
  const topItemsRaw = await prisma.salesOrderLine.groupBy({
    by: ['itemCode', 'itemName'],
    where: { order: { ...dbScope, docDate: { gte: start, lte: end } } },
    _sum: { quantity: true, grandTotal: true },
    orderBy: { _sum: { quantity: 'desc' } },
    take: 5,
  })
  const topItems = topItemsRaw.map((l) => ({
    itemCode: l.itemCode,
    itemName: l.itemName,
    quantity: Math.round((l._sum.quantity ?? 0) * 100) / 100,
    total: Math.round(l._sum.grandTotal ?? 0),
  }))

  return NextResponse.json({ range, revenueByDay, topCustomers, topItems })
}
