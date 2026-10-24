import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { deliveryPattern } from '@/lib/delivery-pattern'

// ============================================================
// GET /api/orders/delivery-pattern?cardCode=
// Thói quen giao hàng của khách (thứ hay giao, số ngày giao sau đặt, kho hay
// xuất) suy từ tối đa 20 đơn chính thức trong 180 ngày — chỉ đọc DB nội bộ.
// data = null khi chưa đủ lịch sử.
// ============================================================

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create && !user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const cardCode = (req.nextUrl.searchParams.get('cardCode') ?? '').trim()
  if (!cardCode || cardCode.length > 50) {
    return NextResponse.json({ error: 'Thiếu mã khách hàng (cardCode)' }, { status: 400 })
  }

  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - 180)
  const orders = await prisma.salesOrder.findMany({
    where: {
      cardCode,
      docDate: { gte: fromDate },
      isDraft: false,
      status: { not: 'Cancelled' },
      ...(dbId ? { OR: [{ sapDatabaseId: dbId }, { sapDatabaseId: '' }, { sapDatabaseId: null }] } : {}),
    },
    orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
    take: 20,
    select: { docDate: true, docDueDate: true, warehouseCode: true },
  })
  return NextResponse.json({ data: deliveryPattern(orders) })
}
