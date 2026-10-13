import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/stats — số liệu dashboard
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  // B1: cách ly DB
  const dbScope = user.databaseId ? { sapDatabaseId: user.databaseId } : {}
  const [totalOrders, openOrders, closedOrders, overdueOrders, revenueAgg] = await Promise.all([
    prisma.salesOrder.count({ where: dbScope }),
    prisma.salesOrder.count({ where: { ...dbScope, status: 'Open' } }),
    prisma.salesOrder.count({ where: { ...dbScope, status: 'Closed' } }),
    prisma.salesOrder.findMany({ where: { ...dbScope, status: 'Open' }, select: { docDueDate: true } }),
    prisma.salesOrder.aggregate({ _sum: { grandTotal: true }, where: { ...dbScope, status: 'Closed' } }),
  ])

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const overdue = overdueOrders.filter((o) => new Date(o.docDueDate) < today).length

  // Đơn cần chú ý: Open + (quá hạn hoặc hạn trong 3 ngày tới), quá hạn nhất lên trước
  const soonEnd = new Date(today)
  soonEnd.setDate(soonEnd.getDate() + 3)
  soonEnd.setHours(23, 59, 59, 999)
  const attention = await prisma.salesOrder.findMany({
    where: { status: 'Open', docDueDate: { lte: soonEnd } },
    orderBy: { docDueDate: 'asc' },
    take: 5,
    select: {
      id: true,
      docNum: true,
      cardCode: true,
      cardName: true,
      docDate: true,
      docDueDate: true,
      status: true,
      grandTotal: true,
    },
  })

  const recent = await prisma.salesOrder.findMany({
    orderBy: { docNum: 'desc' },
    take: 5,
  })

  return NextResponse.json({
    totalOrders,
    openOrders,
    closedOrders,
    overdueOrders: overdue,
    revenueClosed: revenueAgg._sum.grandTotal ?? 0,
    recent,
    attention,
  })
}
