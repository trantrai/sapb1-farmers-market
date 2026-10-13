import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/roles — danh sách vai trò + ma trận quyền
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.roles?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem phân quyền' }, { status: 403 })
  }

  const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } })
  const users = await prisma.user.findMany({ select: { username: true, fullName: true, role: true } })
  return NextResponse.json({ data: roles, users })
}

// PUT /api/roles — cập nhật ma trận quyền của 1 vai trò
export async function PUT(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.roles?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa phân quyền' }, { status: 403 })
  }

  try {
    const { id, permissions } = (await req.json()) as { id: string; permissions: string }
    if (!id || !permissions) {
      return NextResponse.json({ error: 'Thiếu dữ liệu vai trò / quyền' }, { status: 400 })
    }

    // Không cho tự mù quyền của chính vai trò Admin
    const role = await prisma.role.findUnique({ where: { id } })
    if (!role) return NextResponse.json({ error: 'Không tìm thấy vai trò' }, { status: 404 })
    if (role.name === 'Admin' && user.role !== 'Admin') {
      return NextResponse.json({ error: 'Chỉ Admin mới được sửa quyền Admin' }, { status: 403 })
    }

    // Không cho user sửa chính vai trò mình đang mang (tránh tự leo thang quyền);
    // Admin vẫn được phép sửa vai trò Admin theo quy định ở trên
    if (user.role !== 'Admin' && role.name === user.role) {
      return NextResponse.json(
        { error: 'Bạn không thể sửa vai trò mình đang sử dụng' },
        { status: 403 },
      )
    }

    const updated = await prisma.role.update({ where: { id }, data: { permissions } })
    return NextResponse.json({ ok: true, role: updated })
  } catch (e) {
    console.error('PUT /api/roles', e)
    return NextResponse.json({ error: 'Không thể lưu phân quyền' }, { status: 500 })
  }
}
