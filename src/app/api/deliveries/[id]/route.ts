import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'

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
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNum: 'asc' } },
      sourceOrder: { select: { id: true, docNum: true, docDate: true, cardCode: true, cardName: true, status: true } },
    },
  })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && delivery.sapDatabaseId !== user.databaseId) {
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
  const { id } = await ctx.params
  const delivery = await prisma.delivery.findUnique({ where: { id } })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  if (user.databaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  if (delivery.sapSyncStatus === 'synced') {
    return NextResponse.json({ error: 'Phiếu đã đẩy sang SAP — không thể xóa' }, { status: 400 })
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
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  if (delivery.sapSyncStatus === 'synced') {
    return NextResponse.json({ error: 'Phiếu đã đẩy sang SAP — không thể sửa' }, { status: 400 })
  }

  let body: { lines?: Array<{ id?: string; quantity?: number }>; status?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
  }

  // Hủy phiếu
  if (body.status === 'Cancelled') {
    if (delivery.status === 'Cancelled') {
      return NextResponse.json({ error: 'Phiếu đã được hủy trước đó' }, { status: 400 })
    }
    const updated = await prisma.delivery.update({
      where: { id },
      data: { status: 'Cancelled' },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    return NextResponse.json({ ok: true, delivery: updated })
  }

  if (delivery.status === 'Cancelled') {
    return NextResponse.json({ error: 'Phiếu đã hủy — không thể sửa' }, { status: 400 })
  }

  const reqLines = Array.isArray(body.lines) ? body.lines : []
  if (reqLines.length === 0) {
    return NextResponse.json({ error: 'Chưa có dòng nào để sửa' }, { status: 400 })
  }

  // Tính maxQty cho dòng có liên kết đơn nguồn:
  // maxQty = SL đặt của đơn nguồn - SL đã giao ở các phiếu khác (không tính phiếu này)
  const deliveredOthers = new Map<string, number>()
  let orderLineQty = new Map<string, number>()
  if (delivery.sourceOrderId) {
    const others = await prisma.delivery.findMany({
      where: {
        sourceOrderId: delivery.sourceOrderId,
        status: { not: 'Cancelled' },
        id: { not: delivery.id },
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
      where: { id: delivery.sourceOrderId },
      include: { lines: { select: { id: true, quantity: true } } },
    })
    if (order) orderLineQty = new Map(order.lines.map((l) => [l.id, l.quantity]))
  }

  const byId = new Map(delivery.lines.map((l) => [l.id, l]))
  const updates: Array<{ id: string; quantity: number; lineTotal: number }> = []
  for (const rl2 of reqLines) {
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
        const maxQty = Math.max(0, Math.round((orderQty - (deliveredOthers.get(line.sourceOrderLineId) ?? 0)) * 1000) / 1000)
        if (qty > maxQty) {
          return NextResponse.json(
            { error: `SL dòng ${line.itemCode} (${qty}) vượt quá SL còn mở (${maxQty}) của đơn nguồn` },
            { status: 400 },
          )
        }
      }
    }
    updates.push({ id: line.id, quantity: qty, lineTotal: Math.round(line.unitPrice * qty) })
  }

  const totalById = new Map(updates.map((u) => [u.id, u.lineTotal]))
  const grandTotal = Math.round(
    delivery.lines.reduce((s, l) => s + (totalById.get(l.id) ?? l.lineTotal), 0),
  )

  await prisma.$transaction([
    ...updates.map((u) =>
      prisma.deliveryLine.update({
        where: { id: u.id },
        data: { quantity: u.quantity, lineTotal: u.lineTotal },
      }),
    ),
    prisma.delivery.update({ where: { id }, data: { grandTotal } }),
  ])

  const updated = await prisma.delivery.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  return NextResponse.json({ ok: true, delivery: updated })
}
