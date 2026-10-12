import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized, hashPassword } from '@/lib/fm-auth'
import { ROLE_OPTIONS } from '@/lib/fm-shared'

const PUBLIC_SELECT = {
  id: true,
  username: true,
  fullName: true,
  role: true,
  active: true,
  createdAt: true,
  updatedAt: true,
}

// GET /api/users — danh sách người dùng + vai trò hiện có
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.users?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh sách người dùng' }, { status: 403 })
  }

  const users = await prisma.user.findMany({ select: PUBLIC_SELECT, orderBy: { username: 'asc' } })
  const roles = await prisma.role.findMany({ select: { name: true, label: true }, orderBy: { name: 'asc' } })
  return NextResponse.json({ data: users, roles, me: user.username })
}

// POST /api/users — tạo người dùng mới
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.users?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo người dùng' }, { status: 403 })
  }

  try {
    const body = (await req.json()) as {
      username?: string
      fullName?: string
      password?: string
      role?: string
    }
    const username = String(body.username ?? '').trim().toLowerCase()
    const fullName = String(body.fullName ?? '').trim()
    const password = String(body.password ?? '')
    const role = String(body.role ?? '').trim()

    if (!username || !fullName || !password || !role) {
      return NextResponse.json(
        { error: 'Vui lòng nhập đủ tên đăng nhập, họ tên, mật khẩu và vai trò' },
        { status: 400 },
      )
    }
    if (!/^[a-z0-9._-]{3,24}$/.test(username)) {
      return NextResponse.json(
        { error: 'Tên đăng nhập 3–24 ký tự: chữ thường, số, dấu chấm, gạch dưới/ngang' },
        { status: 400 },
      )
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Mật khẩu tối thiểu 6 ký tự' }, { status: 400 })
    }

    const roleExists = await prisma.role.findUnique({ where: { name: role } })
    if (!roleExists) {
      const valid: string[] = []
      for (const r of ROLE_OPTIONS) {
        if (await prisma.role.findUnique({ where: { name: r } })) valid.push(r)
      }
      return NextResponse.json(
        { error: `Vai trò "${role}" không tồn tại. Vai trò hợp lệ: ${valid.join(', ') || '—'}` },
        { status: 400 },
      )
    }

    const dup = await prisma.user.findUnique({ where: { username } })
    if (dup) {
      return NextResponse.json({ error: `Tên đăng nhập "${username}" đã được sử dụng` }, { status: 409 })
    }

    const created = await prisma.user.create({
      data: { username, fullName, role, password: hashPassword(password), active: true },
      select: PUBLIC_SELECT,
    })
    return NextResponse.json({ ok: true, user: created }, { status: 201 })
  } catch (e) {
    console.error('POST /api/users', e)
    return NextResponse.json({ error: 'Không thể tạo người dùng' }, { status: 500 })
  }
}
