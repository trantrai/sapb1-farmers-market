import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/order-templates — danh sách mẫu đơn hàng
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orderTemplates?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem mẫu đơn hàng' }, { status: 403 })
  }

  const templates = await prisma.orderTemplate.findMany({
    orderBy: [{ updatedAt: 'desc' }],
  })
  return NextResponse.json({
    data: templates.map((t) => ({
      ...t,
      lines: JSON.parse(t.lines),
    })),
  })
}

// POST /api/order-templates — lưu đơn hàng hiện tại thành mẫu
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orderTemplates?.create) {
    return NextResponse.json({ error: 'Không có quyền tạo mẫu đơn hàng' }, { status: 403 })
  }

  try {
    const body = (await req.json()) as {
      name?: string
      description?: string
      cardCode?: string
      cardName?: string
      lines?: Array<{
        itemCode: string
        itemName?: string
        quantity?: number
        unitPrice?: number
        discPct?: number
        vatPct?: number
        uom?: string
        taxCode?: string
        warehouseCode?: string
      }>
    }
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Tên mẫu không được để trống' }, { status: 400 })
    }
    const lines = (body.lines ?? []).filter((l) => l.itemCode?.trim() && (l.quantity ?? 0) > 0)
    if (lines.length === 0) {
      return NextResponse.json({ error: 'Mẫu phải có ít nhất 1 dòng hàng hợp lệ' }, { status: 400 })
    }

    const template = await prisma.orderTemplate.create({
      data: {
        name: body.name.trim(),
        description: body.description?.trim() || null,
        cardCode: body.cardCode?.trim() || null,
        cardName: body.cardName?.trim() || null,
        lines: JSON.stringify(
          lines.map((l) => ({
            itemCode: l.itemCode.trim(),
            itemName: l.itemName?.trim() || l.itemCode.trim(),
            quantity: l.quantity ?? 1,
            unitPrice: l.unitPrice ?? 0,
            discPct: l.discPct ?? 0,
            vatPct: l.vatPct ?? 8,
            uom: l.uom || undefined,
            taxCode: l.taxCode || undefined,
            warehouseCode: l.warehouseCode || undefined,
          }))
        ),
        createdBy: user.username,
      },
    })
    return NextResponse.json(
      { data: { ...template, lines: JSON.parse(template.lines) } },
      { status: 201 }
    )
  } catch {
    return NextResponse.json({ error: 'Không thể lưu mẫu đơn hàng' }, { status: 500 })
  }
}
