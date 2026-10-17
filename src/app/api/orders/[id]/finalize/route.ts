import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { pushOrderToSap } from '@/lib/sap-push-order'
import { acquireOrderPushLock, releaseOrderPushLock } from '@/lib/order-push-lock'

type Ctx = { params: Promise<{ id: string }> }

// ---------- PATCH /api/orders/[id]/finalize : duyệt nháp thành đơn hàng chính thức ----------
// Phase 2: body { version } — kiểm tra optimistic locking, yêu cầu isDraft=true + status Open,
// cấp docNum thật (max+1), set isDraft=false, rồi đẩy SAP B1 (POST /Orders) như khi tạo mới.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền duyệt đơn hàng' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as { version?: number } | null
  const version = body?.version
  if (typeof version !== 'number') {
    return NextResponse.json(
      { error: 'Thiếu version — vui lòng tải lại chứng từ', code: 'VERSION_REQUIRED' },
      { status: 400 },
    )
  }

  const order = await prisma.salesOrder.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  const sDb = await loadSapSettings(user.databaseId)
  if (sDb?.dbId && order.sapDatabaseId !== sDb.dbId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  if (version !== order.version) {
    return NextResponse.json(
      { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại chứng từ', code: 'VERSION_CONFLICT' },
      { status: 409 },
    )
  }
  if (!order.isDraft) {
    return NextResponse.json({ error: `Đơn này không phải nháp — đã có số ${order.docNum ?? ''}` }, { status: 400 })
  }
  if (order.status !== 'Open') {
    return NextResponse.json({ error: 'Chỉ có thể duyệt nháp đang ở trạng thái Open' }, { status: 400 })
  }
  if (!order.lines || order.lines.length === 0) {
    return NextResponse.json({ error: 'Nháp không có dòng hàng nào — không thể duyệt' }, { status: 400 })
  }

  // Cấp số thật + chuyển chính thức (1 transaction, retry khi trùng số như POST)
  let finalized: typeof order | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3 && !finalized; attempt++) {
    try {
      finalized = await prisma.$transaction(async (tx) => {
        const last = await tx.salesOrder.findFirst({ orderBy: { docNum: 'desc' } })
        const docNum = (last?.docNum ?? 1000) + 1
        return tx.salesOrder.update({
          where: { id, version },
          data: { isDraft: false, docNum, version: { increment: 1 } },
          include: { lines: { orderBy: { lineNum: 'asc' } } },
        })
      })
    } catch (e) {
      lastErr = e
      const code = (e as { code?: string })?.code
      if (code !== 'P2002' && code !== 'P2034' && code !== 'P2025') throw e
    }
  }
  if (!finalized) {
    const code = (lastErr as { code?: string } | null)?.code
    if (code === 'P2025') {
      return NextResponse.json(
        { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại chứng từ', code: 'VERSION_CONFLICT' },
        { status: 409 },
      )
    }
    throw lastErr ?? new Error('Không thể duyệt nháp')
  }

  // ---- Đẩy đơn sang SAP B1 (POST /Orders) như khi tạo mới ----
  const orderSap = await loadSapSettings(user.databaseId)
  const orderDbId = orderSap?.dbId ?? null
  let push: { status: string; docEntry?: number | null; docNum?: number | null; error?: string | null; lineNums?: (number | null)[] }
  if (acquireOrderPushLock(finalized.id)) {
    try {
      push = await pushOrderToSap({
        cardCode: finalized.cardCode,
        docDate: finalized.docDate.toISOString(),
        docDueDate: finalized.docDueDate.toISOString(),
        comments: finalized.remarks,
        headerDiscPct: Number(finalized.headerDiscPct) || 0,
        localId: finalized.id,
        databaseId: orderDbId,
        lines: finalized.lines.map((l) => ({
          itemCode: l.itemCode,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unitPrice),
          discPct: Number(l.discPct),
          uom: l.uom,
          taxCode: l.taxCode,
          warehouseCode: l.warehouseCode,
        })),
      })
    } finally {
      releaseOrderPushLock(finalized.id)
    }
  } else {
    push = { status: 'pending', error: 'Đơn đang được đẩy sang SAP ở một phiên khác — hãy bấm "Đẩy lại" sau.' }
  }
  const syncedOk = push.status === 'synced' && typeof push.docEntry === 'number'
  const finalStatus = !syncedOk && push.status === 'synced' ? 'pending' : push.status
  const finalError = !syncedOk && push.status === 'synced' ? 'SAP không trả về DocEntry — sẽ thử đẩy lại' : (push.error ?? null)
  if (syncedOk && push.lineNums?.length) {
    const dbLines = [...finalized.lines].sort((a, b) => a.lineNum - b.lineNum)
    await prisma.$transaction(
      dbLines.map((l, i) =>
        prisma.salesOrderLine.update({ where: { id: l.id }, data: { sapLineNum: push.lineNums?.[i] ?? null } }),
      ),
    )
  }
  const updated = await prisma.salesOrder.update({
    where: { id: finalized.id },
    data: {
      sapSyncStatus: finalStatus,
      sapSyncError: finalError,
      ...(syncedOk
        ? { sapDocEntry: push.docEntry ?? null, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() }
        : {}),
    },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })

  return NextResponse.json({
    ok: true,
    order: updated,
    sapStatus: finalStatus,
    ...(finalError ? { sapError: finalError } : {}),
  })
}
