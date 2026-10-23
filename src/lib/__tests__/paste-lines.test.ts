import { describe, expect, it } from 'vitest'
import { looksLikeLineList, parsePastedLines } from '@/lib/paste-lines'

const kq = (text: string) => parsePastedLines(text).map((l) => [l.key, l.quantity])

describe('parsePastedLines', () => {
  it('mã + SL (khoảng trắng / tab / cột Excel)', () => {
    expect(kq('FM-RAU-002  10\nFM-TRA-001\t3')).toEqual([['FM-RAU-002', 10], ['FM-TRA-001', 3]])
    expect(kq('FM-RAU-002\tCà chua bi\t10')).toEqual([['FM-RAU-002', 10]])
  })

  it('barcode với x5 / 5 x / x5 phía trước — barcode không bị hiểu là SL', () => {
    expect(kq('8934563100021 x5')).toEqual([['8934563100021', 5]])
    expect(kq('5 x 8934563100021')).toEqual([['8934563100021', 5]])
    expect(kq('8934563100021')).toEqual([['8934563100021', 1]])
  })

  it('tên hàng + SL kèm đơn vị, số thập phân dấu phẩy', () => {
    expect(kq('cà chua bi 10kg')).toEqual([['cà chua bi', 10]])
    expect(kq('Cà rốt: 2,5 kg')).toEqual([['Cà rốt', 2.5]])
    expect(kq('rau cải 2.5')).toEqual([['rau cải', 2.5]])
  })

  it('gạch đầu dòng, đánh số, dấu ; |', () => {
    expect(kq('- FM-RAU-002 ; 3\n1. FM-TRA-001 | 4\n• FM-RAU-003 2')).toEqual([
      ['FM-RAU-002', 3], ['FM-TRA-001', 4], ['FM-RAU-003', 2],
    ])
  })

  it('nhóm nghìn: 1.000 → 1000', () => {
    expect(kq('FM-RAU-002 1.000')).toEqual([['FM-RAU-002', 1000]])
  })

  it('bỏ dòng trống + dòng tiêu đề Excel; không có số → SL 1 (đánh dấu)', () => {
    const r = parsePastedLines('Mã hàng\tTên hàng\tSL\n\nFM-RAU-002\n')
    expect(r).toEqual([{ raw: 'FM-RAU-002', key: 'FM-RAU-002', quantity: 1, qtyDefaulted: true }])
  })

  it('giới hạn số dòng', () => {
    expect(parsePastedLines(Array.from({ length: 300 }, (_, i) => `M${i} 1`).join('\n'), 50)).toHaveLength(50)
  })
})

describe('looksLikeLineList', () => {
  it('≥ 2 dòng hoặc có tab → danh sách; 1 mã đơn lẻ → không', () => {
    expect(looksLikeLineList('A 1\nB 2')).toBe(true)
    expect(looksLikeLineList('A\t1')).toBe(true)
    expect(looksLikeLineList('FM-RAU-002')).toBe(false)
  })
})

// ---- Tra key → mặt hàng (route /api/items/resolve, phần thuần) ----
import { resolveKey } from '@/lib/item-resolve'
const CAT = [
  { itemCode: 'FM-RAU-002', itemName: 'Cà chua bi Đà Lạt', uom: 'kg', price: 45000, taxCode: 'S8', barcode: '8934563100021' },
  { itemCode: 'FM-RAU-005', itemName: 'Cà chua thường', uom: 'kg', price: 20000, taxCode: 'S8', barcode: '' },
  { itemCode: 'FM-TRA-001', itemName: 'Trứng gà ta lò', uom: 'hộp', price: 58000, taxCode: 'S8', barcode: '8934563100014' },
]
describe('resolveKey', () => {
  it('mã hàng chính xác (không phân biệt hoa thường) → matched code', () => {
    expect(resolveKey('fm-rau-002', CAT)).toMatchObject({ status: 'matched', matchedBy: 'code', item: { itemCode: 'FM-RAU-002' } })
  })
  it('barcode chính xác → matched barcode', () => {
    expect(resolveKey('8934563100014', CAT)).toMatchObject({ status: 'matched', matchedBy: 'barcode', item: { itemCode: 'FM-TRA-001' } })
  })
  it('tên không dấu, đủ từ → matched name', () => {
    expect(resolveKey('trung ga', CAT)).toMatchObject({ status: 'matched', matchedBy: 'name', item: { itemCode: 'FM-TRA-001' } })
    expect(resolveKey('ca chua bi', CAT)).toMatchObject({ status: 'matched', item: { itemCode: 'FM-RAU-002' } })
  })
  it('nhiều mặt hàng khớp tên → ambiguous kèm ứng viên', () => {
    const r = resolveKey('cà chua', CAT)
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') expect(r.candidates.map((c) => c.itemCode)).toEqual(['FM-RAU-005', 'FM-RAU-002']) // cùng điểm → tên ngắn trước
  })
  it('xếp ứng viên: trùng nguyên từ trước, khớp giữa từ sau ("cà" → Cà chua trước Cam)', () => {
    const r = resolveKey('cà', [...CAT, { itemCode: 'FM-QUA-002', itemName: 'Cam sành', uom: 'kg', price: 1, taxCode: '', barcode: '' }])
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') expect(r.candidates.map((c) => c.itemCode)).toEqual(['FM-RAU-005', 'FM-RAU-002', 'FM-QUA-002'])
  })
  it('không khớp → notfound', () => {
    expect(resolveKey('xoài cát', CAT).status).toBe('notfound')
  })
})
