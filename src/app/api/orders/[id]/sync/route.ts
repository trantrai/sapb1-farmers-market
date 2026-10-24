import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { syncOrderToSap } from '@/lib/order-sap-sync'

type Ctx = { params: Promise<{ id: string }> }

// ---------- POST /api/orders/[id]/sync : đẩy lại đơn sang SAP B1 ----------
// Dành cho đơn đang ở trạng thái 'pending' (lần đẩy trước thất bại do
// SAP mất kết nối / từ chối dữ liệu). Đơn đã 'synced' không đẩy lại.
// Đơn "Cần đối chiếu" (không rõ SAP đã ghi, không có UDF) bị chặn — trừ khi
// body { force: true } sau khi người dùng đã đối chiếu và xác nhận SAP chưa có đơn.
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền đẩy đơn hàng sang SAP B1' }, { status: 403 })
  }

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  const r = await syncOrderToSap(id, { force: body?.force === true, fallbackDatabaseId: user.databaseId })
  switch (r.kind) {
    case 'not_found':
      return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
    case 'cancelled':
      return NextResponse.json({ error: 'Không thể đẩy đơn đã hủy sang SAP B1' }, { status: 400 })
    case 'draft':
      return NextResponse.json({ error: 'Đơn nháp chưa duyệt — không đẩy sang SAP B1' }, { status: 400 })
    case 'already_synced':
      return NextResponse.json({ error: `Đơn này đã được đẩy sang SAP B1 (DocNum ${r.sapDocNum ?? '?'})` }, { status: 400 })
    case 'locked':
      return NextResponse.json(
        { error: 'Đơn này đang được đẩy sang SAP B1 ở một phiên khác — vui lòng đợi xong rồi thử lại.' },
        { status: 409 },
      )
    case 'needs_reconcile':
      return NextResponse.json(
        {
          error: 'Lần đẩy trước không rõ SAP đã nhận hay chưa — hãy đối chiếu trên SAP trước khi đẩy lại để tránh tạo trùng đơn.',
          code: 'NEEDS_RECONCILE',
        },
        { status: 409 },
      )
    case 'done':
      return NextResponse.json({ ok: r.ok, order: r.order, sap: { ...r.push, status: r.status, error: r.error ?? r.push.error } })
  }
}
