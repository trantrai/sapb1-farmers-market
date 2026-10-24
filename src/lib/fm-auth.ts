import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { db as prisma } from '@/lib/db'
import { parsePerm, SessionUser } from '@/lib/fm-shared'

// Re-export để các route cũ vẫn import từ '@/lib/fm-auth' được
export { hashPassword, verifyPassword } from './fm-crypto'

/**
 * Migration 1 lần: bổ sung quyền module `deliveries` (tạo trước khi module
 * Giao hàng ra đời) và `bomSwap` (chỉ Admin) cho các role cũ. Chạy lazy khi có request
 * authenticated đầu tiên sau deploy — không cần chạy seed lại.
 */
let _roleMigrated = false
async function ensureDeliveriesPerm(): Promise<void> {
  if (_roleMigrated) return
  _roleMigrated = true
  try {
    const roles = await prisma.role.findMany({ select: { id: true, name: true, permissions: true } })
    for (const r of roles) {
      let perm: Record<string, Record<string, boolean>>
      try {
        perm = JSON.parse(r.permissions ?? '{}')
      } catch {
        continue
      }
      const changed: string[] = []
      if (!perm.deliveries) {
        // Mặc định kế thừa từ quyền orders (cùng workflow chứng từ)
        const orders = perm.orders ?? {}
        perm.deliveries = {
          view: true,
          create: Boolean(orders.create),
          edit: Boolean(orders.edit),
          delete: Boolean(orders.delete),
        }
        changed.push('deliveries')
      }
      if (!perm.bomSwap) {
        // Hoán đổi thành phần BOM (đưa mặt hàng ngoài công thức vào với giá 0):
        // mặc định CHỈ Admin; role khác do Admin cấp ở màn Ủy quyền
        const admin = r.name === 'Admin'
        perm.bomSwap = { view: admin, create: false, edit: admin, delete: false }
        changed.push('bomSwap')
      }
      if (changed.length === 0) continue
      await prisma.role.update({
        where: { id: r.id },
        data: { permissions: JSON.stringify(perm) },
      })
      console.log(`[migrate] Đã bổ sung quyền ${changed.join(', ')} cho role ${r.name}`)
    }
  } catch (e) {
    console.warn('[migrate] Bổ sung quyền deliveries thất bại:', e instanceof Error ? e.message : e)
  }
}

export const SESSION_COOKIE = 'fm_session'
/** Token có hiệu lực 12 giờ — khớp maxAge của cookie phiên */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Secret ký token: bắt buộc đọc từ biến môi trường FM_SESSION_SECRET.
 * Nếu chưa đặt (môi trường dev), dùng secret ngẫu nhiên cho lần chạy này
 * và cảnh báo rõ — mọi phiên đăng nhập sẽ hết hiệu lực khi restart server.
 * TUYỆT ĐỐI không hardcode secret trong code (bản cũ đã làm vậy).
 */
function resolveSecret(): string {
  const env = process.env.FM_SESSION_SECRET
  if (env && env.length >= 16) return env
  const rand = randomBytes(32).toString('hex')
  console.warn(
    '[fm-auth] FM_SESSION_SECRET chưa được đặt (hoặc ngắn hơn 16 ký tự) — ' +
      'đang dùng secret ngẫu nhiên cho lần chạy này. Mọi phiên đăng nhập sẽ ' +
      'hết hiệu lực khi restart server. Hãy đặt FM_SESSION_SECRET trong production.',
  )
  return rand
}
const SECRET = resolveSecret()

function sign(payloadB64: string): string {
  return createHmac('sha256', SECRET).update(payloadB64).digest('hex')
}

/** So sánh chữ ký bằng constant-time (chống timing attack) */
function sigEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Tạo token phiên bản v2: v2.<base64url({u, db, iat})>.<hmac-sha256>
 * db = id SapDatabase đã chọn khi đăng nhập (null = dùng DB mặc định).
 * Token v1 đời cũ (không tiền tố, không thời hạn, ký bằng secret hardcode
 * đã lộ trong repo) bị TỪ CHỐI — user phải đăng nhập lại 1 lần sau deploy.
 */
export function makeToken(username: string, databaseId?: string | null): string {
  const payload = Buffer.from(
    JSON.stringify({ u: username, db: databaseId ?? null, iat: Date.now() }),
  ).toString('base64url')
  return `v2.${payload}.${sign(payload)}`
}

/** Đọc token → { username, databaseId }, hoặc null khi token sai/giả mạo/hết hạn */
export function readToken(token: string | undefined | null): {
  username: string
  databaseId: string | null
} | null {
  if (!token || typeof token !== 'string' || !token.startsWith('v2.')) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [, payloadB64, sig] = parts
  if (!sigEq(sign(payloadB64), sig)) return null
  try {
    const { u, db, iat } = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      u?: unknown
      db?: unknown
      iat?: unknown
    }
    if (typeof u !== 'string' || !u || typeof iat !== 'number') return null
    if (Date.now() - iat > TOKEN_TTL_MS) return null // hết hạn 12h
    // Token cũ (trước multi-DB) không có db → null = dùng DB mặc định
    return { username: u, databaseId: typeof db === 'string' && db ? db : null }
  } catch {
    return null
  }
}

/**
 * Lấy user hiện tại.
 * Ưu tiên 1: Bearer token trong header Authorization (hoạt động trong iframe cross-site).
 * Ưu tiên 2: cookie fm_session (môi trường same-site / localhost).
 */
export async function getSessionUser(req?: Request): Promise<SessionUser | null> {
  let tokenInfo: { username: string; databaseId: string | null } | null = null

  const auth = req?.headers.get('authorization')
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    tokenInfo = readToken(auth.slice(7).trim())
  }

  if (!tokenInfo) {
    try {
      const store = await cookies()
      tokenInfo = readToken(store.get(SESSION_COOKIE)?.value)
    } catch {
      /* ngoài scope request */
    }
  }

  if (!tokenInfo) return null
  const { username, databaseId } = tokenInfo

  // Migration lazy: đảm bảo roles cũ có quyền deliveries
  await ensureDeliveriesPerm()

  const user = await prisma.user.findUnique({ where: { username } })
  if (!user || !user.active) return null // tài khoản bị vô hiệu hóa → coi như chưa đăng nhập

  const role = await prisma.role.findUnique({ where: { name: user.role } })
  // Resolve database đã chọn → label để hiển thị; DB bị xóa → fallback null (dùng mặc định)
  let databaseLabel: string | null = null
  if (databaseId) {
    const db = await prisma.sapDatabase.findUnique({
      where: { id: databaseId },
      select: { label: true },
    })
    databaseLabel = db?.label ?? null
  }
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    roleLabel: role?.label ?? user.role,
    permissions: parsePerm(role?.permissions),
    mustChangePassword: Boolean(user.mustChangePassword),
    databaseId: databaseLabel ? databaseId : null,
    databaseLabel,
  }
}

export function unauthorized() {
  return Response.json({ error: 'Chưa đăng nhập hoặc phiên hết hạn' }, { status: 401 })
}
