import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { acquireOrderLock, releaseOrderLock } from '@/lib/idempotency'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapDeliveryDetail } from '@/lib/sap-deliveries'
import { parseB2BHeader } from '../route'

interface Ctx {
  params: Promise<{ id: string }>
}

// GET /api/deliveries/[id] — chi tiết
export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem giao hàng' }, { status: 403 })
  }
  const { id } = await ctx.params
  // Phiếu SAP trực tiếp (id = sap-{DocEntry}): lấy thẳng từ Service Layer
  if (id.startsWith('sap-')) {
    const docEntry = Number(id.slice(4))
    if (!Number.isInteger(docEntry) || docEntry <= 0) {
      return NextResponse.json({ error: 'ID phiếu SAP không hợp lệ' }, { status: 400 })
    }
    const s = await loadSapSettings(user.databaseId)
    if (!isSapConfigured(s)) {
      return NextResponse.json({ error: 'Chưa cấu hình SAP B1 Service Layer' }, { status: 400 })
    }
    const det = await fetchSapDeliveryDetail(s, docEntry)
    if (!det.ok || !det.delivery) {
      return NextResponse.json({ error: det.error ?? 'Không lấy được chi tiết phiếu từ SAP B1' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, delivery: det.delivery })
  }
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNum: 'asc' } },
      sourceOrder: { select: { id: true, docNum: true, docDate: true, cardCode: true, cardName: true, status: true } },
    },
  })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && delivery.sapDatabaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, delivery })
}

// DELETE /api/deliveries/[id] — xóa (chỉ khi chưa đẩy SAP)
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.delete) {
    return NextResponse.json({ error: 'Bạn không có quyền xóa phiếu giao hàng' }, { status: 403 })
  }
  const rl = rateLimit(`delivery:delete:${user.id}`, 30, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }
  const { id } = await ctx.params
  const delivery = await prisma.delivery.findUnique({ where: { id } })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  if (user.databaseId && delivery.sapDatabaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  if (delivery.sapSyncStatus === 'synced') {
    return NextResponse.json({ error: 'Phiếu đã đẩy sang SAP — không thể xóa' }, { status: 400 })
  }
  // Optimistic locking bắt buộc: version qua query (?version=) hoặc body
  let delVersion: number | undefined
  const qv = req.nextUrl.searchParams.get('version')
  if (qv !== null && qv.trim() !== '') {
    delVersion = Number(qv)
  } else {
    try {
      const delBody = await req.json()
      if (delBody && typeof delBody.version === 'number') delVersion = delBody.version
    } catch {
      // body trống — bỏ qua
    }
  }
  if (typeof delVersion !== 'number' || !Number.isFinite(delVersion)) {
    return NextResponse.json({ error: 'Thiếu version — vui lòng tải lại phiếu giao hàng' }, { status: 400 })
  }
  if (delVersion !== delivery.version) {
    return NextResponse.json(
      { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại phiếu giao hàng', code: 'VERSION_CONFLICT' },
      { status: 409 },
    )
  }
  await prisma.delivery.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}

// PUT /api/deliveries/[id] — sửa SL dòng / hủy phiếu (chỉ khi chưa đẩy SAP)
export async function PUT(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền sửa phiếu giao hàng' }, { status: 403 })
  }
  const rl = rateLimit(`delivery:edit:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  const { id } = await ctx.params
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNum: 'asc' } },
      sourceOrder: { select: { id: true, status: true } },
    },
  })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && delivery.sapDatabaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  if (delivery.sapSyncStatus === 'synced') {
    return NextResponse.json({ error: 'Phiếu đã đẩy sang SAP — không thể sửa' }, { status: 400 })
  }
  // Chặn khi đơn nguồn đã hủy
  if (delivery.sourceOrder?.status === 'Cancelled') {
    return NextResponse.json(
      { error: 'Đơn nguồn đã bị hủy — không thể sửa/đẩy phiếu giao hàng' },
      { status: 400 },
    )
  }

  let body: {
    lines?: Array<{ id?: string; quantity?: number; taxCode?: string | null; discPct?: number; warehouseCode?: string | null; uom?: string | null; batchNumber?: string | null }>
    status?: string
    version?: number
    docDate?: string
    remarks?: string | null
    warehouseCode?: string | null
    /** B2B / SAP B1 (Đợt 2+3) — parse chi tiết bằng parseB2BHeader (whitelist) */
    salesPersonCode?: unknown; paymentGroupCode?: unknown; shipToCode?: unknown; billToCode?: unknown; contactPersonCode?: unknown
    numAtCard?: unknown; taxDate?: unknown; docCurrency?: unknown; docRate?: unknown
    projectCode?: unknown; attachmentsJson?: unknown; reqDate?: unknown
    /** Ghi chú soạn/đóng gói (SAP PickAndPackNotes) */
    pickAndPackNotes?: string | null
    /** CK đầu chứng từ % (SAP DiscountPercent) */
    headerDiscPct?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
  }

  // Whitelist status: chỉ chấp nhận 'Cancelled'
  if (body.status !== undefined && body.status !== 'Cancelled') {
    return NextResponse.json({ error: 'Trạng thái không hợp lệ' }, { status: 400 })
  }

  // B2B / SAP B1 (Đợt 2+3): whitelist + validate các trường header mới
  const { data: b2b, error: b2bError } = parseB2BHeader(body as unknown as Record<string, unknown>)
  if (b2bError) {
    return NextResponse.json({ error: b2bError }, { status: 400 })
  }
  // CK đầu chứng từ % (SAP DiscountPercent) — 0–100
  let headerDiscPct: number | undefined
  if (body.headerDiscPct !== undefined) {
    const v = body.headerDiscPct
    if (v === null) {
      headerDiscPct = 0
    } else {
      const hp = Number(v)
      if (!Number.isFinite(hp) || hp < 0 || hp > 100) {
        return NextResponse.json({ error: 'Chiết khấu đầu chứng từ phải từ 0 đến 100%' }, { status: 400 })
      }
      headerDiscPct = hp
    }
  }

  // Header fields cho form sửa đầy đủ (delivery-form-view): ngày chứng từ + ghi chú + kho xuất
  // + các trường B2B/SAP B1 mới (Đợt 2+3).
  // Chỉ cho phép khi phiếu chưa đẩy SAP và chưa hủy (đã kiểm tra ở trên)
  const headerPatch: {
    docDate?: Date; remarks?: string | null; warehouseCode?: string | null
    salesPersonCode?: number | null; paymentGroupCode?: number | null
    shipToCode?: string | null; billToCode?: string | null; contactPersonCode?: number | null; numAtCard?: string | null
    taxDate?: Date | null; docCurrency?: string; docRate?: number | null
    projectCode?: string | null; attachmentsJson?: string | null; reqDate?: Date | null
    pickAndPackNotes?: string | null; headerDiscPct?: number
  } = { ...b2b }
  if (body.docDate !== undefined) {
    const d = new Date(String(body.docDate))
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: 'Ngày chứng từ không hợp lệ' }, { status: 400 })
    }
    headerPatch.docDate = d
  }
  if (body.remarks !== undefined) {
    const r = body.remarks == null ? null : String(body.remarks).trim()
    headerPatch.remarks = r || null
  }
  if (body.warehouseCode !== undefined) {
    headerPatch.warehouseCode = body.warehouseCode == null ? null : (String(body.warehouseCode).trim() || null)
  }
  if (body.pickAndPackNotes !== undefined) {
    headerPatch.pickAndPackNotes = body.pickAndPackNotes == null ? null : (String(body.pickAndPackNotes).trim() || null)
  }
  if (headerDiscPct !== undefined) {
    headerPatch.headerDiscPct = headerDiscPct
  }

  // Optimistic locking bắt buộc: client phải gửi đúng version đã đọc
  if (typeof body.version !== 'number' || !Number.isFinite(body.version)) {
    return NextResponse.json({ error: 'Thiếu version — vui lòng tải lại phiếu giao hàng' }, { status: 400 })
  }
  if (body.version !== delivery.version) {
    return NextResponse.json(
      { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại phiếu giao hàng', code: 'VERSION_CONFLICT' },
      { status: 409 },
    )
  }

  // Lock per-order: 2 phiếu cùng đơn không sửa song song vượt OpenQty.
  // Lượt thứ 2 nhận 409. (Delivery không có đơn nguồn thì bỏ qua lock.)
  const lockOrderId = delivery.sourceOrderId
  const del = delivery // đã qua null-check ở trên; giữ narrowing cho closure
  if (lockOrderId && !acquireOrderLock(lockOrderId)) {
    return NextResponse.json(
      { error: 'Đơn nguồn đang được xử lý ở một phiên khác — vui lòng thử lại' },
      { status: 409 },
    )
  }
  try {
    return await runEdit()
  } finally {
    if (lockOrderId) releaseOrderLock(lockOrderId)
  }

  async function runEdit(): Promise<NextResponse> {
  // Hủy phiếu
  if (body.status === 'Cancelled') {
    if (del.status === 'Cancelled') {
      return NextResponse.json({ error: 'Phiếu đã được hủy trước đó' }, { status: 400 })
    }
    const updated = await prisma.delivery.update({
      where: { id },
      data: { status: 'Cancelled', version: { increment: 1 } },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    return NextResponse.json({ ok: true, delivery: updated })
  }

  if (del.status === 'Cancelled') {
    return NextResponse.json({ error: 'Phiếu đã hủy — không thể sửa' }, { status: 400 })
  }

  const reqLines = Array.isArray(body.lines) ? body.lines : []
  if (reqLines.length === 0) {
    return NextResponse.json({ error: 'Chưa có dòng nào để sửa' }, { status: 400 })
  }

  // So sánh số lượng dùng epsilon + round 3 decimals (tránh lỗi float
  // khi user nhập đúng OpenQty vẫn bị báo vượt)
  const round3 = (n: number) => Math.round(n * 1000) / 1000
  const gtEps = (a: number, b: number) => round3(a) - round3(b) > 1e-9

  // Tính maxQty cho dòng có liên kết đơn nguồn:
  // maxQty = SL đặt của đơn nguồn - SL đã giao ở các phiếu khác (không tính phiếu này)
  const deliveredOthers = new Map<string, number>()
  let orderLineQty = new Map<string, number>()
  if (del.sourceOrderId) {
    const others = await prisma.delivery.findMany({
      where: {
        sourceOrderId: del.sourceOrderId,
        status: { not: 'Cancelled' },
        id: { not: del.id },
      },
      include: { lines: { select: { sourceOrderLineId: true, quantity: true } } },
    })
    for (const d of others) {
      for (const dl of d.lines) {
        if (!dl.sourceOrderLineId) continue
        deliveredOthers.set(dl.sourceOrderLineId, (deliveredOthers.get(dl.sourceOrderLineId) ?? 0) + dl.quantity)
      }
    }
    const order = await prisma.salesOrder.findUnique({
      where: { id: del.sourceOrderId },
      include: { lines: { select: { id: true, quantity: true } } },
    })
    if (order) orderLineQty = new Map(order.lines.map((l) => [l.id, l.quantity]))
  }

  const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0)
  const byId = new Map(del.lines.map((l) => [l.id, l]))
  const updates: Array<{ id: string; quantity: number; lineTotal: number; taxCode?: string | null; discPct?: number; warehouseCode?: string | null; uom?: string; batchNumber?: string | null }> = []
  for (const rl2 of reqLines) {
    if (!rl2 || typeof rl2 !== 'object') {
      return NextResponse.json({ error: 'Dòng phiếu không hợp lệ' }, { status: 400 })
    }
    const lineId = String(rl2.id ?? '').trim()
    const qty = Number(rl2.quantity)
    const line = byId.get(lineId)
    if (!line) {
      return NextResponse.json({ error: `Dòng phiếu không hợp lệ: ${lineId}` }, { status: 400 })
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: `SL dòng ${line.itemCode} phải > 0` }, { status: 400 })
    }
    if (line.sourceOrderLineId) {
      const orderQty = orderLineQty.get(line.sourceOrderLineId)
      if (orderQty !== undefined) {
        const maxQty = Math.max(0, round3(orderQty - (deliveredOthers.get(line.sourceOrderLineId) ?? 0)))
        if (gtEps(qty, maxQty)) {
          return NextResponse.json(
            { error: `SL dòng ${line.itemCode} (${qty}) vượt quá SL còn mở (${maxQty}) của đơn nguồn` },
            { status: 400 },
          )
        }
      }
    }
    // Mã thuế + CK dòng: gửi kèm thì cập nhật (taxCode: null/string rỗng → null),
    // không gửi thì giữ nguyên giá trị cũ. lineTotal = sau CK dòng (làm tròn từng dòng).
    const discPct = rl2.discPct === undefined || rl2.discPct === null
      ? (line.discPct ?? 0)
      : clampPct(Number(rl2.discPct))
    if (rl2.discPct !== undefined && rl2.discPct !== null && !Number.isFinite(Number(rl2.discPct))) {
      return NextResponse.json({ error: `CK dòng ${line.itemCode} không hợp lệ` }, { status: 400 })
    }
    const lt = Math.round(line.unitPrice * qty)
    updates.push({
      id: line.id,
      quantity: qty,
      lineTotal: lt - Math.round((lt * discPct) / 100),
      discPct,
      // Kho dòng: gửi kèm thì cập nhật, không gửi thì giữ nguyên
      ...(rl2.taxCode !== undefined
        ? { taxCode: rl2.taxCode == null ? null : (String(rl2.taxCode).trim() || null) }
        : {}),
      ...(rl2.warehouseCode !== undefined
        ? { warehouseCode: rl2.warehouseCode == null ? null : (String(rl2.warehouseCode).trim() || null) }
        : {}),
      // ĐVT: gửi kèm thì cập nhật (chuỗi rỗng giữ rỗng để SAP dùng mặc định mặt hàng), không gửi thì giữ nguyên
      ...(rl2.uom !== undefined ? { uom: String(rl2.uom ?? '').trim() } : {}),
      // Số lô (SAP BatchNumbers): gửi kèm thì cập nhật, không gửi thì giữ nguyên
      ...(rl2.batchNumber !== undefined
        ? { batchNumber: rl2.batchNumber == null ? null : (String(rl2.batchNumber).trim().slice(0, 50) || null) }
        : {}),
    })
  }

  const totalById = new Map(updates.map((u) => [u.id, u.lineTotal]))
  // grandTotal = tổng các lineTotal đã round TRỪ chiết khấu đầu chứng từ
  // (lấy CK mới gửi kèm, không gửi thì giữ CK đang lưu trên phiếu)
  const effHeaderDiscPct = headerPatch.headerDiscPct ?? del.headerDiscPct ?? 0
  const subTotal = del.lines.reduce((s, l) => s + (totalById.get(l.id) ?? l.lineTotal), 0)
  const grandTotal = subTotal - Math.round((subTotal * effHeaderDiscPct) / 100)

  await prisma.$transaction([
    ...updates.map((u) =>
      prisma.deliveryLine.update({
        where: { id: u.id },
        data: {
          quantity: u.quantity,
          lineTotal: u.lineTotal,
          discPct: u.discPct ?? 0,
          ...(u.taxCode !== undefined ? { taxCode: u.taxCode } : {}),
          ...(u.warehouseCode !== undefined ? { warehouseCode: u.warehouseCode } : {}),
          ...(u.uom !== undefined ? { uom: u.uom } : {}),
          ...(u.batchNumber !== undefined ? { batchNumber: u.batchNumber } : {}),
        },
      }),
    ),
    prisma.delivery.update({ where: { id }, data: { grandTotal, version: { increment: 1 }, ...headerPatch } }),
  ])

  const updated = await prisma.delivery.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  return NextResponse.json({ ok: true, delivery: updated })
  }
}
