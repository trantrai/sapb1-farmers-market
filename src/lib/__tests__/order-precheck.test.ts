import { describe, expect, it } from 'vitest'
import { precheckOrder, type PrecheckInput } from '@/lib/order-precheck'

const base: PrecheckInput = {
  hasPartner: true,
  docDate: '2026-10-23',
  docDueDate: '2026-10-28', // thứ Tư
  today: '2026-10-23',
  lines: [{ key: 1, itemCode: 'A', quantity: 2, unitPrice: 100, refPrice: 100, priceSource: 'pricelist', atpAvailable: 10 }],
}
const codes = (i: PrecheckInput) => precheckOrder(i).map((x) => `${x.level}:${x.code}`)

describe('precheckOrder', () => {
  it('đơn hợp lệ → không có vấn đề', () => {
    expect(precheckOrder(base)).toEqual([])
  })

  it('lỗi bắt buộc sửa: chưa chọn KH, không dòng, SL ≤ 0, giá âm, ngày giao trước ngày chứng từ', () => {
    expect(codes({ ...base, hasPartner: false, lines: [] })).toEqual(['error:no-partner', 'error:no-lines'])
    expect(codes({ ...base, lines: [{ key: 1, itemCode: 'A', quantity: 0, unitPrice: 1 }, { key: 2, itemCode: 'B', quantity: 1, unitPrice: -5 }] }))
      .toEqual(['error:qty', 'error:neg-price'])
    expect(codes({ ...base, docDueDate: '2026-10-20' })).toEqual(['error:due-before-doc'])
  })

  it('cảnh báo thiếu hàng ATP (chưa kiểm tra được → bỏ qua)', () => {
    const r = precheckOrder({ ...base, lines: [{ ...base.lines[0], quantity: 12, warehouseCode: '01' }] })
    expect(r).toEqual([expect.objectContaining({ level: 'warning', code: 'atp', lineKey: 1 })])
    expect(r[0].message).toMatch(/đặt 12, khả dụng 10 \(kho 01\)/)
    expect(codes({ ...base, lines: [{ ...base.lines[0], quantity: 99, atpAvailable: null }] })).toEqual([])
  })

  it('cảnh báo giá thấp hơn giá đặc biệt / bảng giá (dòng con BOM giá 0 không tính)', () => {
    const r = precheckOrder({ ...base, lines: [{ ...base.lines[0], unitPrice: 80, refPrice: 100, priceSource: 'special' }] })
    expect(r[0]).toMatchObject({ code: 'below-price' })
    expect(r[0].message).toMatch(/giá đặc biệt của KH .*−20%/)
    expect(codes({ ...base, lines: [{ key: 9, itemCode: 'C', quantity: 1, unitPrice: 0, refPrice: 50, isBomChild: true }] })).toEqual([])
    expect(codes({ ...base, lines: [{ ...base.lines[0], unitPrice: 120 }] })).toEqual([])
  })

  it('cảnh báo trùng mặt hàng cùng kho (khác kho thì không)', () => {
    const l = base.lines[0]
    expect(codes({ ...base, lines: [l, { ...l, key: 2 }] })).toEqual(['warning:duplicate'])
    expect(codes({ ...base, lines: [{ ...l, warehouseCode: '01' }, { ...l, key: 2, warehouseCode: '02' }] })).toEqual([])
  })

  it('ngày giao đã qua / rơi vào Chủ nhật', () => {
    expect(codes({ ...base, docDate: '2026-10-01', docDueDate: '2026-10-20' })).toEqual(['warning:due-past'])
    expect(codes({ ...base, docDueDate: '2026-10-25' })).toEqual(['warning:due-sunday'])
  })

  it('lỗi luôn xếp trước cảnh báo', () => {
    const r = codes({ ...base, docDueDate: '2026-10-25', lines: [{ key: 1, itemCode: 'A', quantity: 0, unitPrice: 1 }] })
    expect(r).toEqual(['error:qty', 'warning:due-sunday'])
  })
})

describe('precheckOrder — lịch sử khách (insights)', () => {
  const stat = (o: Partial<import('@/lib/order-precheck').ItemHistoryStat> = {}) => ({
    samples: 5, medianQty: 10, uom: 'kg', lastPrice: 100, lastDate: '2026-10-20', ...o,
  })
  const line = { key: 1, itemCode: 'A', quantity: 10, unitPrice: 100, uom: 'kg', atpAvailable: 999 }
  const withIns = (items: Record<string, ReturnType<typeof stat>>, duplicates: import('@/lib/order-precheck').DuplicateOrderHit[] = [], l = line) =>
    precheckOrder({ ...base, lines: [l], insights: { duplicates, items } })

  it('mọi kết quả có key ổn định', () => {
    for (const i of precheckOrder({ ...base, hasPartner: false, lines: [] })) expect(i.key).toBeTruthy()
  })

  it('đơn trùng → cảnh báo kèm orderId; khóa đổi theo ngày giao', () => {
    const r = withIns({}, [{ id: 'o1', docNum: 1052, isDraft: false, overlap: 8, total: 9 }])
    expect(r).toEqual([expect.objectContaining({ code: 'dup-order', orderId: 'o1', key: 'dup-order:o1:2026-10-28' })])
    expect(r[0].message).toMatch(/#1052.*trùng 8\/9/)
    const empty = withIns({}, [{ id: 'o2', docNum: null, isDraft: true, overlap: 0, total: 0 }])
    expect(empty[0].message).toMatch(/đơn nháp/)
    expect(empty[0].message).not.toMatch(/trùng/)
  })

  it('SL bất thường: ≥3 lần trung vị hoặc ≤1/3; cần đủ mẫu, cùng đơn vị', () => {
    const codesOf = (r: ReturnType<typeof withIns>) => r.map((x) => x.code)
    expect(codesOf(withIns({ A: stat() }, [], { ...line, quantity: 30 }))).toEqual(['qty-anomaly'])
    expect(codesOf(withIns({ A: stat() }, [], { ...line, quantity: 3 }))).toEqual(['qty-anomaly'])
    expect(codesOf(withIns({ A: stat() }, [], { ...line, quantity: 25 }))).toEqual([])
    expect(codesOf(withIns({ A: stat({ samples: 2 }) }, [], { ...line, quantity: 100 }))).toEqual([])
    expect(codesOf(withIns({ A: stat({ uom: 'thùng' }) }, [], { ...line, quantity: 100 }))).toEqual([])
    const r = withIns({ A: stat() }, [], { ...line, quantity: 100 })
    expect(r[0].message).toMatch(/thường đặt ~10 kg/)
    expect(r[0].key).toBe('qty-anomaly:1:100')
  })

  it('giá lệch >10% so với lần bán trước (tăng hoặc giảm); bỏ qua dòng con BOM', () => {
    expect(withIns({ A: stat() }, [], { ...line, unitPrice: 111 }).map((x) => x.code)).toEqual(['price-change'])
    expect(withIns({ A: stat() }, [], { ...line, unitPrice: 85 })[0].message).toMatch(/−15%.*20\/10\/2026/)
    expect(withIns({ A: stat() }, [], { ...line, unitPrice: 109 })).toEqual([])
    expect(withIns({ A: stat({ lastPrice: null }) }, [], { ...line, unitPrice: 500 })).toEqual([])
    expect(withIns({ A: stat() }, [], { ...line, unitPrice: 0, isBomChild: true, quantity: 99 } as typeof line)).toEqual([])
  })
})
