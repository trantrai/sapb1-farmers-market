import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized, hashPassword, verifyPassword } from '@/lib/fm-auth'
import { validatePassword } from '@/lib/password-policy'
import { rateLimit } from '@/lib/rate-limit'

// Chống brute-force mật khẩu cũ: tối đa 20 lần thử / 10 phút / IP
const CP_MAX = 20
const CP_WINDOW_MS = 10 * 60 * 1000

/**
 * POST /api/auth/change-password
 * Body: { oldPassword, newPassword }
 * - Yêu cầu đăng nhập.
 * - Verify oldPassword bằng đúng hàm verifyPassword (fm-crypto).
 * - Validate mật khẩu mới: tối thiểu 8 ký tự, có chữ + số.
 * - Thành công: đổi hash mới + set mustChangePassword = false.
 */
export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip')?.trim() ||
      'unknown'
    const rl = rateLimit(`change-password:${ip}`, CP_MAX, CP_WINDOW_MS)
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Quá nhiều lần thử — vui lòng thử lại sau vài phút' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    const session = await getSessionUser(req)
    if (!session) return unauthorized()

    const body = await req.json().catch(() => null)
    const oldPassword = String(body?.oldPassword ?? '')
    const newPassword = String(body?.newPassword ?? '')

    const err = validatePassword(newPassword)
    if (err) return NextResponse.json({ error: err }, { status: 400 })
    if (!oldPassword) {
      return NextResponse.json({ error: 'Vui lòng nhập mật khẩu hiện tại' }, { status: 400 })
    }
    if (oldPassword === newPassword) {
      return NextResponse.json(
        { error: 'Mật khẩu mới phải khác mật khẩu hiện tại' },
        { status: 400 },
      )
    }

    const user = await prisma.user.findUnique({ where: { id: session.id } })
    if (!user || !user.active) return unauthorized()

    // verifyPassword trả về 'ok' | 'legacy' (hash cũ nhưng đúng) | 'fail'
    const verdict = await verifyPassword(oldPassword, user.password)
    if (verdict === 'fail') {
      return NextResponse.json({ error: 'Mật khẩu hiện tại không đúng' }, { status: 400 })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await hashPassword(newPassword),
        mustChangePassword: false,
      },
    })

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Yêu cầu không hợp lệ' }, { status: 400 })
  }
}
