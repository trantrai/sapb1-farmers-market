import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { pushOrderToSap } from '@/lib/sap-push-order'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapOrders, fetchSapOrderDetail, clearSapOrdersCache, type SapOrderRow } from '@/lib/sap-orders'
import { calcOrderLines, orderTotals } from '@/lib/order-calc'

// ---------- GET /api/orders : danh sách SO + filter + phân trang ----------
// Khi đã cấu hình SAP B1 → lấy TOÀN BỘ chứng từ TRỰC TIẾP từ Service Layer
// (GET /Orders, tự phân trang) rồi gộp với các đơn local CHƯA đẩy sang SAP
// (pending/none). Đơn local đã synced bị ẩn nếu SAP đã có chứng từ cùng DocEntry.
// ?docEntry=<n> → lấy chi tiết 1 đơn SAP (kèm DocumentLines) cho modal chi tiết.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const sp = req.nextUrl.searchParams

  // ---------- Chi tiết 1 đơn từ SAP B1 (dòng hàng cho modal) ----------
  const docEntryParam = sp.get('docEntry')
  if (docEntryParam) {
    const docEntry = Number(docEntryParam)
    if (!Number.isInteger(docEntry) || docEntry <= 0) {
      return NextResponse.json({ ok: false, error: 'DocEntry không hợp lệ' }, { status: 400 })
    }
    const s = await loadSapSettings()
    if (!isSapConfigured(s)) {
      return NextResponse.json({ ok: false, error: 'Chưa cấu hình SAP B1 Service Layer' }, { status: 400 })
    }
    const det = await fetchSapOrderDetail(s, docEntry)
    if (!det.ok || !det.order) {
      return NextResponse.json({ ok: false, error: det.error ?? 'Không lấy được chi tiết đơn từ SAP B1' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, order: det.order })
  }

  const page = Math.max(1, Number(sp.get('page') ?? 1))
  const pageSize = Math.min(50, Math.max(5, Number(sp.get('pageSize') ?? 8)))
  const q = (sp.get('q') ?? '').trim()
  const status = sp.get('status') ?? ''
  const from = sp.get('from') ?? ''
  const to = sp.get('to') ?? ''

  const where: Record<string, unknown> = {}
  if (q) {
    where.OR = [
      { docNum: isNaN(Number(q)) ? undefined : Number(q) },
      { cardName: { contains: q } },
      { cardCode: { contains: q } },
    ].filter(Boolean)
  }
  if (status === 'Open' || status === 'Closed') where.status = status
  if (from || to) {
    where.docDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
    }
  }

  // ---------- 1) Chứng từ từ SAP B1 (nếu đã cấu hình) ----------
  const s = await loadSapSettings()
  let sapRows: SapOrderRow[] = []
  let warning = ''
  let source: 'sap' | 'local' = 'local'
  if (isSapConfigured(s)) {
    const live = await fetchSapOrders(s, { q, status, from, to })
    if (live.ok && live.data) {
      sapRows = live.data
      source = 'sap'
      if (live.warning) warning = live.warning
    } else {
      // SAP lỗi → vẫn hiển thị đơn local, kèm cảnh báo
      warning = `Không truy vấn được SAP B1 (${live.error ?? 'lỗi không rõ'}) — đang hiển thị đơn local`
    }
  }

  // ---------- 1b) Đơn SAP nào có bản ghi local? (để cho phép SỬA đơn từ danh sách) ----------
  const sapEntries = sapRows.map((r) => r.sapDocEntry).filter((x): x is number => x != null)
  const localByEntry = new Map<number, string>()
  if (sapEntries.length > 0) {
    const syncedLocals = await prisma.salesOrder.findMany({
      where: { sapSyncStatus: 'synced', sapDocEntry: { in: sapEntries } },
      select: { id: true, sapDocEntry: true },
    })
    for (const o of syncedLocals) if (o.sapDocEntry != null) localByEntry.set(o.sapDocEntry, o.id)
  }
  if (sapRows.length > 0) {
    sapRows = sapRows.map((r) => ({ ...r, localId: (r.sapDocEntry != null ? localByEntry.get(r.sapDocEntry) : null) ?? null }))
  }

  // ---------- 2) Đơn local (gộp: các đơn chưa đẩy / SAP không còn) ----------
  const localRows = await prisma.salesOrder.findMany({
    where,
    orderBy: { docNum: 'desc' },
    include: { lines: true },
  })
  const slEntries = new Set(sapRows.map((r) => r.sapDocEntry))
  const localOnly = localRows.filter(
    (o) => !(o.sapSyncStatus === 'synced' && o.sapDocEntry != null && slEntries.has(o.sapDocEntry)),
  )

  // ---------- 3) Gộp + sắp xếp + phân trang trên máy chủ ----------
  let merged = [
    ...sapRows,
    ...localOnly.map((o) => ({ ...o, source: 'local' as const })),
  ].sort((a, b) => b.docNum - a.docNum)

  // Lọc nhanh theo hạn giao: overdue = Open + quá hạn; dueSoon = Open + hạn trong 3 ngày tới
  const due = sp.get('due') ?? ''
  if (due === 'overdue' || due === 'dueSoon') {
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    const soonEnd = new Date(t)
    soonEnd.setDate(soonEnd.getDate() + 3)
    soonEnd.setHours(23, 59, 59, 999)
    merged = merged.filter((r) => {
      if (r.status !== 'Open' || !r.docDueDate) return false
      const d = new Date(r.docDueDate as string)
      return due === 'overdue' ? d < t : d >= t && d <= soonEnd
    })
  }

  const total = merged.length
  const data = merged.slice((page - 1) * pageSize, page * pageSize)

  return NextResponse.json({
    data,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    source,
    ...(warning ? { warning } : {}),
  })
}

// ---------- POST /api/orders : tạo SO mới ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo đơn hàng' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const {
      cardCode, cardName, docDate, docDueDate, remarks, warehouseCode,
      headerDiscPct,
      lines,
    } = body as {
      cardCode: string; cardName: string; docDate: string; docDueDate: string
      remarks?: string
      /** Kho hàng xuất bán mặc định áp dụng cho các dòng hàng */
      warehouseCode?: string
      /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
      headerDiscPct?: number
      lines: Array<{ itemCode: string; itemName: string; uom: string; quantity: number; unitPrice: number; discPct?: number; vatPct?: number; taxCode?: string; warehouseCode?: string }>
    }

    if (!cardCode || !cardName) {
      return NextResponse.json({ error: 'Vui lòng chọn khách hàng (CardCode)' }, { status: 400 })
    }
    if (!docDate || !docDueDate) {
      return NextResponse.json({ error: 'Vui lòng chọn ngày chứng từ và ngày giao hàng' }, { status: 400 })
    }
    const validLines = (lines ?? []).filter((l) => l.itemCode && l.quantity > 0)
    if (validLines.length === 0) {
      return NextResponse.json({ error: 'Đơn hàng cần ít nhất 1 dòng hàng hóa hợp lệ' }, { status: 400 })
    }

    // Tính toán theo từng dòng (SAP B1 RDR1): LineTotal → Discount% dòng
    // → CK ĐẦU CHỨNG TỪ (phân bổ về dòng) → Vat%
    const headerPct = Math.min(100, Math.max(0, Number(headerDiscPct) || 0))
    const calcLines = calcOrderLines(validLines, headerPct)
    const totals = orderTotals(calcLines)
    const { totalBeforeDisc, discountAmt, headerDiscAmt, vatAmt, grandTotal } = totals

    // Cấp docNum + tạo đơn trong 1 transaction: 2 request tạo đơn đồng thời
    // không thể nhận cùng docNum (trước đây findFirst + create rời nhau → trùng số).
    const created = await prisma.$transaction(async (tx) => {
      const last = await tx.salesOrder.findFirst({ orderBy: { docNum: 'desc' } })
      const docNum = (last?.docNum ?? 1000) + 1
      return tx.salesOrder.create({
        data: {
          docNum,
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
          createdBy: user.username,
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
            })),
          },
        },
        include: { lines: true },
      })
    })

    // ---- Đẩy đơn sang SAP B1 (POST /Orders). Luôn lưu local trước, 
    // thất bại thì đánh dấu 'pending' để đẩy lại từ danh sách đơn ----
    const push = await pushOrderToSap({
      cardCode,
      docDate: created.docDate.toISOString(),
      docDueDate: created.docDueDate.toISOString(),
      comments: created.remarks,
      headerDiscPct: headerPct,
      lines: created.lines.map((l) => ({
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
        sapSyncStatus: push.status,
        sapSyncError: push.error ?? null,
        ...(push.status === 'synced'
          ? { sapDocEntry: push.docEntry ?? null, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() }
          : {}),
      },
      include: { lines: true },
    })

    clearSapOrdersCache() // đơn mới (local + có thể đã lên SAP) → danh sách phải tải lại
    return NextResponse.json({ ok: true, order, sap: push }, { status: 201 })
  } catch (e) {
    console.error('POST /api/orders', e)
    return NextResponse.json({ error: 'Không thể tạo đơn hàng' }, { status: 500 })
  }
}
