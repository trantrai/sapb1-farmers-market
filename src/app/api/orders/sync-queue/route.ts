import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import type { Prisma } from '@prisma/client'

// ---------- GET /api/orders/sync-queue : đơn chờ đồng bộ SAP B1 ----------
// Đơn đã lưu (không nháp, chưa hủy) nhưng chưa lên SAP: 'pending' / 'error'.
// ?limit=&offset= phân trang; ?count=1 chỉ trả số lượng (tile dashboard).
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }
  const sp = req.nextUrl.searchParams
  const where: Prisma.SalesOrderWhereInput = {
    sapSyncStatus: { in: ['pending', 'error'] },
    isDraft: false,
    status: { not: 'Cancelled' },
    // Chỉ đơn của DB SAP đang chọn (đơn cũ chưa gán DB vẫn hiện)
    ...(user.databaseId ? { OR: [{ sapDatabaseId: user.databaseId }, { sapDatabaseId: null }] } : {}),
  }

  const [total, reconcile] = await Promise.all([
    prisma.salesOrder.count({ where }),
    prisma.salesOrder.count({ where: { ...where, sapSyncErrorKind: 'reconcile' } }),
  ])
  if (sp.get('count') === '1') return NextResponse.json({ ok: true, total, reconcile })

  const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 20))
  const offset = Math.max(0, Number(sp.get('offset')) || 0)
  const rows = await prisma.salesOrder.findMany({
    where,
    orderBy: [{ sapSyncLastAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: limit,
    skip: offset,
    select: {
      id: true,
      docNum: true,
      cardCode: true,
      cardName: true,
      docDate: true,
      grandTotal: true,
      createdBy: true,
      createdAt: true,
      sapSyncStatus: true,
      sapSyncError: true,
      sapSyncErrorKind: true,
      sapSyncAttempts: true,
      sapNextRetryAt: true,
      sapSyncLastAt: true,
    },
  })
  return NextResponse.json({ ok: true, total, reconcile, limit, offset, orders: rows })
}
