import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { patchOrderToSap } from '@/lib/sap-push-order'
import { fetchSapOrderDetail, clearSapOrdersCache } from '@/lib/sap-orders'
import { calcOrderLines, orderTotals, validateOrderLines } from '@/lib/order-calc'
import { normalizeBomLines } from '@/lib/order-bom'

type Ctx = { params: Promise<{ id: string }> }

// ---------- GET chi tiết ----------
export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const { id } = await ctx.params

  // ---------- Đơn lấy TRỰC TIẾP từ SAP B1 (id dạng 'sap-<DocEntry>', chưa có bản ghi local) ----------
  // Lấy chi tiết từ Service Layer, giống logic ở PUT.
  if (id.startsWith('sap-')) {
    const docEntry = Number(id.slice(4))
    if (!Number.isInteger(docEntry) || docEntry <= 0) {
      return NextResponse.json({ error: 'DocEntry không hợp lệ' }, { status: 400 })
    }
    const s = await loadSapSettings(user.databaseId)
    if (!isSapConfigured(s)) {
      return NextResponse.json({ error: 'Chưa cấu hình SAP B1 Service Layer' }, { status: 400 })
    }
    const cur = await fetchSapOrderDetail(s, docEntry)
    if (!cur.ok || !cur.order) {
      return NextResponse.json(
        { error: `Không đọc được chứng từ từ SAP B1 — ${cur.error ?? 'lỗi không rõ'}` },
        { status: 502 },
      )
    }
    return NextResponse.json({ order: cur.order })
  }

  const order = await prisma.salesOrder.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNum: 'asc' } },
      deliveries: {
        select: { id: true, docNum: true, docDate: true, status: true, grandTotal: true, sapSyncStatus: true },
        orderBy: { docNum: 'asc' },
      },
    },
  })
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  // B1: cách ly DB — không cho xem đơn của database khác
  if (user.databaseId && (order as { sapDatabaseId?: string }).sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }

  // Bổ sung bomType thật của dòng cha BOM từ mirror Item (để UI ẩn/hiện
  // dòng con đúng cả với đơn cũ lưu bomEditable chưa chuẩn).
  const dbScope = (order as { sapDatabaseId?: string }).sapDatabaseId
    ? { sapDatabaseId: (order as { sapDatabaseId: string }).sapDatabaseId }
    : {}
  const parentCodes = [...new Set(
    order.lines.filter((l) => l.bomGroupKey && !l.isBomChild).map((l) => l.itemCode),
  )]
  let bomTypeMap = new Map<string, string>()
  if (parentCodes.length > 0) {
    const items = await prisma.item.findMany({
      where: { ...dbScope, itemCode: { in: parentCodes } },
      select: { itemCode: true, bomType: true },
    })
    bomTypeMap = new Map(items.map((it) => [it.itemCode, it.bomType]))
  }
  const lines = order.lines.map((l) => ({
    ...l,
    bomType: !l.isBomChild && l.bomGroupKey ? (bomTypeMap.get(l.itemCode) ?? 'none') : undefined,
  }))
  return NextResponse.json({ order: { ...order, lines } })
}

// ---------- PUT : SỬA đơn hàng đang Open ----------
// Đơn CHƯA đẩy SAP (none/pending) hoặc chưa cấu hình SL → chỉ cập nhật local.
// Đơn ĐÃ synced → PATCH /Orders(DocEntry) trên Service Layer TRƯỚC (B1S-
// ReplaceCollectionsOnPatch: dòng có LineNum → cập nhật, dòng mới không
// LineNum → thêm, dòng bị bỏ → xóa), PATCH thành công mới cập nhật local.
// PATCH thất bại → KHÔNG lưu local (tránh lệch dữ liệu giữa 2 hệ thống).
export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền sửa đơn hàng' }, { status: 403 })
  }

  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  const {
    cardCode, cardName, docDate, docDueDate, remarks, warehouseCode,
    headerDiscPct,
    lines,
  } = (body ?? {}) as {
    cardCode?: string; cardName?: string; docDate?: string; docDueDate?: string
    remarks?: string
    warehouseCode?: string
    /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
    headerDiscPct?: number
    lines?: Array<{
      dbId?: string; sapLineNum?: number
      itemCode: string; itemName: string; uom: string; quantity: number
      unitPrice: number; discPct?: number; vatPct?: number; taxCode?: string; warehouseCode?: string
      isBomChild?: boolean; bomGroupKey?: string | null; bomEditable?: boolean; bomQtyPerParent?: number | null
    }>
  }

  if (!cardCode || !cardName) {
    return NextResponse.json({ error: 'Vui lòng chọn khách hàng (CardCode)' }, { status: 400 })
  }
  if (!docDate || !docDueDate) {
    return NextResponse.json({ error: 'Vui lòng chọn ngày chứng từ và ngày giao hàng' }, { status: 400 })
  }
  // DB của đơn (để validate BOM đúng mirror) — đơn 'sap-*' chưa có local → dùng DB phiên
  const orderDbHint = id.startsWith('sap-')
    ? null
    : await prisma.salesOrder.findUnique({ where: { id }, select: { sapDatabaseId: true } })
  const bomDbId = orderDbHint?.sapDatabaseId ?? user.databaseId ?? null
  const { lines: validLines, error: linesError } = validateOrderLines(lines)
  if (linesError) {
    return NextResponse.json({ error: linesError }, { status: 400 })
  }
  // Validate nhóm BOM: Production phải đúng công thức, Template kiểm tra mã con
  const { lines: bomLines, error: bomError } = await normalizeBomLines(bomDbId, validLines)
  if (bomError) {
    return NextResponse.json({ error: bomError }, { status: 400 })
  }

  const headerPct = Math.min(100, Math.max(0, Number(headerDiscPct) || 0))
  const calcLines = calcOrderLines(bomLines, headerPct)
  const { totalBeforeDisc, discountAmt, headerDiscAmt, vatAmt, grandTotal } = orderTotals(calcLines)

  // ---------- 0) Đơn lấy TRỰC TIẾP từ SAP B1 (id dạng 'sap-<DocEntry>', chưa có bản ghi local) ----------
  // Sửa thẳng chứng từ trên Service Layer bằng PATCH /Orders(DocEntry); không
  // tạo bản ghi local để tránh trùng lặp trong danh sách (danh sách luôn đọc từ SL).
  if (id.startsWith('sap-')) {
    const docEntry = Number(id.slice(4))
    if (!Number.isInteger(docEntry) || docEntry <= 0) {
      return NextResponse.json({ error: 'DocEntry không hợp lệ' }, { status: 400 })
    }
    const s = await loadSapSettings(user.databaseId)
    if (!isSapConfigured(s)) {
      return NextResponse.json({ error: 'Chưa cấu hình SAP B1 Service Layer' }, { status: 400 })
    }
    const cur = await fetchSapOrderDetail(s, docEntry)
    if (!cur.ok || !cur.order) {
      return NextResponse.json(
        { error: `Không đọc được chứng từ từ SAP B1 — ${cur.error ?? 'lỗi không rõ'}` },
        { status: 502 },
      )
    }
    if (cur.order.status !== 'Open') {
      return NextResponse.json({ error: 'Chỉ có thể sửa đơn hàng đang ở trạng thái Open' }, { status: 400 })
    }
    // LineNum của dòng hiện có: ưu tiên sapLineNum lấy từ chi tiết SL khi mở form;
    // thiếu → khớp theo cặp (ItemCode, WarehouseCode) trên chứng từ hiện tại
    // (ItemCode có thể lặp ở 2 dòng khác kho); vẫn thiếu → khớp theo thứ tự dòng.
    // Dòng mới → null = thêm mới.
    const usedLn = new Set<number>()
    const resolveLn = (itemCode: string, warehouseCode: string | undefined, sapLineNum?: number, fallbackIdx?: number): number | null => {
      if (typeof sapLineNum === 'number') return sapLineNum
      const slLines = cur.order!.lines
      const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase()
      const byPair = slLines.find((l) => !usedLn.has(l.lineNum) && l.itemCode === itemCode && norm(l.warehouseCode) === norm(warehouseCode))
      if (byPair) { usedLn.add(byPair.lineNum); return byPair.lineNum }
      const byCode = slLines.find((l) => !usedLn.has(l.lineNum) && l.itemCode === itemCode)
      if (byCode) { usedLn.add(byCode.lineNum); return byCode.lineNum }
      if (fallbackIdx !== undefined && fallbackIdx < slLines.length && !usedLn.has(slLines[fallbackIdx].lineNum)) {
        usedLn.add(slLines[fallbackIdx].lineNum)
        return slLines[fallbackIdx].lineNum
      }
      return null
    }
    const res = await patchOrderToSap(s, {
      docEntry,
      cardCode,
      docDate,
      docDueDate,
      comments: remarks ?? null,
      headerDiscPct: headerPct,
      lines: calcLines.map((l, idx) => {
        const sub = l as { sapLineNum?: number }
        return {
          lineNum: resolveLn(l.itemCode, l.warehouseCode, sub.sapLineNum, idx),
          itemCode: l.itemCode,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discPct: l.discPct,
          taxCode: l.taxCode,
          warehouseCode: l.warehouseCode,
        }
      }),
    })
    if (res.status !== 'synced') {
      return NextResponse.json(
        { error: `Service Layer từ chối cập nhật chứng từ — ${res.error ?? 'lỗi không rõ'}. Chứng từ chưa được thay đổi.` },
        { status: 502 },
      )
    }
    // Đọc lại chứng từ sau PATCH để trả DocNum/tổng mới nhất cho UI
    const after = await fetchSapOrderDetail(s, docEntry)
    return NextResponse.json({
      ok: true,
      order: {
        id,
        docNum: after.order?.docNum ?? cur.order.docNum,
        sapSyncStatus: 'synced',
        sapDocEntry: docEntry,
        sapDocNum: after.order?.sapDocNum ?? cur.order.sapDocNum,
        sapSyncError: null,
      },
      sap: { status: 'synced' },
    })
  }

  const order = await prisma.salesOrder.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  if (user.databaseId && (order as { sapDatabaseId?: string }).sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  if (order.status !== 'Open') {
    return NextResponse.json({ error: 'Chỉ có thể sửa đơn hàng đang ở trạng thái Open' }, { status: 400 })
  }

  // ---------- 1) Đơn đã synced → PATCH lên Service Layer trước ----------
  let patchedInSap = false
  if (order.sapSyncStatus === 'synced' && order.sapDocEntry != null) {
    const s = await loadSapSettings(order.sapDatabaseId ?? user.databaseId)
    if (isSapConfigured(s)) {
      // LineNum của dòng hiện có: ưu tiên sapLineNum đã lưu khi đẩy đơn;
      // thiếu (đơn đẩy trước khi có cột này) → lấy từ chi tiết SL khớp theo vị trí dòng
      const dbLines = order.lines
      let slLineNums: number[] = []
      if (dbLines.some((l) => l.sapLineNum == null)) {
        const det = await fetchSapOrderDetail(s, order.sapDocEntry)
        if (det.ok && det.order) slLineNums = [...det.order.lines].sort((a, b) => a.lineNum - b.lineNum).map((l) => l.lineNum)
      }
      const resolveLineNum = (sub: { dbId?: string; sapLineNum?: number }): number | null => {
        if (typeof sub.sapLineNum === 'number') return sub.sapLineNum
        if (!sub.dbId) return null
        const idx = dbLines.findIndex((l) => l.id === sub.dbId)
        if (idx < 0) return null
        if (dbLines[idx].sapLineNum != null) return dbLines[idx].sapLineNum
        return slLineNums[idx] ?? null
      }
      const res = await patchOrderToSap(s, {
        docEntry: order.sapDocEntry,
        cardCode,
        docDate,
        docDueDate,
        comments: remarks ?? null,
        headerDiscPct: headerPct,
        lines: calcLines.map((l) => ({
          lineNum: resolveLineNum(l as { dbId?: string; sapLineNum?: number }),
          itemCode: l.itemCode,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discPct: l.discPct,
          taxCode: l.taxCode,
          warehouseCode: l.warehouseCode,
        })),
      })
      if (res.status !== 'synced') {
        return NextResponse.json(
          { error: `Service Layer từ chối cập nhật chứng từ — ${res.error ?? 'lỗi không rõ'}. Đơn hàng chưa được thay đổi.` },
          { status: 502 },
        )
      }
      patchedInSap = true
    }
  }

  // ---------- 2) Cập nhật local (sau khi PATCH SAP thành công, hoặc đơn local-only) ----------
  const lineNumOf = new Map<string, number | null>()
  if (patchedInSap) {
    const dbLines = order.lines
    for (const l of calcLines) {
      const sub = l as { dbId?: string; sapLineNum?: number }
      if (sub.dbId) {
        const idx = dbLines.findIndex((d) => d.id === sub.dbId)
        lineNumOf.set(
          sub.dbId,
          typeof sub.sapLineNum === 'number' ? sub.sapLineNum : idx >= 0 ? dbLines[idx].sapLineNum : null,
        )
      }
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.salesOrderLine.deleteMany({ where: { orderId: order.id } })
    return tx.salesOrder.update({
      where: { id: order.id },
      data: {
        cardCode,
        cardName,
        docDate: new Date(docDate),
        docDueDate: new Date(docDueDate),
        remarks: remarks?.trim() || null,
        warehouseCode: warehouseCode?.trim() || null,
        totalBeforeDisc,
        discountAmt,
        headerDiscPct: headerPct,
        headerDiscAmt,
        vatAmt,
        grandTotal,
        ...(patchedInSap ? { sapSyncedAt: new Date(), sapSyncError: null } : {}),
        lines: {
          create: calcLines.map((l, i) => ({
            lineNum: i + 1,
            itemCode: l.itemCode,
            itemName: l.itemName,
            uom: l.uom || 'kg',
            taxCode: l.taxCode?.trim() || null,
            warehouseCode: (l.warehouseCode || warehouseCode || '').trim() || null,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
            discPct: l.discPct,
            discAmt: l.discAmt,
            vatPct: l.vatPct,
            vatAmt: l.vatAmt,
            grandTotal: l.grandTotal,
            sapLineNum: (l as { dbId?: string }).dbId ? lineNumOf.get((l as { dbId?: string }).dbId as string) ?? null : null,
            isBomChild: l.isBomChild ?? false,
            bomGroupKey: (l.bomGroupKey as string | null | undefined) ?? null,
            bomEditable: l.bomEditable ?? true,
              bomQtyPerParent: l.bomQtyPerParent ?? null,
          })),
        },
      },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
  })

  clearSapOrdersCache() // đơn đã sửa (local + có thể đã PATCH lên SAP) → danh sách phải tải lại
  return NextResponse.json({ ok: true, order: updated, sap: { status: patchedInSap ? 'synced' : order.sapSyncStatus } })
}

// ---------- PATCH : đóng/mở đơn ----------
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền sửa đơn hàng' }, { status: 403 })
  }

  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const status = (body as { status?: string }).status
  if (status !== 'Open' && status !== 'Closed') {
    return NextResponse.json({ error: 'Trạng thái không hợp lệ' }, { status: 400 })
  }

  const order = await prisma.salesOrder.findUnique({ where: { id } })
  if (!order) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  if (user.databaseId && order.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  const updated = await prisma.salesOrder.update({ where: { id }, data: { status } })
  clearSapOrdersCache() // trạng thái đơn đổi → danh sách phải tải lại
  return NextResponse.json({ ok: true, order: updated })
}

// ---------- DELETE ----------
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.delete) {
    return NextResponse.json({ error: 'Bạn không có quyền xóa đơn hàng' }, { status: 403 })
  }

  const { id } = await ctx.params
  try {
    const existing = await prisma.salesOrder.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Không tìm thấy đơn hàng cần xóa' }, { status: 404 })
    }
    if (user.databaseId && existing.sapDatabaseId !== user.databaseId) {
      return NextResponse.json({ error: 'Không tìm thấy đơn hàng cần xóa' }, { status: 404 })
    }
    // Không xóa đơn đã đẩy/đang đẩy sang SAP hoặc đã đóng — tránh lệch dữ liệu
    // giữa 2 hệ thống và mất đường retry khi push timeout.
    if (existing.sapSyncStatus === 'synced' || existing.sapSyncStatus === 'pending') {
      return NextResponse.json(
        { error: 'Không thể xóa đơn đã/đang đồng bộ SAP B1. Hãy xử lý chứng từ trên SAP trước.' },
        { status: 400 },
      )
    }
    if (existing.status === 'Closed') {
      return NextResponse.json(
        { error: 'Không thể xóa đơn đã đóng (Closed). Hãy mở lại đơn trước khi xóa.' },
        { status: 400 },
      )
    }
    await prisma.salesOrder.delete({ where: { id } })
    clearSapOrdersCache() // đơn đã xóa → danh sách phải tải lại
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng cần xóa' }, { status: 404 })
  }
}
