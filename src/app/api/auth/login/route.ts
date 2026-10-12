import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { SESSION_COOKIE, hashPassword, makeToken } from '@/lib/fm-auth'
import { parsePerm } from '@/lib/fm-shared'

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json()
    if (!username || !password) {
      return NextResponse.json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' }, { status: 400 })
    }

    const uname = String(username).trim().toLowerCase()
    const user = await prisma.user.findUnique({ where: { username: uname } })
    if (!user || user.password !== hashPassword(String(password))) {
      return NextResponse.json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' }, { status: 401 })
    }
    if (!user.active) {
      return NextResponse.json(
        { error: 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.' },
        { status: 403 },
      )
    }

    const role = await prisma.role.findUnique({ where: { name: user.role } })
    const token = makeToken(user.username)

    // Cookie vẫn giữ làm phương án dự phòng cho môi trường same-site (localhost)
    const res = NextResponse.json({
      ok: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        roleLabel: role?.label ?? user.role,
        permissions: parsePerm(role?.permissions),
      },
    })
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 12,
    })
    return res
  } catch {
    return NextResponse.json({ error: 'Yêu cầu không hợp lệ' }, { status: 400 })
  }
}
