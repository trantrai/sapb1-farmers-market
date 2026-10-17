import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { dedupeRequest, acquireOrderLock, releaseOrderLock } from '@/lib/idempotency'

// POST /api/deliveries/from-quotation — tạo Delivery từ Báo giá bán hàng
// (theo ma trận copy-from SAP B1: Delivery ← Quotation)
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo phiếu giao hàng' }, { status: 403 })
  }
  const rl = rateLimit(`delivery:from-quotation:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  let body: {
    quotationId?: string
    lines?: Array<{ sourceQuotationLineId?: string; quantity?: number }>
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
  }
  const quotationId = String(body.quotationId ?? '').trim()
  if (!quotationId) return NextResponse.json({ error: 'Thiếu quotationId' }, { status: 400 })

  if (Array.isArray(body.lines) && body.lines.length > 200) {
    return NextResponse.json({ error: 'Phiếu giao hàng tối đa 200 dòng' }, { status: 400 })
  }

  const round3 = (n: number) => Math.round(n * 1000) / 1000
  const gtEps = (a: number, b: number) => round3(a) - round3(b) > 1e-9

  const fpLines = Array.isArray(body.lines)
    ? body.lines
        .map((l) => `${String(l.sourceQuotationLineId ?? '').trim()}:${Number(l.quantity)}`)
        .sort()
        .join(',')
    : 'auto'
  const dedupeKey = `delivery:from-quotation:${user.id}:${quotationId}:${fpLines}`

  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!quotation) {
    return NextResponse.json({ error: 'Không tìm thấy báo giá' }, { status: 404 })
  }
  if (user.databaseId && quotation.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy báo giá' }, { status: 404 })
  }
  if (quotation.status === 'Cancelled') {
    return NextResponse.json({ error: 'Không thể tạo phiếu giao hàng từ báo giá đã hủy' }, { status: 400 })
  }
  if (quotation.isDraft) {
    return NextResponse.json({ error: 'Không thể tạo phiếu giao hàng từ báo giá nháp' }, { status: 400 })
  }

  const run = async (): Promise<{ body: unknown; status: number }> => {
    type QuotationLineRow = (typeof quotation.lines)[number]
    let picked: Array<{ line: QuotationLineRow; qty: number }>
    if (Array.isArray(body.lines)) {
      const byId = new Map(quotation.lines.map((l) => [l.id, l]))
      picked = []
      for (const reqLine of body.lines) {
        if (!reqLine || typeof reqLine !== 'object') continue
        const lineId = String(reqLine.sourceQuotationLineId ?? '').trim()
        const qty = Number(reqLine.quantity)
        if (!lineId || !Number.isFinite(qty) || qty <= 0) continue
        const line = byId.get(lineId)
        if (!line) {
          return { body: { error: `Dòng báo giá không hợp lệ: ${lineId}` }, status: 400 }
        }
        if (gtEps(qty, line.quantity)) {
          return {
            body: { error: `SL giao (${qty}) vượt quá SL báo giá (${line.quantity}) của mặt hàng ${line.itemCode}` },
            status: 400,
          }
        }
        picked.push({ line, qty })
      }
      if (picked.length === 0) {
        return { body: { error: 'Chưa chọn dòng nào để giao (SL giao phải > 0)' }, status: 400 }
      }
    } else {
      picked = quotation.lines.map((l) => ({ line: l, qty: l.quantity })).filter((x) => x.qty > 0)
      if (picked.length === 0) {
        return { body: { error: 'Báo giá không còn dòng nào để giao' }, status: 400 }
      }
    }

    // ---- ?prefill=1: chế độ "Sao chép từ" — KHÔNG tạo phiếu, chỉ trả dữ liệu ----
    if (req.nextUrl.searchParams.get('prefill') === '1') {
      return {
        body: {
          ok: true,
          prefill: {
            cardCode: quotation.cardCode,
            cardName: quotation.cardName,
            docDate: new Date().toISOString(),
            docDueDate: new Date().toISOString(),
            remarks: `Sao chép từ báo giá bán hàng #${quotation.docNum}`,
            headerDiscPct: quotation.headerDiscPct ?? 0,
            warehouseCode: quotation.warehouseCode ?? null,
            lines: picked.map((x) => ({
              itemCode: x.line.itemCode,
              itemName: x.line.itemName,
              uom: x.line.uom || '',
              warehouseCode: x.line.warehouseCode ?? null,
              taxCode: x.line.taxCode ?? null,
              quantity: x.qty,
              unitPrice: x.line.unitPrice,
              discPct: x.line.discPct ?? 0,
              vatPct: x.line.vatPct ?? 0,
              sourceLineId: x.line.id,
            })),
            sourceType: 'quotation',
            sourceId: quotationId,
            sourceDocNum: quotation.docNum ?? null,
            sourceLabel: 'báo giá bán hàng',
          },
        },
        status: 200,
      }
    }

    const lineTotals = picked.map((x) => Math.round(x.line.unitPrice * x.qty))
    const grandTotal = lineTotals.reduce((s, t) => s + t, 0)

    let delivery: Awaited<ReturnType<typeof prisma.delivery.create>> | null = null
    for (let attempt = 0; attempt < 5 && !delivery; attempt++) {
      try {
        const last = await prisma.delivery.findFirst({ orderBy: { docNum: 'desc' } })
        const docNum = (last?.docNum ?? 0) + 1
        delivery = await prisma.delivery.create({
          data: {
            docNum,
            cardCode: quotation.cardCode,
            cardName: quotation.cardName,
            remarks: `Sao chép từ báo giá bán hàng #${quotation.docNum}`,
            sourceOrderId: null,
            sourceQuotationId: quotation.id,
            sapDatabaseId: quotation.sapDatabaseId,
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
                sourceQuotationLineId: x.line.id,
              })),
            },
          },
          include: { lines: true },
        })
      } catch (e) {
        if ((e as { code?: string })?.code !== 'P2002') throw e
        console.warn(`[deliveries/from-quotation] docNum conflict, retry ${attempt + 1}/5`)
      }
    }
    if (!delivery) return { body: { error: 'Không thể cấp số phiếu' }, status: 500 }
    return { body: { ok: true, delivery }, status: 201 }
  }

  if (req.nextUrl.searchParams.get('prefill') === '1') {
    const result = await run()
    return NextResponse.json(result.body, { status: result.status })
  }

  if (!acquireOrderLock(quotationId)) {
    return NextResponse.json({ error: 'Báo giá này đang được tạo phiếu giao hàng ở một phiên khác — vui lòng đợi' }, { status: 409 })
  }
  try {
    const { result, replayed } = await dedupeRequest(dedupeKey, run)
    return NextResponse.json(result.body, { status: replayed ? 200 : result.status })
  } finally {
    releaseOrderLock(quotationId)
  }
}
