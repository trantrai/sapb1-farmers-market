import { createHash, createHmac } from 'crypto'
import { cookies } from 'next/headers'
import { db as prisma } from '@/lib/db'
import { parsePerm, SessionUser } from '@/lib/fm-shared'

const SECRET = 'fm-sapb1-secret-2026'
export const SESSION_COOKIE = 'fm_session'

export function hashPassword(pw: string): string {
  return createHash('sha256').update(pw + 'fm-salt-2024').digest('hex')
}

function sign(username: string): string {
  return createHmac('sha256', SECRET).update(username).digest('hex').slice(0, 32)
}

export function makeToken(username: string): string {
  return `${Buffer.from(username).toString('base64url')}.${sign(username)}`
}

export function readToken(token: string | undefined | null): string | null {
  if (!token || !token.includes('.')) return null
  const [b64, sig] = token.split('.')
  try {
    const username = Buffer.from(b64, 'base64url').toString('utf8')
    return sign(username) === sig ? username : null
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
  let username: string | null = null

  const auth = req?.headers.get('authorization')
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    username = readToken(auth.slice(7).trim())
  }

  if (!username) {
    try {
      const store = await cookies()
      username = readToken(store.get(SESSION_COOKIE)?.value)
    } catch {
      /* ngoài scope request */
    }
  }

  if (!username) return null

  const user = await prisma.user.findUnique({ where: { username } })
  if (!user || !user.active) return null // tài khoản bị vô hiệu hóa → coi như chưa đăng nhập

  const role = await prisma.role.findUnique({ where: { name: user.role } })
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    roleLabel: role?.label ?? user.role,
    permissions: parsePerm(role?.permissions),
  }
}

export function unauthorized() {
  return Response.json({ error: 'Chưa đăng nhập hoặc phiên hết hạn' }, { status: 401 })
}
