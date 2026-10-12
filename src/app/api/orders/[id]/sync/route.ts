import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { pushOrderToSap } from '@/lib/sap-push-order'

type Ctx = { params: Promise<{ id: string }> }

// ---------- POST /api/orders/[id]/sync : đẩy lại đơn sang SAP B1 ----------
// Dành cho đơn đang ở trạng thái 'pending' (lần đẩy trước thất bại do
// SAP mất kết nối / từ chối dữ liệu). Đơn đã 'synced' không đẩy lại.
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền đẩy đơn hàng sang SAP B1' }, { status: 403 })
  }

  const { id } = await ctx.params
  const order = await prisma.salesOrder.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  if (order.sapSyncStatus === 'synced') {
    return NextResponse.json(
      { error: `Đơn này đã được đẩy sang SAP B1 (DocNum ${order.sapDocNum ?? '?'})` },
      { status: 400 },
    )
  }

  const push = await pushOrderToSap({
    cardCode: order.cardCode,
    docDate: order.docDate.toISOString(),
    docDueDate: order.docDueDate.toISOString(),
    comments: order.remarks,
    lines: order.lines.map((l) => ({
      itemCode: l.itemCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct,
      taxCode: l.taxCode,
      warehouseCode: l.warehouseCode,
    })),
  })

  // Lưu LineNum do SAP cấp cho từng dòng — cần khi SỬA đơn (PATCH /Orders)
  if (push.status === 'synced' && push.lineNums?.length) {
    const dbLines = [...order.lines].sort((a, b) => a.lineNum - b.lineNum)
    await prisma.$transaction(
      dbLines.map((l, i) =>
        prisma.salesOrderLine.update({ where: { id: l.id }, data: { sapLineNum: push.lineNums?.[i] ?? null } }),
      ),
    )
  }

  const updated = await prisma.salesOrder.update({
    where: { id: order.id },
    data: {
      sapSyncStatus: push.status,
      sapSyncError: push.error ?? null,
      ...(push.status === 'synced'
        ? { sapDocEntry: push.docEntry ?? null, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() }
        : {}),
    },
  })

  return NextResponse.json({ ok: push.status === 'synced', order: updated, sap: push })
}
