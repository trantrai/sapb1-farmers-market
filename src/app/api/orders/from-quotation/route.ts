import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { dedupeRequest, acquireOrderLock, releaseOrderLock } from '@/lib/idempotency'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { pushOrderToSap, type SapPushResult } from '@/lib/sap-push-order'
import { acquireOrderPushLock, releaseOrderPushLock } from '@/lib/order-push-lock'
import { calcOrderLines, orderTotals, validateOrderLines } from '@/lib/order-calc'

// POST /api/orders/from-quotation — tạo Sales Order từ Báo giá bán hàng
// (copy-to chuẩn SAP B1: Quotation → Order).
// body: { quotationId: string }
// Hành vi tạo đơn + đẩy SAP giống hệt POST /api/orders (docNum max+1,
// tính totals qua @/lib/order-calc, đẩy /Orders khi đã cấu hình SAP) —
// chỉ khác nguồn dòng hàng lấy từ báo giá. Giữ chiết khấu đầu chứng từ
// và cấu trúc dòng BOM của báo giá; ngày giao hàng giữ theo báo giá.
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo đơn hàng' }, { status: 403 })
  }
  const rl = rateLimit(`order:from-quotation:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  const body = (await req.json().catch(() => null)) as { quotationId?: unknown } | null
  const quotationId = String(body?.quotationId ?? '').trim()
  if (!quotationId) {
    return NextResponse.json({ error: 'Thiếu quotationId' }, { status: 400 })
  }

  const run = async (): Promise<{ body: unknown; status: number }> => {
    const quotation = await prisma.quotation.findUnique({
      where: { id: quotationId },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    if (!quotation) {
      return { body: { error: 'Không tìm thấy báo giá' }, status: 404 }
    }
    // B1: cách ly DB
    if (user.databaseId && quotation.sapDatabaseId !== user.databaseId) {
      return { body: { error: 'Không tìm thấy báo giá' }, status: 404 }
    }
    if (quotation.status === 'Cancelled') {
      return { body: { error: 'Không thể tạo đơn hàng từ báo giá đã hủy' }, status: 400 }
    }
    // Giữ reference đã narrow non-null để dùng trong closure createOrderTx
    const qdoc = quotation

    const inputLines = qdoc.lines.map((l) => ({
      itemCode: l.itemCode,
      itemName: l.itemName,
      uom: l.uom,
      warehouseCode: l.warehouseCode ?? undefined,
      taxCode: l.taxCode ?? undefined,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct,
      vatPct: l.vatPct,
      isBomChild: l.isBomChild,
      bomGroupKey: l.bomGroupKey,
      bomEditable: l.bomEditable,
      bomQtyPerParent: l.bomQtyPerParent,
    }))
    const { lines: validLines, error: linesError } = validateOrderLines(inputLines)
    if (linesError) {
      return { body: { error: linesError }, status: 400 }
    }

    const headerPct = Math.min(100, Math.max(0, Number(qdoc.headerDiscPct) || 0))
    const calcLines = calcOrderLines(validLines, headerPct)
    const { totalBeforeDisc, discountAmt, headerDiscAmt, vatAmt, grandTotal } = orderTotals(calcLines)

    const orderSap = await loadSapSettings(user.databaseId)
    const orderDbId = orderSap?.dbId ?? null
    const createdBy = user.username

    // Cấp docNum max+1 + tạo đơn trong 1 transaction, retry khi trùng số
    // (giống POST /api/orders — route này chỉ thêm file mới, không sửa route cũ)
    let created: Awaited<ReturnType<typeof createOrderTx>> | null = null
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      try {
        created = await createOrderTx()
      } catch (e) {
        lastErr = e
        const code = (e as { code?: string })?.code
        if (code !== 'P2002' && code !== 'P2034') throw e
        // trùng docNum → thử lại vòng sau sẽ đọc lại số mới nhất
      }
    }
    if (!created) throw lastErr ?? new Error('Không thể cấp số chứng từ')
    async function createOrderTx() {
      return prisma.$transaction(async (tx) => {
        const last = await tx.salesOrder.findFirst({ orderBy: { docNum: 'desc' } })
        const docNum = (last?.docNum ?? 1000) + 1
        return tx.salesOrder.create({
          data: {
            docNum,
            cardCode: qdoc.cardCode,
            cardName: qdoc.cardName,
            docDate: new Date(),
            docDueDate: qdoc.docDueDate,
            remarks: `Sao chép từ báo giá #${qdoc.docNum}`,
            warehouseCode: qdoc.warehouseCode,
            totalBeforeDisc,
            discountAmt,
            headerDiscPct: headerPct,
            headerDiscAmt,
            vatAmt,
            grandTotal,
            createdBy,
            sapDatabaseId: orderDbId,
            lines: {
              create: calcLines.map((l, i) => ({
                lineNum: i + 1,
                itemCode: l.itemCode,
                itemName: l.itemName,
                uom: l.uom || 'kg',
                taxCode: l.taxCode?.trim() || null,
                warehouseCode: (l.warehouseCode || qdoc.warehouseCode || '').trim() || null,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                lineTotal: l.lineTotal,
                discPct: l.discPct,
                discAmt: l.discAmt,
                vatPct: l.vatPct,
                vatAmt: l.vatAmt,
                grandTotal: l.grandTotal,
                isBomChild: l.isBomChild ?? false,
                bomGroupKey: (l.bomGroupKey as string | null | undefined) ?? null,
                bomEditable: l.bomEditable ?? true,
                bomQtyPerParent: l.bomQtyPerParent ?? null,
              })),
            },
          },
          include: { lines: true },
        })
      })
    }

    // ---- Đẩy đơn sang SAP B1 (POST /Orders) — giống POST /api/orders ----
    // Thất bại thì đánh dấu 'pending' để đẩy lại từ danh sách đơn.
    let push: SapPushResult
    if (acquireOrderPushLock(created.id)) {
      try {
        push = await pushOrderToSap({
          cardCode: qdoc.cardCode,
          docDate: created.docDate.toISOString(),
          docDueDate: created.docDueDate.toISOString(),
          comments: created.remarks,
          headerDiscPct: headerPct,
          localId: created.id,
          databaseId: orderDbId,
          lines: created.lines.map((l) => ({
            itemCode: l.itemCode,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discPct: l.discPct,
            taxCode: l.taxCode,
            warehouseCode: l.warehouseCode,
          })),
        })
      } finally {
        releaseOrderPushLock(created.id)
      }
    } else {
      push = { status: 'pending', error: 'Đơn đang được đẩy sang SAP ở một phiên khác — hãy bấm "Đẩy lại" sau.' }
    }
    // Chỉ công nhận 'synced' khi SAP trả về DocEntry hợp lệ
    const syncedOk = push.status === 'synced' && typeof push.docEntry === 'number'
    const finalStatus = !syncedOk && push.status === 'synced' ? 'pending' : push.status
    const finalError = !syncedOk && push.status === 'synced' ? 'SAP không trả về DocEntry — sẽ thử đẩy lại' : (push.error ?? null)
    // Lưu LineNum do SAP cấp cho từng dòng — cần khi SỬA đơn (PATCH /Orders)
    if (syncedOk && push.lineNums?.length) {
      const dbLines = [...created.lines].sort((a, b) => a.lineNum - b.lineNum)
      await prisma.$transaction(
        dbLines.map((l, i) =>
          prisma.salesOrderLine.update({ where: { id: l.id }, data: { sapLineNum: push.lineNums?.[i] ?? null } }),
        ),
      )
    }
    const order = await prisma.salesOrder.update({
      where: { id: created.id },
      data: {
        sapSyncStatus: finalStatus,
        sapSyncError: finalError,
        ...(syncedOk
          ? { sapDocEntry: push.docEntry ?? null, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() }
          : {}),
      },
      include: { lines: true },
    })

    return { body: { ok: true, order, sap: { ...push, status: finalStatus, error: finalError ?? push.error } }, status: 201 }
  }

  // Chống bấm đúp "Tạo đơn từ báo giá": 2 request cùng báo giá trong 30s
  // chỉ tạo 1 đơn — lượt trùng nhận lại kết quả của lượt đầu.
  const dedupeKey = `order:from-quotation:${user.id}:${quotationId}`
  const lockKey = `order:from-quotation:${quotationId}`
  if (!acquireOrderLock(lockKey)) {
    return NextResponse.json(
      { error: 'Báo giá này đang được tạo đơn hàng ở một phiên khác — vui lòng đợi' },
      { status: 409 },
    )
  }
  try {
    const { result, replayed } = await dedupeRequest(dedupeKey, run)
    return NextResponse.json(result.body, { status: replayed ? 200 : result.status })
  } finally {
    releaseOrderLock(lockKey)
  }
}
