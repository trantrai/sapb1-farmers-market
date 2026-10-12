import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// POST /api/sap-databases/[id]/set-default — đặt database mặc định (quyền settings.edit)
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa cài đặt' }, { status: 403 })
  }
  const { id } = await ctx.params
  const db = await prisma.sapDatabase.findUnique({ where: { id } })
  if (!db) return NextResponse.json({ error: 'Database không tồn tại' }, { status: 404 })

  await prisma.$transaction([
    prisma.sapDatabase.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    prisma.sapDatabase.update({ where: { id }, data: { isDefault: true } }),
  ])
  return NextResponse.json({ ok: true })
}
