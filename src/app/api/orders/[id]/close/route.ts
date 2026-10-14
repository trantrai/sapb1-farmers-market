import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { clearSapOrdersCache } from '@/lib/sap-orders'
import { loadSapSettings, isSapConfigured, sapCloseOrder } from '@/lib/sap-service-layer'
import { rateLimit } from '@/lib/rate-limit'

type Ctx = { params: Promise<{ id: string }> }

// POST /api/orders/[id]/close — đóng đơn hàng (chỉ khi status=Open)
// Nếu đơn đã đẩy SAP (có sapDocEntry): gọi POST /Orders({docEntry})/Close trước,
// thành công mới update local. Đơn local chưa đẩy: chỉ update local.
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đóng đơn hàng' }, { status: 403 })
  }
  const rl = rateLimit(`order:close:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  const { id } = await ctx.params
  // Đơn SAP trực tiếp (chưa có bản ghi local) → không hỗ trợ đóng local
  if (id.startsWith('sap-')) {
    return NextResponse.json({ error: 'Không thể đóng đơn lấy trực tiếp từ SAP B1' }, { status: 400 })
  }

  let body: { version?: number }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const version = body.version

  const order = await prisma.salesOrder.findUnique({ where: { id } })
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && order.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  if (order.status === 'Closed') {
    return NextResponse.json({ error: 'Đơn hàng đã được đóng trước đó' }, { status: 400 })
  }
  if (order.status !== 'Open') {
    return NextResponse.json({ error: 'Chỉ có thể đóng đơn hàng đang ở trạng thái Open' }, { status: 400 })
  }

  // Optimistic locking: version bắt buộc
  if (typeof version !== 'number') {
    return NextResponse.json(
      { error: 'Thiếu version — vui lòng tải lại đơn hàng', code: 'VERSION_REQUIRED' },
      { status: 400 },
    )
  }
  if (version !== order.version) {
    return NextResponse.json(
      { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại đơn hàng', code: 'VERSION_CONFLICT' },
      { status: 409 },
    )
  }

  // Nếu đơn đã đẩy SAP: gọi Close trên Service Layer trước
  if (order.sapSyncStatus === 'synced' && order.sapDocEntry) {
    const s = await loadSapSettings(order.sapDatabaseId ?? user.databaseId)
    if (!isSapConfigured(s)) {
      return NextResponse.json({ error: 'Chưa cấu hình SAP B1 Service Layer — không thể đóng chứng từ trên SAP' }, { status: 400 })
    }
    const result = await sapCloseOrder(s, order.sapDocEntry)
    if (!result.ok) {
      return NextResponse.json(
        { error: `Không thể đóng chứng từ trên SAP B1: ${result.error ?? 'lỗi không xác định'}` },
        { status: 502 },
      )
    }
  }

  const updated = await prisma.salesOrder.update({
    where: { id },
    data: { status: 'Closed', version: { increment: 1 } },
  })

  clearSapOrdersCache()
  return NextResponse.json({ ok: true, order: updated })
}
