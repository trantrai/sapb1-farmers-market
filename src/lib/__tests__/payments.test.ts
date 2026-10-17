// ============================================================
// Test logic ghi nhận thanh toán (MỤC 11) — xem @/lib/payments.
// Test thuần (không chạm DB), luôn chạy trong `npx vitest run`.
// ============================================================
import { describe, expect, it } from 'vitest'
import {
  PAYMENT_API_BASE,
  PAYMENT_EPS,
  applyPayment,
  derivePaymentStatus,
  validatePaymentAmount,
} from '@/lib/payments'

describe('validatePaymentAmount — rule ghi nhận thanh toán', () => {
  it('hợp lệ: amount > 0 và ≤ còn lại', () => {
    expect(validatePaymentAmount(100, 0, 500)).toBeNull()
    expect(validatePaymentAmount(500, 0, 500)).toBeNull() // đúng bằng còn lại
    expect(validatePaymentAmount(200, 300, 500)).toBeNull() // 300 đã thu, còn 200
  })
  it('từ chối amount ≤ 0 hoặc không phải số', () => {
    expect(validatePaymentAmount(0, 0, 500)).toContain('lớn hơn 0')
    expect(validatePaymentAmount(-50, 0, 500)).toContain('lớn hơn 0')
    expect(validatePaymentAmount(NaN, 0, 500)).toContain('con số')
    expect(validatePaymentAmount('abc', 0, 500)).toContain('con số')
    expect(validatePaymentAmount(undefined, 0, 500)).toContain('con số')
  })
  it('từ chối amount vượt số còn phải thu', () => {
    expect(validatePaymentAmount(501, 0, 500)).toContain('vượt số còn phải thu')
    expect(validatePaymentAmount(201, 300, 500)).toContain('vượt số còn phải thu')
  })
  it('chấp nhận chênh lệch làm tròn trong epsilon', () => {
    // còn lại 0.3 − 0.2 − 0.1 ≈ 0.00000000000000004 → vẫn ghi được
    expect(validatePaymentAmount(0.1, 0.2, 0.3)).toBeNull()
  })
})

describe('applyPayment — suy paidAmount + paymentStatus sau ghi nhận', () => {
  it('ghi một phần → partial', () => {
    expect(applyPayment(0, 1000, 400)).toEqual({ paidAmount: 400, paymentStatus: 'partial' })
  })
  it('ghi nhiều lần, lần cuối đủ → paid', () => {
    expect(applyPayment(700, 1000, 300)).toEqual({ paidAmount: 1000, paymentStatus: 'paid' })
  })
  it('ghi 1 lần đủ → paid', () => {
    expect(applyPayment(0, 2500, 2500)).toEqual({ paidAmount: 2500, paymentStatus: 'paid' })
  })
  it('chênh lệch làm tròn nhỏ hơn epsilon vẫn → paid', () => {
    // 999.9999999999 + 0.0000000002 ≈ 1000.0000000001 (sai số float) → vẫn 'paid'
    const r = applyPayment(999.9999999999, 1000, 0.0000000002)
    expect(r.paymentStatus).toBe('paid')
    expect(r.paidAmount).toBeCloseTo(1000, 9)
  })
  it('grandTotal = 0 → paid ngay', () => {
    expect(applyPayment(0, 0, 0.01)).toEqual({ paidAmount: 0.01, paymentStatus: 'paid' })
  })
})

describe('derivePaymentStatus — suy trạng thái hiện tại cho UI', () => {
  it('chưa thu gì → unpaid', () => {
    expect(derivePaymentStatus(0, 1000)).toBe('unpaid')
  })
  it('thu một phần → partial', () => {
    expect(derivePaymentStatus(400, 1000)).toBe('partial')
  })
  it('thu đủ → paid', () => {
    expect(derivePaymentStatus(1000, 1000)).toBe('paid')
  })
  it('sai số làm tròn trong epsilon vẫn → paid', () => {
    expect(derivePaymentStatus(999.9999999, 1000)).toBe('paid')
  })
})

describe('PAYMENT_API_BASE — map docType → api base', () => {
  it('đủ 3 loại chứng từ, base đúng', () => {
    expect(PAYMENT_API_BASE).toEqual({
      invoice: 'invoices',
      creditMemo: 'credit-memos',
      downPayment: 'down-payments',
    })
  })
  it('PAYMENT_EPS = 1e-6 theo spec', () => {
    expect(PAYMENT_EPS).toBe(1e-6)
  })
})
