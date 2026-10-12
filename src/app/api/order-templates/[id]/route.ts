import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// DELETE /api/order-templates/[id] — xóa mẫu đơn hàng
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Không có quyền xóa mẫu đơn hàng' }, { status: 403 })
  }

  try {
    const { id } = await params
    const existing = await prisma.orderTemplate.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Không tìm thấy mẫu đơn hàng' }, { status: 404 })
    }
    await prisma.orderTemplate.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Không thể xóa mẫu đơn hàng' }, { status: 500 })
  }
}
