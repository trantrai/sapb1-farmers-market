import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

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
      sourceOrder: { select: { id: true, docNum: true, cardCode: true, cardName: true } },
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
