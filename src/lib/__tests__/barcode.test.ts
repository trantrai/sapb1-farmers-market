// Mã vạch dòng hàng: chuẩn hóa trước khi lưu (chỉ lưu local, không đẩy SAP)
import { describe, expect, it } from 'vitest'
import { cleanBarcode } from '@/lib/order-calc'
import { buildSapLines } from '@/lib/sap-push-document'

describe('cleanBarcode', () => {
  it('trim, giữ chuỗi số dài, rỗng/không hợp lệ → null', () => {
    expect(cleanBarcode(' 8934563123456 ')).toBe('8934563123456')
    expect(cleanBarcode(8934563123456)).toBe('8934563123456')
    expect(cleanBarcode('')).toBeNull()
    expect(cleanBarcode('   ')).toBeNull()
    expect(cleanBarcode(null)).toBeNull()
    expect(cleanBarcode({})).toBeNull()
  })
  it('cắt tối đa 64 ký tự', () => {
    expect(cleanBarcode('x'.repeat(100))).toHaveLength(64)
  })
})

describe('payload SAP không gửi barcode', () => {
  it('buildSapLines bỏ qua barcode của dòng', () => {
    const [l] = buildSapLines([{ itemCode: 'A', quantity: 1, unitPrice: 1, barcode: '893' } as never]) as Record<string, unknown>[]
    expect(l).not.toHaveProperty('BarCode')
    expect(l).not.toHaveProperty('barcode')
  })
})
