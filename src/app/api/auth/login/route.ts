import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { SESSION_COOKIE, hashPassword, verifyPassword, makeToken } from '@/lib/fm-auth'
import { parsePerm } from '@/lib/fm-shared'
import { rateLimit } from '@/lib/rate-limit'

// Chống brute-force: tối đa 10 lần thử / 10 phút / IP
const LOGIN_MAX = 10
const LOGIN_WINDOW_MS = 10 * 60 * 1000

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip')?.trim() ||
      'unknown'
    const rl = rateLimit(`login:${ip}`, LOGIN_MAX, LOGIN_WINDOW_MS)
    if (!rl.ok) {
      const mins = Math.max(1, Math.round(rl.retryAfterSec / 60))
      return NextResponse.json(
        { error: `Quá nhiều lần đăng nhập — vui lòng thử lại sau khoảng ${mins} phút` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    const { username, password } = await req.json()
    if (!username || !password) {
      return NextResponse.json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' }, { status: 400 })
    }

    const uname = String(username).trim().toLowerCase()
    const user = await prisma.user.findUnique({ where: { username: uname } })
    const verdict = user ? await verifyPassword(String(password), user.password) : 'fail'
    if (!user || verdict === 'fail') {
      // Thông báo chung chung để không lộ tài khoản nào tồn tại
      return NextResponse.json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' }, { status: 401 })
    }
    if (!user.active) {
      return NextResponse.json(
        { error: 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên.' },
        { status: 403 },
      )
    }

    // Tự động nâng cấp hash mật khẩu đời cũ (sha256) sang scrypt
    if (verdict === 'legacy') {
      await prisma.user.update({
        where: { id: user.id },
        data: { password: await hashPassword(String(password)) },
      })
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
      // Bắt buộc Secure khi chạy HTTPS (production) để cookie không lộ qua HTTP
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    })
    return res
  } catch {
    return NextResponse.json({ error: 'Yêu cầu không hợp lệ' }, { status: 400 })
  }
}
