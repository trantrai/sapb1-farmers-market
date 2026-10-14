import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { clearSapOrdersCache } from '@/lib/sap-orders'
import { rateLimit } from '@/lib/rate-limit'

type Ctx = { params: Promise<{ id: string }> }

// POST /api/orders/[id]/cancel — hủy đơn hàng (chỉ khi status=Open)
// Đơn đã hủy: không cho sửa, không cho copy delivery, không cho đẩy SAP.
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền hủy đơn hàng' }, { status: 403 })
  }
  const rl = rateLimit(`order:cancel:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  const { id } = await ctx.params
  // Đơn SAP trực tiếp (chưa có bản ghi local) → không hỗ trợ hủy local
  if (id.startsWith('sap-')) {
    return NextResponse.json({ error: 'Không thể hủy đơn lấy trực tiếp từ SAP B1' }, { status: 400 })
  }

  const order = await prisma.salesOrder.findUnique({ where: { id } })
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && order.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  if (order.status === 'Cancelled') {
    return NextResponse.json({ error: 'Đơn hàng đã được hủy trước đó' }, { status: 400 })
  }
  if (order.status !== 'Open') {
    return NextResponse.json({ error: 'Chỉ có thể hủy đơn hàng đang ở trạng thái Open' }, { status: 400 })
  }

  // Cảnh báo nếu đơn đã đẩy SAP — vẫn cho hủy local nhưng ghi chú rõ
  const wasSynced = order.sapSyncStatus === 'synced'

  const updated = await prisma.salesOrder.update({
    where: { id },
    data: { status: 'Cancelled', version: { increment: 1 } },
  })

  clearSapOrdersCache()
  return NextResponse.json({
    ok: true,
    order: updated,
    warning: wasSynced
      ? 'Đơn đã được đẩy lên SAP B1 trước đó — việc hủy chỉ áp dụng trên hệ thống local, cần hủy thủ công chứng từ trên SAP B1.'
      : null,
  })
}
