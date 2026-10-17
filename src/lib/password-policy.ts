// ============================================================
// FARMERS MARKET — Chính sách mật khẩu (client + server safe)
// - Sinh mật khẩu ngẫu nhiên MẠNH cho seed / cấp lại mật khẩu.
// - Validate mật khẩu mới: tối thiểu 8 ký tự, phải có chữ và số.
// File này KHÔNG import next/* để seed script dùng chung được.
// ============================================================

import { randomBytes } from 'crypto'

/** Độ dài mật khẩu ngẫu nhiên do seed sinh */
export const SEED_PASSWORD_LENGTH = 16

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // bỏ I, O (dễ nhầm)
const LOWER = 'abcdefghijkmnpqrstuvwxyz' // bỏ l, o (dễ nhầm)
const DIGITS = '23456789' // bỏ 0, 1 (dễ nhầm với O, l)
const ALPHANUM = UPPER + LOWER + DIGITS

function pickRandomChar(pool: string): string {
  // rejection sampling trên 1 byte — phân phối đều, không bias modulo
  const limit = 256 - (256 % pool.length)
  for (;;) {
    const b = randomBytes(1)[0]
    if (b < limit) return pool[b % pool.length]
  }
}

/**
 * Sinh mật khẩu ngẫu nhiên mạnh (crypto.randomBytes).
 * Bảo đảm: có chữ hoa + chữ thường + số, dài `length` ký tự (mặc định 16).
 */
export function generateStrongPassword(length: number = SEED_PASSWORD_LENGTH): string {
  if (length < 8) throw new Error('Độ dài mật khẩu ngẫu nhiên phải >= 8')
  const chars: string[] = [
    pickRandomChar(UPPER),
    pickRandomChar(LOWER),
    pickRandomChar(DIGITS),
  ]
  for (let i = chars.length; i < length; i++) chars.push(pickRandomChar(ALPHANUM))
  // Fisher–Yates xáo trộn bằng entropy thật
  for (let i = chars.length - 1; i > 0; i--) {
    const limit = 256 - (256 % (i + 1))
    let b: number
    do {
      b = randomBytes(1)[0]
    } while (b >= limit)
    const j = b % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/**
 * Validate mật khẩu mới. Trả về thông báo lỗi tiếng Việt, hoặc null khi hợp lệ.
 * Quy tắc: tối thiểu 8 ký tự, phải có ít nhất 1 chữ cái và 1 chữ số.
 */
export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length === 0) return 'Vui lòng nhập mật khẩu mới'
  if (pw.length < 8) return 'Mật khẩu mới phải có tối thiểu 8 ký tự'
  if (!/[A-Za-z]/.test(pw)) return 'Mật khẩu mới phải chứa ít nhất 1 chữ cái'
  if (!/[0-9]/.test(pw)) return 'Mật khẩu mới phải chứa ít nhất 1 chữ số'
  if (pw.length > 128) return 'Mật khẩu mới không được dài quá 128 ký tự'
  return null
}
