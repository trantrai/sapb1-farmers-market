import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/stats — số liệu dashboard
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const [totalOrders, openOrders, closedOrders, overdueOrders, revenueAgg] = await Promise.all([
    prisma.salesOrder.count(),
    prisma.salesOrder.count({ where: { status: 'Open' } }),
    prisma.salesOrder.count({ where: { status: 'Closed' } }),
    prisma.salesOrder.findMany({ where: { status: 'Open' }, select: { docDueDate: true } }),
    prisma.salesOrder.aggregate({ _sum: { grandTotal: true }, where: { status: 'Closed' } }),
  ])

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const overdue = overdueOrders.filter((o) => new Date(o.docDueDate) < today).length

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
  })
}
