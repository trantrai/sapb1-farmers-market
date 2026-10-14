import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { dedupeRequest, acquireOrderLock, releaseOrderLock } from '@/lib/idempotency'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapOrderDetail, type SapOrderLineRow } from '@/lib/sap-orders'

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

  let body: {
    orderId?: string
    // (mở rộng) danh sách dòng chỉ định: [{ sourceOrderLineId, quantity }]
    // — nếu không gửi, giữ hành vi cũ: copy toàn bộ OpenQty
    lines?: Array<{ sourceOrderLineId?: string; quantity?: number }>
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
  }
  const orderId = String(body.orderId ?? '').trim()
  if (!orderId) return NextResponse.json({ error: 'Thiếu orderId' }, { status: 400 })

  // Giới hạn 200 dòng / phiếu (chế độ chỉ định)
  if (Array.isArray(body.lines) && body.lines.length > 200) {
    return NextResponse.json({ error: 'Phiếu giao hàng tối đa 200 dòng' }, { status: 400 })
  }

  // So sánh số lượng dùng epsilon + round 3 decimals (tránh lỗi float
  // khi user nhập đúng OpenQty vẫn bị báo vượt)
  const round3 = (n: number) => Math.round(n * 1000) / 1000
  const gtEps = (a: number, b: number) => round3(a) - round3(b) > 1e-9

  // Chống bấm đúp "Copy sang Delivery": 2 request giống nhau trong 30s
  // chỉ tạo 1 delivery — lượt trùng nhận lại kết quả của lượt đầu
  // (kể cả khi lượt đầu chưa xong: đợi chung promise, không tạo trùng).
  const fpLines = Array.isArray(body.lines)
    ? body.lines
        .map((l) => `${String(l.sourceOrderLineId ?? '').trim()}:${Number(l.quantity)}`)
        .sort()
        .join(',')
    : 'auto'
  const dedupeKey = `delivery:from-order:${user.id}:${orderId}:${fpLines}`

  // ================= ĐƠN SAP B1 TRỰC TIẾP (id 'sap-<DocEntry>') =================
  // Lấy header + lines từ Service Layer, tạo delivery local (không có bản ghi
  // SalesOrder local). OpenQty từng dòng = SL còn mở theo SAP trừ SL đã giao
  // qua các delivery local trước đó (nhận diện bằng sapSourceDocEntry).
  if (orderId.startsWith('sap-')) {
    const docEntry = Number(orderId.slice(4))
    if (!Number.isInteger(docEntry) || docEntry <= 0) {
      return NextResponse.json({ error: 'DocEntry đơn SAP không hợp lệ' }, { status: 400 })
    }
    const s = await loadSapSettings(user.databaseId)
    if (!isSapConfigured(s)) {
      return NextResponse.json({ error: 'Chưa cấu hình SAP B1 Service Layer' }, { status: 400 })
    }
    const cur = await fetchSapOrderDetail(s, docEntry)
    if (!cur.ok || !cur.order) {
      return NextResponse.json(
        { error: `Không đọc được đơn hàng từ SAP B1 — ${cur.error ?? 'lỗi không rõ'}` },
        { status: 502 },
      )
    }
    const sapOrder = cur.order
    if (sapOrder.status === 'Closed') {
      return NextResponse.json({ error: 'Đơn SAP đã đóng (Closed) — không thể tạo phiếu giao hàng' }, { status: 400 })
    }
    if (sapOrder.status === 'Cancelled') {
      return NextResponse.json({ error: 'Không thể tạo phiếu giao hàng từ đơn đã hủy' }, { status: 400 })
    }

    const runSap = async (): Promise<{ body: unknown; status: number }> => {
      // SL đã giao qua các delivery local trước (trừ phiếu đã hủy)
      const existingDeliveries = await prisma.delivery.findMany({
        where: { sapSourceDocEntry: docEntry, status: { not: 'Cancelled' } },
        include: { lines: { select: { sourceOrderLineId: true, quantity: true } } },
      })
      const deliveredByLine = new Map<string, number>()
      for (const d of existingDeliveries) {
        for (const dl of d.lines) {
          if (!dl.sourceOrderLineId) continue
          deliveredByLine.set(dl.sourceOrderLineId, (deliveredByLine.get(dl.sourceOrderLineId) ?? 0) + dl.quantity)
        }
      }
      const openQtyOf = (line: SapOrderLineRow) => {
        const sapOpen = line.sapOpenQty ?? line.quantity
        const delivered = deliveredByLine.get(line.id) ?? 0
        return round3(sapOpen - delivered)
      }

      let picked: Array<{ line: SapOrderLineRow; qty: number }>
      if (Array.isArray(body.lines)) {
        const byId = new Map(sapOrder.lines.map((l) => [l.id, l]))
        picked = []
        for (const reqLine of body.lines) {
          if (!reqLine || typeof reqLine !== 'object') continue
          const lineId = String(reqLine.sourceOrderLineId ?? '').trim()
          const qty = Number(reqLine.quantity)
          if (!lineId || !Number.isFinite(qty) || qty <= 0) continue
          const line = byId.get(lineId)
          if (!line) {
            return { body: { error: `Dòng đơn hàng không hợp lệ: ${lineId}` }, status: 400 }
          }
          const openQty = openQtyOf(line)
          if (gtEps(qty, openQty)) {
            return {
              body: { error: `SL giao (${qty}) vượt quá SL còn mở (${openQty}) của mặt hàng ${line.itemCode}` },
              status: 400,
            }
          }
          picked.push({ line, qty })
        }
        if (picked.length === 0) {
          return { body: { error: 'Chưa chọn dòng nào để giao (SL giao phải > 0)' }, status: 400 }
        }
      } else {
        picked = sapOrder.lines
          .map((l) => ({ line: l, qty: openQtyOf(l) }))
          .filter((x) => x.qty > 0)
        if (picked.length === 0) {
          return { body: { error: 'Đơn SAP không còn dòng nào mở (OpenQty = 0) để giao' }, status: 400 }
        }
      }

      const lineTotals = picked.map((x) => Math.round(x.line.unitPrice * x.qty))
      const grandTotal = lineTotals.reduce((sum, t) => sum + t, 0)

      let delivery: Awaited<ReturnType<typeof prisma.delivery.create>> | null = null
      for (let attempt = 0; attempt < 5 && !delivery; attempt++) {
        try {
          const last = await prisma.delivery.findFirst({ orderBy: { docNum: 'desc' } })
          const docNum = (last?.docNum ?? 0) + 1
          delivery = await prisma.delivery.create({
            data: {
              docNum,
              cardCode: sapOrder.cardCode,
              cardName: sapOrder.cardName,
              remarks: `Copy từ Sale Order SAP #${sapOrder.docNum}`,
              sourceOrderId: null,
              sapSourceDocEntry: docEntry,
              sapDatabaseId: user.databaseId ?? null,
              grandTotal,
              createdBy: user.id,
              lines: {
                create: picked.map((x, i) => ({
                  lineNum: i + 1,
                  itemCode: x.line.itemCode,
                  itemName: x.line.itemName,
                  quantity: x.qty,
                  uom: x.line.uom || '',
                  unitPrice: x.line.unitPrice,
                  lineTotal: lineTotals[i],
                  sourceOrderLineId: x.line.id,
                })),
              },
            },
            include: { lines: true },
          })
        } catch (e) {
          if ((e as { code?: string })?.code !== 'P2002') throw e
          console.warn(`[deliveries/from-order] docNum conflict (SAP), retry ${attempt + 1}/5`)
        }
      }
      if (!delivery) return { body: { error: 'Không thể cấp số phiếu' }, status: 500 }
      return { body: { ok: true, delivery }, status: 201 }
    }

    // Lock per-order (dùng orderId 'sap-<DocEntry>' làm khóa)
    if (!acquireOrderLock(orderId)) {
      return NextResponse.json({ error: 'Đơn này đang được tạo phiếu giao hàng ở một phiên khác — vui lòng đợi' }, { status: 409 })
    }
    try {
      const { result, replayed } = await dedupeRequest(dedupeKey, runSap)
      return NextResponse.json(result.body, { status: replayed ? 200 : result.status })
    } finally {
      releaseOrderLock(orderId)
    }
  }

  // ================= ĐƠN LOCAL =================
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!order) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  // B1: cách ly DB
  if (user.databaseId && order.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  }
  if (order.status === 'Cancelled') {
    return NextResponse.json({ error: 'Không thể tạo phiếu giao hàng từ đơn đã hủy' }, { status: 400 })
  }

  const run = async (): Promise<{ body: unknown; status: number }> => {
    // Tính OpenQty từng dòng SAU khi đã giữ order lock — không tính trước
    // lock, để 2 tab fingerprint khác nhau không cộng dồn vượt OpenQty.
    // SL đặt - SL đã giao qua các delivery trước (chỉ copy dòng còn
    // OpenQty > 0, tương ứng LineStatus = Open trên SAP)
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

    const openQtyOf = (line: { id: string; quantity: number }) => {
      const delivered = deliveredByLine.get(line.id) ?? 0
      return round3(line.quantity - delivered)
    }

    // Copy dòng (bỏ dòng con BOM — delivery chỉ giao mặt hàng cha/hàng thường)
    type OrderLineRow = (typeof order.lines)[number]
    let picked: Array<{ line: OrderLineRow; qty: number }>
    if (Array.isArray(body.lines)) {
      // Chế độ chỉ định: chỉ lấy các dòng được gửi lên, SL giao phải ≤ OpenQty
      const byId = new Map(order.lines.map((l) => [l.id, l]))
      picked = []
      for (const reqLine of body.lines) {
        if (!reqLine || typeof reqLine !== 'object') continue
        const lineId = String(reqLine.sourceOrderLineId ?? '').trim()
        const qty = Number(reqLine.quantity)
        if (!lineId || !Number.isFinite(qty) || qty <= 0) continue
        const line = byId.get(lineId)
        if (!line || line.isBomChild) {
          return { body: { error: `Dòng đơn hàng không hợp lệ: ${lineId}` }, status: 400 }
        }
        const openQty = openQtyOf(line)
        if (gtEps(qty, openQty)) {
          return {
            body: { error: `SL giao (${qty}) vượt quá SL còn mở (${openQty}) của mặt hàng ${line.itemCode}` },
            status: 400,
          }
        }
        picked.push({ line, qty })
      }
      if (picked.length === 0) {
        return { body: { error: 'Chưa chọn dòng nào để giao (SL giao phải > 0)' }, status: 400 }
      }
    } else {
      // Hành vi cũ: copy toàn bộ OpenQty
      picked = order.lines
        .filter((l) => !l.isBomChild)
        .map((l) => ({ line: l, qty: openQtyOf(l) }))
        .filter((x) => x.qty > 0)
      if (picked.length === 0) {
        return { body: { error: 'Đơn hàng không còn dòng nào mở (OpenQty = 0) để giao' }, status: 400 }
      }
    }

    // grandTotal = tổng các lineTotal đã round (không tính lại từ unitPrice*qty)
    const lineTotals = picked.map((x) => Math.round(x.line.unitPrice * x.qty))
    const grandTotal = lineTotals.reduce((s, t) => s + t, 0)

    // Cấp docNum: max+1 (retry khi trùng)
    let delivery: Awaited<ReturnType<typeof prisma.delivery.create>> | null = null
    for (let attempt = 0; attempt < 5 && !delivery; attempt++) {
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
        grandTotal,
        createdBy: user.id,
        lines: {
          create: picked.map((x, i) => ({
            lineNum: i + 1,
            itemCode: x.line.itemCode,
            itemName: x.line.itemName,
            quantity: x.qty,
            uom: x.line.uom || '',
            unitPrice: x.line.unitPrice,
            lineTotal: lineTotals[i],
            sourceOrderLineId: x.line.id,
          })),
        },
        },
        include: { lines: true },
        })
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e
        console.warn(`[deliveries/from-order] docNum conflict, retry ${attempt + 1}/5`)
      }
    }
    if (!delivery) return { body: { error: 'Không thể cấp số phiếu' }, status: 500 }
    return { body: { ok: true, delivery }, status: 201 }
  }

  // Lock per-order: 2 tab/2 request khác fingerprint không chạy song song
  // (tránh cộng dồn vượt OpenQty). Lượt thứ 2 nhận 409.
  if (!acquireOrderLock(orderId)) {
    return NextResponse.json({ error: 'Đơn này đang được tạo phiếu giao hàng ở một phiên khác — vui lòng đợi' }, { status: 409 })
  }
  try {
    const { result, replayed } = await dedupeRequest(dedupeKey, run)
    return NextResponse.json(result.body, { status: replayed ? 200 : result.status })
  } finally {
    releaseOrderLock(orderId)
  }
}
