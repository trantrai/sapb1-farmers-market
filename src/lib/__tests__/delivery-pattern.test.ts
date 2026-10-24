import { describe, expect, it } from 'vitest'
import { deliveryPattern, suggestDueDate } from '@/lib/delivery-pattern'

// 2026-10-20 = T3, 2026-10-23 = T6, 2026-10-25 = CN
const o = (docDate: string, docDueDate: string, warehouseCode: string | null = '01') => ({ docDate, docDueDate, warehouseCode })

describe('deliveryPattern', () => {
  it('suy thứ hay giao, số ngày giao sau đặt (trung vị), kho chiếm đa số', () => {
    const p = deliveryPattern([
      o('2026-10-19', '2026-10-20'), // T3, +1
      o('2026-10-22', '2026-10-23'), // T6, +1
      o('2026-10-12', '2026-10-13'), // T3, +1
      o('2026-10-15', '2026-10-17', '02'), // T7, +2
      o('2026-10-08', '2026-10-09'), // T6, +1
    ])
    expect(p).toEqual({ sample: 5, weekdays: [2, 5], leadDays: 1, warehouseCode: '01' })
  })

  it('ít đơn → null; kho không chiếm đa số → null', () => {
    expect(deliveryPattern([o('2026-10-19', '2026-10-20')])).toBeNull()
    const p = deliveryPattern([o('2026-10-19', '2026-10-20', '01'), o('2026-10-12', '2026-10-13', '02'), o('2026-10-05', '2026-10-06', null)])
    expect(p?.warehouseCode).toBeNull()
  })
})

describe('suggestDueDate', () => {
  const p = { sample: 5, weekdays: [2, 5], leadDays: 1, warehouseCode: '01' }
  it('ngày sớm nhất sau lead time rơi vào thứ hay giao', () => {
    expect(suggestDueDate('2026-10-24', p)).toBe('2026-10-27') // T7 +1 = CN → T3
    expect(suggestDueDate('2026-10-19', p)).toBe('2026-10-20') // T2 +1 = T3
    expect(suggestDueDate('2026-10-20', p)).toBe('2026-10-23') // T3 +1 = T4 → T6
  })
  it('không có thứ nổi bật → chỉ tránh Chủ nhật', () => {
    expect(suggestDueDate('2026-10-24', { ...p, weekdays: [] })).toBe('2026-10-26')
  })
})
