import { NextRequest, NextResponse } from 'next/server'
import { parsePageParam } from '@/lib/fm-shared'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// ============================================================
// GET /api/sap-audit — danh sách nhật ký gọi Service Layer (mới nhất trước)
//   ?page=1&pageSize=20&status=all|ok|error&q=Orders
// DELETE /api/sap-audit — xóa sạch nhật ký (cần quyền settings.edit)
// Quyền xem: settings.view (màn hình nằm trong nhóm Quản trị)
// ============================================================

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem nhật ký Service Layer' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const page = parsePageParam(sp.get('page'), 1, 1, 100000)
  const pageSize = parsePageParam(sp.get('pageSize'), 20, 5, 100)
  const status = sp.get('status') ?? 'all'
  const q = (sp.get('q') ?? '').trim()

  const where: Record<string, unknown> = {}
  if (status === 'ok') where.ok = true
  if (status === 'error') where.ok = false
  if (q) where.path = { contains: q }

  const [total, rows] = await Promise.all([
    prisma.sapAuditLog.count({ where }),
    prisma.sapAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return NextResponse.json({
    data: rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền xóa nhật ký' }, { status: 403 })
  }
  await prisma.sapAuditLog.deleteMany({})
  return NextResponse.json({ ok: true })
}
