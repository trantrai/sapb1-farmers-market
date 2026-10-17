import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { pushOrderToSap } from '@/lib/sap-push-order'
import { acquireOrderPushLock, releaseOrderPushLock } from '@/lib/order-push-lock'

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
  if (order.status === 'Cancelled') {
    return NextResponse.json({ error: 'Không thể đẩy đơn đã hủy sang SAP B1' }, { status: 400 })
  }
  if (order.sapSyncStatus === 'synced') {
    return NextResponse.json(
      { error: `Đơn này đã được đẩy sang SAP B1 (DocNum ${order.sapDocNum ?? '?'})` },
      { status: 400 },
    )
  }
  // Khóa chống đẩy song song: 2 request cùng lúc không thể tạo trùng chứng từ SAP
  if (!acquireOrderPushLock(id)) {
    return NextResponse.json(
      { error: 'Đơn này đang được đẩy sang SAP B1 ở một phiên khác — vui lòng đợi xong rồi thử lại.' },
      { status: 409 },
    )
  }

  try {
    const push = await pushOrderToSap({
      // Đơn ghi nhận DB đích khi tạo — retry luôn dùng đúng DB đó
      databaseId: order.sapDatabaseId ?? user.databaseId,
      cardCode: order.cardCode,
      docDate: order.docDate.toISOString(),
      docDueDate: order.docDueDate.toISOString(),
      comments: order.remarks,
      localId: order.id,
      // B2B / SAP B1 (Đợt 2+3): các trường header đã lưu trên DB — tầng push
      // (buildSapDocPayload → sapDocHeaderExtras) chỉ gửi khi có giá trị
      salesPersonCode: order.salesPersonCode ?? null,
      paymentGroupCode: order.paymentGroupCode ?? null,
      shipToCode: order.shipToCode ?? null,
      billToCode: order.billToCode ?? null,
      numAtCard: order.numAtCard ?? null,
      taxDate: order.taxDate ?? null,
      docCurrency: order.docCurrency ?? null,
      docRate: order.docRate ?? null,
      projectCode: order.projectCode ?? null,
      reqDate: order.reqDate ?? null,
      lines: order.lines.map((l) => ({
        itemCode: l.itemCode,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discPct: l.discPct,
        uom: l.uom,
        taxCode: l.taxCode,
        warehouseCode: l.warehouseCode,
        // Đơn tạo từ báo giá (from-quotation): giữ sourceLineId để đẩy lại
        // vẫn gắn BaseType/BaseEntry/BaseLine chuẩn copy-to SAP B1
        sourceLineId: l.sourceLineId,
      })),
    })

    // Chỉ công nhận 'synced' khi SAP trả về DocEntry hợp lệ
    const syncedOk = push.status === 'synced' && typeof push.docEntry === 'number'
    const finalStatus = !syncedOk && push.status === 'synced' ? 'pending' : push.status
    const finalError = !syncedOk && push.status === 'synced'
      ? 'SAP không trả về DocEntry — sẽ thử đẩy lại'
      : (push.error ?? null)

    // Lưu LineNum do SAP cấp cho từng dòng — cần khi SỬA đơn (PATCH /Orders)
    if (syncedOk && push.lineNums?.length) {
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
        sapSyncStatus: finalStatus,
        sapSyncError: finalError,
        ...(syncedOk
          ? { sapDocEntry: push.docEntry ?? null, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() }
          : {}),
      },
    })

    return NextResponse.json({ ok: syncedOk, order: updated, sap: { ...push, status: finalStatus, error: finalError ?? push.error } })
  } finally {
    releaseOrderPushLock(id)
  }
}
