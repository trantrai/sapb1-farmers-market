// ============================================================
// Lịch sử khách cho vùng Kiểm tra đơn: thống kê SL/giá + đơn trùng
// ============================================================
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

import { computeItemStats, findDuplicateOrders } from '@/lib/order-insights'

const d = (s: string) => new Date(`${s}T00:00:00Z`)

describe('computeItemStats', () => {
  it('trung vị SL theo đơn (gộp nhiều dòng cùng mã), giá lần gần nhất > 0', () => {
    const r = computeItemStats([
      { docDate: d('2026-10-20'), lines: [{ itemCode: 'A', quantity: 4, unitPrice: 0, uom: 'kg' }, { itemCode: 'A', quantity: 6, unitPrice: 0, uom: 'kg' }] },
      { docDate: d('2026-10-15'), lines: [{ itemCode: 'A', quantity: 20, unitPrice: 120, uom: 'kg' }, { itemCode: 'X', quantity: 1, unitPrice: 1, uom: null }] },
      { docDate: d('2026-10-10'), lines: [{ itemCode: 'A', quantity: 12, unitPrice: 110, uom: 'kg' }] },
    ], ['A', 'B'])
    expect(Object.keys(r)).toEqual(['A'])
    expect(r.A).toEqual({ samples: 3, medianQty: 12, uom: 'kg', lastPrice: 120, lastDate: '2026-10-15' })
  })

  it('số mẫu chẵn → trung bình 2 giá trị giữa', () => {
    const r = computeItemStats([
      { docDate: d('2026-10-02'), lines: [{ itemCode: 'A', quantity: 10, unitPrice: 5, uom: 'kg' }] },
      { docDate: d('2026-10-01'), lines: [{ itemCode: 'A', quantity: 20, unitPrice: 5, uom: 'kg' }] },
    ], ['A'])
    expect(r.A.medianQty).toBe(15)
  })
})

describe('findDuplicateOrders', () => {
  const c = (id: string, codes: string[]) => ({ id, docNum: 1, isDraft: false, lines: codes.map((itemCode) => ({ itemCode })) })

  it('đơn đang nhập chưa có mặt hàng → báo mọi đơn cùng khách + ngày giao', () => {
    expect(findDuplicateOrders([c('a', ['A'])], [])).toEqual([{ id: 'a', docNum: 1, isDraft: false, overlap: 0, total: 0 }])
  })

  it('trùng ≥60% so với đơn nhiều mặt hàng hơn; sắp xếp tỷ lệ giảm dần', () => {
    const r = findDuplicateOrders([
      c('low', ['A', 'X', 'Y', 'Z']), // 1/4
      c('mid', ['A', 'B', 'C', 'Q', 'R']), // 3/5
      c('high', ['A', 'B', 'C']), // 3/3
    ], ['A', 'B', 'C'])
    expect(r.map((h) => h.id)).toEqual(['high', 'mid'])
    expect(r[1]).toMatchObject({ overlap: 3, total: 5 })
  })

  it('1 mặt hàng trùng trong đơn 10 mặt hàng → không báo', () => {
    expect(findDuplicateOrders([c('big', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])], ['A'])).toEqual([])
  })
})
