import { describe, expect, it } from 'vitest'
import { aggregateBasket, type BasketSourceOrder } from '@/lib/order-basket'

const line = (itemCode: string, quantity: number, extra: Partial<BasketSourceOrder['lines'][number]> = {}) =>
  ({ itemCode, itemName: `Tên ${itemCode}`, quantity, unitPrice: 100, ...extra })

describe('aggregateBasket', () => {
  const orders: BasketSourceOrder[] = [
    { docDate: '2026-10-20', lines: [line('A', 5, { unitPrice: 120 }), line('A', 1), line('B', 2), line('K1', 3, { isBomChild: true })] },
    { docDate: '2026-10-10', lines: [line('A', 2), line('C', 10)] },
    { docDate: '2026-10-01', lines: [line('A', 3), line('B', 4), line('Z', 0)] },
  ]

  it('gom theo mặt hàng: số đơn, tổng SL, SL TB, SL & giá lần gần nhất', () => {
    const r = aggregateBasket(orders, 10)
    expect(r.map((x) => x.itemCode)).toEqual(['A', 'B', 'C'])
    expect(r[0]).toMatchObject({ orderCount: 3, totalQty: 11, avgQty: 3.667, lastQty: 6, lastPrice: 120 })
    expect(r[0].lastDate.slice(0, 10)).toBe('2026-10-20')
    expect(r[1]).toMatchObject({ orderCount: 2, totalQty: 6, avgQty: 3, lastQty: 2 })
  })

  it('bỏ dòng con BOM và dòng SL ≤ 0; giới hạn số mặt hàng', () => {
    const r = aggregateBasket(orders, 2)
    expect(r.map((x) => x.itemCode)).toEqual(['A', 'B'])
    expect(aggregateBasket(orders, 10).some((x) => x.itemCode === 'K1' || x.itemCode === 'Z')).toBe(false)
  })
})
