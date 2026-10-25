// ============================================================
// Sửa chứng từ có dòng đã sao chép sang chứng từ khác (kể cả con BOM Template):
// giữ id dòng (liên kết dòng gốc), chặn xóa/đổi mã/giảm dưới SL đã sao chép.
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => {
  const fm = () => vi.fn().mockResolvedValue([])
  return {
    deliveryLine: { findMany: fm() },
    salesOrderLine: { findMany: fm() },
    arInvoiceLine: { findMany: fm() },
    arCreditMemoLine: { findMany: fm() },
    salesReturnLine: { findMany: fm() },
    arDownPaymentLine: { findMany: fm() },
  }
})
vi.mock('@/lib/db', () => ({ db: m }))

import { checkCopiedLineEdits, copiedLinesOf, keptLineIds } from '@/lib/copied-lines'

const old = [
  { id: 'p', itemCode: 'GIO', quantity: 2 },
  { id: 'c1', itemCode: 'A', quantity: 6 },
  { id: 'x', itemCode: 'RAU', quantity: 1 },
]
const copied = new Map([
  ['p', { qty: 1, docs: ['phiếu giao hàng #5'] }],
  ['c1', { qty: 3, docs: ['phiếu giao hàng #5'] }],
])

describe('checkCopiedLineEdits', () => {
  it('cho phép sửa dòng chưa sao chép và tăng SL dòng đã sao chép', () => {
    expect(checkCopiedLineEdits(old, [
      { dbId: 'p', itemCode: 'GIO', quantity: 3 },
      { dbId: 'c1', itemCode: 'A', quantity: 9 },
    ], copied)).toBeNull()
  })

  it('chặn xóa dòng con BOM Template đã giao', () => {
    expect(checkCopiedLineEdits(old, [{ dbId: 'p', itemCode: 'GIO', quantity: 2 }], copied)).toMatch(/A đã được sao chép sang phiếu giao hàng #5 — không thể xóa/)
  })

  it('chặn đổi mã hàng và giảm SL dưới SL đã sao chép', () => {
    expect(checkCopiedLineEdits(old, [
      { dbId: 'p', itemCode: 'GIO2', quantity: 2 }, { dbId: 'c1', itemCode: 'A', quantity: 6 },
    ], copied)).toMatch(/không thể đổi mã hàng/)
    expect(checkCopiedLineEdits(old, [
      { dbId: 'p', itemCode: 'GIO', quantity: 2 }, { dbId: 'c1', itemCode: 'A', quantity: 2.5 },
    ], copied)).toMatch(/không được nhỏ hơn số lượng đã sao chép \(3\)/)
  })

  it('đã sao chép vượt SL dòng (dữ liệu cũ) → giữ nguyên SL vẫn hợp lệ, giảm thì chặn', () => {
    const over = new Map([['x', { qty: 3, docs: ['hóa đơn bán hàng #1'] }]])
    const keep = [{ dbId: 'p', itemCode: 'GIO', quantity: 2 }, { dbId: 'c1', itemCode: 'A', quantity: 6 }]
    expect(checkCopiedLineEdits(old, [...keep, { dbId: 'x', itemCode: 'RAU', quantity: 1 }], over)).toBeNull()
    expect(checkCopiedLineEdits(old, [...keep, { dbId: 'x', itemCode: 'RAU', quantity: 0.5 }], over)).toMatch(/\(1\)/)
  })

  it('dòng gửi lên không có dbId (bị tạo lại) → coi như đã xóa dòng cũ', () => {
    expect(checkCopiedLineEdits(old, [
      { itemCode: 'GIO', quantity: 2 }, { dbId: 'c1', itemCode: 'A', quantity: 6 },
    ], copied)).toMatch(/GIO .*không thể xóa/)
  })
})

describe('keptLineIds', () => {
  it('chỉ giữ dbId thuộc chứng từ, không trùng', () => {
    expect(keptLineIds(['p', 'c1'], [{ dbId: 'p' }, { dbId: 'zz' }, { dbId: 'p' }, {}, { dbId: 'c1' }]))
      .toEqual(['p', undefined, undefined, undefined, 'c1'])
  })
})

describe('copiedLinesOf', () => {
  beforeEach(() => { for (const t of Object.values(m)) t.findMany.mockReset().mockResolvedValue([]) })

  it('cộng SL giao + hóa đơn, bỏ chứng từ hủy (lọc ở query), đặt cọc không trừ SL', async () => {
    m.deliveryLine.findMany.mockResolvedValue([
      { sourceOrderLineId: 'c1', sourceQuotationLineId: null, quantity: 2, delivery: { docNum: 5 } },
      { sourceOrderLineId: 'c1', sourceQuotationLineId: null, quantity: 1, delivery: { docNum: 6 } },
    ])
    m.arInvoiceLine.findMany.mockResolvedValue([{ sourceLineId: 'p', quantity: 1, invoice: { docNum: 9 } }])
    m.arDownPaymentLine.findMany.mockResolvedValue([{ sourceLineId: 'p', quantity: 2, downPayment: { docNum: 3 } }])
    const r = await copiedLinesOf(['p', 'c1', 'p'])
    expect(r.get('c1')).toEqual({ qty: 3, docs: ['phiếu giao hàng #5', 'phiếu giao hàng #6'] })
    expect(r.get('p')).toEqual({ qty: 1, docs: ['hóa đơn bán hàng #9', 'hóa đơn đặt cọc #3'] })
    const w = m.deliveryLine.findMany.mock.calls[0][0].where
    expect(w.delivery).toEqual({ status: { not: 'Cancelled' } })
    expect(m.arInvoiceLine.findMany.mock.calls[0][0].where.invoice).toEqual({ status: { not: 'Cancelled' } })
  })

  it('không có id → không truy vấn', async () => {
    expect((await copiedLinesOf([])).size).toBe(0)
    expect(m.deliveryLine.findMany).not.toHaveBeenCalled()
  })
})
