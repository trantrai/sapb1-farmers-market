// Test gộp đơn SAP live + local cho dashboard — fixture tổng hợp, không chạm dữ liệu thật
import { describe, expect, it } from 'vitest'
import {
  mergeOrders,
  computeStats,
  computeRevenueByDay,
  computeTopCustomers,
  aggregateTopItems,
  type LocalOrderInput,
} from '../fm-dashboard-merge'
import type { SapOrderRow } from '../sap-orders'

function sapRow(partial: Partial<SapOrderRow>): SapOrderRow {
  return {
    id: 'sap-1',
    docNum: 100,
    cardCode: 'C001',
    cardName: 'Khách A',
    docDate: '2026-10-10',
    docDueDate: '2026-10-15',
    status: 'Open',
    remarks: null,
    totalBeforeDisc: 1000,
    discountAmt: 0,
    headerDiscPct: 0,
    headerDiscAmt: 0,
    vatAmt: 100,
    grandTotal: 1100,
    createdBy: 'SAP B1',
    sapDocEntry: 1,
    sapDocNum: 100,
    sapSyncStatus: 'synced',
    sapSyncedAt: null,
    source: 'sap',
    lines: [],
    ...partial,
  }
}

function localOrder(partial: Partial<LocalOrderInput>): LocalOrderInput {
  return {
    id: 'local-1',
    docNum: 1,
    cardCode: 'C002',
    cardName: 'Khách B',
    docDate: new Date(2026, 9, 12),
    docDueDate: new Date(2026, 9, 20),
    status: 'Open',
    grandTotal: 2200,
    sapSyncStatus: null,
    sapDocEntry: null,
    ...partial,
  }
}

describe('mergeOrders — khử trùng theo DocEntry', () => {
  it('giữ cả 2 khi không trùng', () => {
    const out = mergeOrders([sapRow({})], [localOrder({})])
    expect(out).toHaveLength(2)
    expect(out.map((o) => o.source).sort()).toEqual(['local', 'sap'])
  })

  it('bỏ bản local khi đã synced và SAP còn đơn đó (SAP thắng)', () => {
    const out = mergeOrders(
      [sapRow({ sapDocEntry: 7, docNum: 107 })],
      [localOrder({ sapSyncStatus: 'synced', sapDocEntry: 7, docNum: 5 })],
    )
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('sap')
    expect(out[0].docNum).toBe(107)
  })

  it('giữ bản local khi synced nhưng SAP không còn đơn đó', () => {
    const out = mergeOrders(
      [sapRow({ sapDocEntry: 8 })],
      [localOrder({ sapSyncStatus: 'synced', sapDocEntry: 7 })],
    )
    expect(out).toHaveLength(2)
  })

  it('giữ bản local chưa đẩy dù trùng DocEntry (trường hợp lệch)', () => {
    const out = mergeOrders(
      [sapRow({ sapDocEntry: 7 })],
      [localOrder({ sapSyncStatus: 'pending', sapDocEntry: 7 })],
    )
    expect(out).toHaveLength(2)
  })

  it('chuẩn hoá ngày Date → YYYY-MM-DD và Decimal-like → number', () => {
    const out = mergeOrders([], [localOrder({ grandTotal: { toString: () => '1234.5' } })])
    expect(out[0].docDate).toBe('2026-10-12')
    expect(out[0].docDueDate).toBe('2026-10-20')
    expect(out[0].grandTotal).toBe(1234.5)
  })
})

describe('computeStats', () => {
  const now = new Date(2026, 9, 16) // 16/10/2026
  const orders = mergeOrders(
    [
      sapRow({ id: 's1', docNum: 101, sapDocEntry: 11, status: 'Open', docDueDate: '2026-10-10', grandTotal: 1000 }), // quá hạn
      sapRow({ id: 's2', docNum: 102, sapDocEntry: 12, status: 'Closed', docDueDate: '2026-10-01', grandTotal: 2000 }),
      sapRow({ id: 's3', docNum: 103, sapDocEntry: 13, status: 'Open', docDueDate: '2026-10-18', grandTotal: 3000 }), // sắp đến hạn
    ],
    [localOrder({ id: 'l1', docNum: 1, status: 'Open', docDueDate: null, grandTotal: 400 })], // không hạn → không tính quá hạn
  )

  it('đếm đúng trên tập đã gộp', () => {
    const st = computeStats(orders, now)
    expect(st.totalOrders).toBe(4)
    expect(st.openOrders).toBe(3)
    expect(st.closedOrders).toBe(1)
    expect(st.overdueOrders).toBe(1)
    expect(st.revenueClosed).toBe(2000)
  })

  it('recent sắp xếp theo docNum giảm dần, attention theo hạn giao tăng dần', () => {
    const st = computeStats(orders, now)
    expect(st.recent.map((o) => o.docNum)).toEqual([103, 102, 101, 1])
    // attention: quá hạn (10/10) trước, sắp đến hạn (18/10) sau; đơn không hạn bị loại
    expect(st.attention.map((o) => o.docNum)).toEqual([101, 103])
  })
})

describe('computeRevenueByDay', () => {
  it('chia đúng bucket ngày, ngoài khoảng bị bỏ qua', () => {
    const orders = mergeOrders(
      [sapRow({ docDate: '2026-10-16', grandTotal: 1000 }), sapRow({ id: 's9', docNum: 109, sapDocEntry: 19, docDate: '2026-09-01', grandTotal: 9999 })],
      [],
    )
    const start = new Date(2026, 9, 10) // 10/10
    const days = computeRevenueByDay(orders, start, 7)
    expect(days).toHaveLength(7)
    expect(days[6]).toEqual({ day: '16/10', total: 1000 })
    expect(days.slice(0, 6).every((d) => d.total === 0)).toBe(true)
  })
})

describe('computeTopCustomers', () => {
  it('gộp theo cardCode, sắp xếp theo doanh số', () => {
    const orders = mergeOrders(
      [
        sapRow({ id: 's1', docNum: 101, sapDocEntry: 11, cardCode: 'C1', cardName: 'A', grandTotal: 500 }),
        sapRow({ id: 's2', docNum: 102, sapDocEntry: 12, cardCode: 'C1', cardName: 'A', grandTotal: 700 }),
      ],
      [localOrder({ cardCode: 'C2', cardName: 'B', grandTotal: 2000 })],
    )
    const top = computeTopCustomers(orders)
    expect(top[0]).toMatchObject({ cardCode: 'C2', total: 2000, orderCount: 1 })
    expect(top[1]).toMatchObject({ cardCode: 'C1', total: 1200, orderCount: 2 })
  })
})

describe('aggregateTopItems', () => {
  it('gộp theo itemCode, sắp xếp theo số lượng', () => {
    const top = aggregateTopItems([
      { itemCode: 'I1', itemName: 'Hàng 1', quantity: 10, total: 100 },
      { itemCode: 'I1', itemName: 'Hàng 1', quantity: '5', total: '50' },
      { itemCode: 'I2', itemName: 'Hàng 2', quantity: 20, total: 40 },
    ])
    expect(top[0]).toMatchObject({ itemCode: 'I2', quantity: 20 })
    expect(top[1]).toMatchObject({ itemCode: 'I1', quantity: 15, total: 150 })
  })

  it('bỏ qua dòng không có itemCode', () => {
    expect(aggregateTopItems([{ itemCode: '', itemName: 'x', quantity: 9, total: 9 }])).toEqual([])
  })
})
