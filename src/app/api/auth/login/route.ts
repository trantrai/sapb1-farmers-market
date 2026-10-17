import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { SESSION_COOKIE, hashPassword, verifyPassword, makeToken } from '@/lib/fm-auth'
import { parsePerm } from '@/lib/fm-shared'
import { rateLimit } from '@/lib/rate-limit'
import { ensureSapDatabases, defaultDatabaseId } from '@/lib/sap-service-layer'

// Chống brute-force: tối đa 10 lần thử / 10 phút / IP
const LOGIN_MAX = 10
const LOGIN_WINDOW_MS = 10 * 60 * 1000
// Bucket toàn cục: X-Forwarded-For do client gửi lên nên có thể bị giả mạo
// để xoay IP — bucket toàn cục chặn brute-force phân tán (không bypass được).
const LOGIN_GLOBAL_MAX = 300

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip')?.trim() ||
      'unknown'
    const tooMany = (retryAfterSec: number) => {
      const mins = Math.max(1, Math.round(retryAfterSec / 60))
      return NextResponse.json(
        { error: `Quá nhiều lần đăng nhập — vui lòng thử lại sau khoảng ${mins} phút` },
        { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
      )
    }
    const rlGlobal = rateLimit('login:global', LOGIN_GLOBAL_MAX, LOGIN_WINDOW_MS)
    if (!rlGlobal.ok) return tooMany(rlGlobal.retryAfterSec)
    const rl = rateLimit(`login:${ip}`, LOGIN_MAX, LOGIN_WINDOW_MS)
    if (!rl.ok) return tooMany(rl.retryAfterSec)

    const { username, password, databaseId } = await req.json()
    if (!username || !password) {
      return NextResponse.json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' }, { status: 400 })
    }

    // Validate database được chọn (nếu có) — chống token mang DB id giả
    await ensureSapDatabases()
    let dbId: string | null = null
    let dbLabel: string | null = null
    if (databaseId) {
      const db = await prisma.sapDatabase.findUnique({
        where: { id: String(databaseId) },
        select: { id: true, label: true },
      })
      if (!db) {
        return NextResponse.json({ error: 'Database SAP đã chọn không tồn tại' }, { status: 400 })
      }
      dbId = db.id
      dbLabel = db.label
    } else {
      // Không chọn → dùng DB mặc định (nếu có khai báo)
      dbId = await defaultDatabaseId()
      if (dbId) {
        const db = await prisma.sapDatabase.findUnique({
          where: { id: dbId },
          select: { label: true },
        })
        dbLabel = db?.label ?? null
      }
    }

    const uname = String(username).trim().toLowerCase()
    const user = await prisma.user.findUnique({ where: { username: uname } })
    // Chống username enumeration qua timing attack: khi user không tồn tại vẫn
    // chạy 1 lượt scrypt giả (thời gian tương đương verify thật) rồi mới trả 401.
    // Hash giả này là hằng số — không phải secret, chỉ dùng để cân bằng thời gian.
    const DUMMY_HASH = 'scrypt$16384$8$1$007c6f17c9e7e7e909f5d4014226ae86$cd74cc9cf55a565fdc81dbace008ced1076d7a3600c3383804b61b4ec1956da6'
    let verdict: 'ok' | 'legacy' | 'fail'
    if (user) {
      verdict = await verifyPassword(String(password), user.password)
    } else {
      await verifyPassword(String(password), DUMMY_HASH) // cân bằng thời gian
      verdict = 'fail'
    }
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
    const token = makeToken(user.username, dbId)

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
        mustChangePassword: Boolean(user.mustChangePassword),
        databaseId: dbId,
        databaseLabel: dbLabel,
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
