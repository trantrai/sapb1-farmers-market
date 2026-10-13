import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'

// POST /api/deliveries/from-order — tạo Delivery từ Sale Order
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo phiếu giao hàng' }, { status: 403 })
  }
  const rl = rateLimit(`delivery:from-order:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  let body: { orderId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
  }
  const orderId = String(body.orderId ?? '').trim()
  if (!orderId) return NextResponse.json({ error: 'Thiếu orderId' }, { status: 400 })

  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && order.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }

  // Tính OpenQty từng dòng: SL đặt - SL đã giao qua các delivery trước
  // (chỉ copy dòng còn OpenQty > 0, tương ứng LineStatus = Open trên SAP)
  const existingDeliveries = await prisma.delivery.findMany({
    where: { sourceOrderId: order.id, status: { not: 'Cancelled' } },
    include: { lines: { select: { sourceOrderLineId: true, quantity: true } } },
  })
  const deliveredByLine = new Map<string, number>()
  for (const d of existingDeliveries) {
    for (const dl of d.lines) {
      if (!dl.sourceOrderLineId) continue
      deliveredByLine.set(dl.sourceOrderLineId, (deliveredByLine.get(dl.sourceOrderLineId) ?? 0) + dl.quantity)
    }
  }

  // Copy dòng (bỏ dòng con BOM — delivery chỉ giao mặt hàng cha/hàng thường)
  // Chỉ lấy dòng có OpenQty > 0
  const srcLines = order.lines
    .filter((l) => !l.isBomChild)
    .map((l) => {
      const delivered = deliveredByLine.get(l.id) ?? 0
      const openQty = Math.round((l.quantity - delivered) * 1000) / 1000
      return { line: l, openQty }
    })
    .filter((x) => x.openQty > 0)

  if (srcLines.length === 0) {
    return NextResponse.json({ error: 'Đơn hàng không còn dòng nào mở (OpenQty = 0) để giao' }, { status: 400 })
  }

  const grandTotal = srcLines.reduce((s, x) => s + (x.line.unitPrice * x.openQty), 0)
  // Cấp docNum: max+1 (retry khi trùng)
  let delivery: Awaited<ReturnType<typeof prisma.delivery.create>> | null = null
  for (let attempt = 0; attempt < 3 && !delivery; attempt++) {
    try {
      const last = await prisma.delivery.findFirst({ orderBy: { docNum: 'desc' } })
      const docNum = (last?.docNum ?? 0) + 1
      delivery = await prisma.delivery.create({
        data: {
          docNum,
          cardCode: order.cardCode,
      cardName: order.cardName,
      remarks: `Copy từ Sale Order #${order.docNum}`,
      sourceOrderId: order.id,
      sapDatabaseId: order.sapDatabaseId,
      grandTotal: Math.round(grandTotal),
      createdBy: user.id,
      lines: {
        create: srcLines.map((x, i) => ({
          lineNum: i + 1,
          itemCode: x.line.itemCode,
          itemName: x.line.itemName,
          quantity: x.openQty,
          uom: x.line.uom || '',
          unitPrice: x.line.unitPrice,
          lineTotal: Math.round(x.line.unitPrice * x.openQty),
          sourceOrderLineId: x.line.id,
        })),
      },
      },
      include: { lines: true },
      })
    } catch (e) {
      if ((e as { code?: string })?.code !== 'P2002') throw e
    }
  }
  if (!delivery) return NextResponse.json({ error: 'Không thể cấp số phiếu' }, { status: 500 })

  return NextResponse.json({ ok: true, delivery }, { status: 201 })
}
