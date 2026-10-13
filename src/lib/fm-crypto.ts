// ============================================================
// FARMERS MARKET — Mật mã học: băm & kiểm tra mật khẩu
// Dùng crypto.scrypt của Node (KDF chuẩn: salt ngẫu nhiên mỗi user,
// cost cao chống brute-force bằng GPU).
// Định dạng lưu trong DB: scrypt$N$r$p$saltHex$hashHex
// Tương thích ngược: mật khẩu cũ sha256(pw + 'fm-salt-2024') vẫn verify
// được và sẽ TỰ ĐỘNG nâng cấp sang scrypt ở lần đăng nhập thành công.
// File này KHÔNG import next/* để các script bun (seed/…) dùng chung được.
// ============================================================

import { scrypt, randomBytes, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'crypto'

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

// ============================================================
// MÃ HÓA SECRET LƯU DB (mật khẩu SAP B1, SMTP) — AES-256-GCM
// Khóa suy từ FM_DATA_KEY (riêng) hoặc FM_SESSION_SECRET; dev chưa đặt
// thì dùng khóa tạm (có cảnh báo). Định dạng: enc:v1:<ivHex>:<dataHex>
// (data = ciphertext + auth tag 16 byte). Giá trị plaintext cũ (không có
// prefix) được decryptSecret trả về nguyên — tương thích ngược, sẽ được
// mã hóa lại ở lần lưu cài đặt tiếp theo.
// ============================================================

const ENC_PREFIX = 'enc:v1:'
let dataKeyWarned = false

function dataKey(): Buffer {
  const raw = process.env.FM_DATA_KEY || process.env.FM_SESSION_SECRET || ''
  if (raw.length >= 16) {
    return createHash('sha256').update('fm-data-key-v1:' + raw).digest()
  }
  // B2: production KHÔNG được dùng khóa fallback suy ra được từ source.
  // Nếu dữ liệu cũ mã hóa bằng fallback, hãy đặt FM_DATA_KEY rồi nhập lại
  // mật khẩu SAP/SMTP ở trang Cài đặt (dữ liệu cũ không giải mã được nữa).
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[fm-crypto] FM_DATA_KEY chưa đặt — từ chối khởi động ở production vì ' +
        'khóa mã hóa fallback không an toàn. Hãy đặt FM_DATA_KEY (≥16 ký tự) trong .env ' +
        'rồi nhập lại mật khẩu SAP/SMTP ở trang Cài đặt.',
    )
  }
  if (!dataKeyWarned) {
    dataKeyWarned = true
    console.warn(
      '[fm-crypto] FM_DATA_KEY/FM_SESSION_SECRET chưa đặt — dùng khóa mã hóa tạm, ' +
        'KHÔNG an toàn cho production. Hãy đặt FM_DATA_KEY trong .env.',
    )
  }
  return createHash('sha256').update('fm-data-key-v1:dev-fallback').digest()
}

/** Mã hóa secret trước khi lưu DB */
export function encryptSecret(plain: string): string {
  if (!plain) return ''
  if (plain.startsWith(ENC_PREFIX)) return plain // đã mã hóa rồi
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dataKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('hex')}:${Buffer.concat([enc, tag]).toString('hex')}`
}

/** Giải mã secret đọc từ DB (plaintext cũ trả về nguyên) */
export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored
  try {
    const [, , ivHex, dataHex] = stored.split(':')
    const iv = Buffer.from(ivHex, 'hex')
    const data = Buffer.from(dataHex, 'hex')
    const decipher = createDecipheriv('aes-256-gcm', dataKey(), iv)
    decipher.setAuthTag(data.subarray(data.length - 16))
    const enc = data.subarray(0, data.length - 16)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
  } catch {
    return '' // sai khóa / dữ liệu hỏng → coi như trống, không crash
  }
}
