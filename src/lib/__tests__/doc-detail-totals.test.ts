// Tổng chứng từ suy từ dòng cho màn chi tiết (phiếu giao hàng lưu grandTotal trước thuế)
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/fm-client', () => ({ api: vi.fn() }))

import { computeDocTotals } from '@/components/fm/doc-detail-sections'

describe('computeDocTotals', () => {
  const lines = [
    { itemCode: 'A', itemName: 'A', quantity: 2, unitPrice: 100000, discPct: 10, vatPct: 8 },
    { itemCode: 'B', itemName: 'B', quantity: 1, unitPrice: 50000, vatPct: null },
  ]

  it('trước CK, CK dòng, thuế theo thuế suất dòng, tổng sau thuế', () => {
    expect(computeDocTotals(lines)).toEqual({
      totalBeforeDisc: 250000, discountAmt: 20000, headerDiscPct: 0, headerDiscAmt: 0, vatAmt: 14400, grandTotal: 244400,
    })
  })

  it('CK đầu chứng từ giảm cả tiền hàng và tiền thuế; grandTotal truyền vào được giữ nguyên', () => {
    const t = computeDocTotals(lines, 10)
    expect(t).toMatchObject({ headerDiscAmt: 23000, vatAmt: 12960, grandTotal: 230000 - 23000 + 12960 })
    expect(computeDocTotals(lines, 0, 999).grandTotal).toBe(999)
  })
})
