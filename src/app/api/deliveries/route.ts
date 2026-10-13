import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'

// GET /api/deliveries — danh sách (filter: q, status, page, pageSize)
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem giao hàng' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const status = sp.get('status') ?? ''
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(50, Math.max(5, parseInt(sp.get('pageSize') ?? '10', 10) || 10))

  const where: Record<string, unknown> = {}
  // B1: cách ly DB
  if (user.databaseId) where.sapDatabaseId = user.databaseId
  if (q) {
    where.OR = [
      { cardCode: { contains: q } },
      { cardName: { contains: q } },
      ...(isNaN(Number(q)) ? [] : [{ docNum: Number(q) }]),
    ]
  }
  if (['Open', 'Closed', 'Cancelled'].includes(status)) where.status = status

  const [total, rows] = await Promise.all([
    prisma.delivery.count({ where }),
    prisma.delivery.findMany({
      where,
      orderBy: { docNum: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        lines: { orderBy: { lineNum: 'asc' } },
        sourceOrder: { select: { id: true, docNum: true } },
      },
    }),
  ])

  return NextResponse.json({
    ok: true,
    data: rows,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  })
}

// POST /api/deliveries — tạo delivery thủ công
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo phiếu giao hàng' }, { status: 403 })
  }
  const rl = rateLimit(`delivery:create:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  let body: {
    cardCode?: string; cardName?: string; docDate?: string; remarks?: string
    sourceOrderId?: string
    lines?: Array<{ itemCode: string; itemName: string; quantity: number; uom?: string; unitPrice?: number }>
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
  }
  const cardCode = String(body.cardCode ?? '').trim()
  const cardName = String(body.cardName ?? '').trim()
  if (!cardCode || !cardName) {
    return NextResponse.json({ error: 'Vui lòng nhập mã và tên khách hàng' }, { status: 400 })
  }
  const lines = (body.lines ?? []).filter((l) => l.itemCode && l.quantity > 0)
  if (lines.length === 0) {
    return NextResponse.json({ error: 'Phiếu giao hàng cần ít nhất 1 dòng' }, { status: 400 })
  }

  const grandTotal = lines.reduce((s, l) => s + l.quantity * (l.unitPrice ?? 0), 0)
  let delivery: Awaited<ReturnType<typeof prisma.delivery.create>> | null = null
  for (let attempt = 0; attempt < 3 && !delivery; attempt++) {
    try {
      const last = await prisma.delivery.findFirst({ orderBy: { docNum: 'desc' } })
      const docNum = (last?.docNum ?? 0) + 1
      delivery = await prisma.delivery.create({
        data: {
          docNum,
          cardCode,
          cardName,
      docDate: body.docDate ? new Date(body.docDate) : new Date(),
      remarks: body.remarks?.trim() || null,
      sourceOrderId: body.sourceOrderId || null,
      sapDatabaseId: user.databaseId,
      grandTotal: Math.round(grandTotal),
      createdBy: user.id,
      lines: {
        create: lines.map((l, i) => ({
          lineNum: i + 1,
          itemCode: l.itemCode.trim(),
          itemName: (l.itemName || l.itemCode).trim(),
          quantity: l.quantity,
          uom: l.uom || '',
          unitPrice: l.unitPrice ?? 0,
          lineTotal: Math.round(l.quantity * (l.unitPrice ?? 0)),
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
