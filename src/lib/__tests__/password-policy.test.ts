import { describe, it, expect } from 'vitest'
import { generateStrongPassword, validatePassword, SEED_PASSWORD_LENGTH } from '../password-policy'

describe('generateStrongPassword', () => {
  it('sinh mật khẩu đủ dài theo mặc định (16)', () => {
    const pw = generateStrongPassword()
    expect(pw).toHaveLength(SEED_PASSWORD_LENGTH)
  })

  it('luôn có chữ hoa + chữ thường + số (đủ mạnh, qua được validate)', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateStrongPassword()
      expect(/[A-Z]/.test(pw)).toBe(true)
      expect(/[a-z]/.test(pw)).toBe(true)
      expect(/[0-9]/.test(pw)).toBe(true)
      expect(validatePassword(pw)).toBeNull()
    }
  })

  it('chỉ chứa ký tự alphanum không gây nhầm (loại bỏ 0, 1, I, O, l, o)', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateStrongPassword()
      expect(/^[A-Za-z0-9]+$/.test(pw)).toBe(true)
      expect(pw).not.toMatch(/[0O1lI]/)
    }
  })

  it('sinh 100 mật khẩu đều khác nhau', () => {
    const set = new Set<string>()
    for (let i = 0; i < 100; i++) set.add(generateStrongPassword())
    expect(set.size).toBe(100)
  })

  it('tôn trọng độ dài tùy chọn và từ chối độ dài < 8', () => {
    expect(generateStrongPassword(24)).toHaveLength(24)
    expect(() => generateStrongPassword(7)).toThrow()
  })
})

describe('validatePassword', () => {
  it('hợp lệ: >= 8 ký tự, có chữ và số', () => {
    expect(validatePassword('Abcd1234')).toBeNull()
    expect(validatePassword('p@ssw0rd!dài')).toBeNull()
  })

  it('từ chối: rỗng / không phải chuỗi', () => {
    expect(validatePassword('')).not.toBeNull()
    expect(validatePassword(undefined)).not.toBeNull()
  })

  it('từ chối: ngắn hơn 8 ký tự', () => {
    expect(validatePassword('Ab1')).not.toBeNull()
    expect(validatePassword('Abcdef1')).not.toBeNull()
  })

  it('từ chối: thiếu chữ hoặc thiếu số', () => {
    expect(validatePassword('12345678')).not.toBeNull()
    expect(validatePassword('abcdefgh')).not.toBeNull()
  })

  it('từ chối mật khẩu seed cũ yếu (admin123 ok vì có chữ+số — nhưng seed giờ không dùng nữa)', () => {
    expect(validatePassword('123456')).not.toBeNull()
    expect(validatePassword('password')).not.toBeNull()
  })
})
