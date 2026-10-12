// ============================================================
// FARMERS MARKET — Mật mã học: băm & kiểm tra mật khẩu
// Dùng crypto.scrypt của Node (KDF chuẩn: salt ngẫu nhiên mỗi user,
// cost cao chống brute-force bằng GPU).
// Định dạng lưu trong DB: scrypt$N$r$p$saltHex$hashHex
// Tương thích ngược: mật khẩu cũ sha256(pw + 'fm-salt-2024') vẫn verify
// được và sẽ TỰ ĐỘNG nâng cấp sang scrypt ở lần đăng nhập thành công.
// File này KHÔNG import next/* để các script bun (seed/…) dùng chung được.
// ============================================================

import { scrypt, randomBytes, timingSafeEqual, createHash } from 'crypto'

const N = 16384
const R = 8
const P = 1
const KEYLEN = 32
const LEGACY_SALT = 'fm-salt-2024'

function scryptKey(pw: string, saltHex: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Lưu ý: options của Node là { N, r, p } (r, p viết thường)
    scrypt(pw, Buffer.from(saltHex, 'hex'), KEYLEN, { N, r: R, p: P }, (err, key) => {
      if (err) reject(err)
      else resolve(key as Buffer)
    })
  })
}

/** Băm mật khẩu mới bằng scrypt (salt ngẫu nhiên 16 byte) */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = await scryptKey(pw, salt)
  return `scrypt$${N}$${R}$${P}$${salt}$${hash.toString('hex')}`
}

function legacyHash(pw: string): string {
  return createHash('sha256').update(pw + LEGACY_SALT).digest('hex')
}

/** So sánh chuỗi hex bằng constant-time (chống timing attack) */
function safeEqHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Kiểm tra mật khẩu.
 * Trả về 'ok' | 'legacy' (đúng nhưng đang dùng hash cũ → caller nên re-hash)
 * | 'fail'.
 */
export async function verifyPassword(pw: string, stored: string): Promise<'ok' | 'legacy' | 'fail'> {
  if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
    const parts = stored.split('$')
    if (parts.length !== 6) return 'fail'
    const [, n, r, p, salt, hex] = parts
    if (n !== String(N) || r !== String(R) || p !== String(P)) return 'fail'
    if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(hex)) return 'fail'
    const calc = await scryptKey(pw, salt)
    return safeEqHex(calc.toString('hex'), hex) ? 'ok' : 'fail'
  }
  // Hash đời cũ: sha256(pw + salt cố định) — chấp nhận 1 lần để nâng cấp
  return safeEqHex(legacyHash(pw), stored) ? 'legacy' : 'fail'
}
