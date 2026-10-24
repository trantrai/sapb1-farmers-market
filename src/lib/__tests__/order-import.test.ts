import { describe, expect, it } from 'vitest'
import { matchImportRows, nameSimilarity, parseExcelNum, parseImportRows, type ImportItem } from '@/lib/order-import'

describe('parseExcelNum', () => {
  it('handles vi / en formats, blank and junk', () => {
    expect(parseExcelNum('1.234,5')).toBe(1234.5)
    expect(parseExcelNum('1,234.5')).toBe(1234.5)
    expect(parseExcelNum('1,5')).toBe(1.5)
    expect(parseExcelNum('  ')).toBeNull()
    expect(parseExcelNum('abc')).toBeNaN()
  })
})

describe('parseImportRows', () => {
  const mapping = { 'Mã hàng': 'itemCode', 'Tên hàng': 'itemName', 'SL': 'quantity', 'Giá': 'unitPrice', 'CK': 'discPct' }
  it('parses valid rows, reports bad ones with excel row numbers, skips blank rows', () => {
    const { parsed, errors } = parseImportRows([
      { 'Mã hàng': 'A1', 'Tên hàng': '', SL: '2', Giá: '', CK: '' },
      { 'Mã hàng': '', 'Tên hàng': 'Rau muống', SL: '1,5', Giá: '12000', CK: '5' },
      { 'Mã hàng': 'A2', 'Tên hàng': '', SL: '0', Giá: '', CK: '' },
      { 'Mã hàng': 'A3', 'Tên hàng': '', SL: '1', Giá: '', CK: '120' },
      { 'Mã hàng': '', 'Tên hàng': '', SL: '', Giá: '', CK: '' },
      { 'Mã hàng': '', 'Tên hàng': '', SL: '3', Giá: '', CK: '' },
    ], mapping)
    expect(parsed.map((p) => p.excelRow)).toEqual([2, 3])
    expect(parsed[0]).toMatchObject({ code: 'A1', quantity: 2, unitPrice: null, discPct: null })
    expect(parsed[1]).toMatchObject({ code: '', name: 'Rau muống', quantity: 1.5, unitPrice: 12000, discPct: 5 })
    expect(errors.map((e) => [e.excelRow, e.message])).toEqual([
      [4, 'Số lượng phải > 0'],
      [5, 'Chiết khấu % phải từ 0 đến 100'],
      [7, 'Thiếu mã hàng và tên hàng'],
    ])
  })
})

describe('matchImportRows', () => {
  const catalog: ImportItem[] = [
    { itemCode: 'FM-RAU-001', itemName: 'Rau muống', barcode: '8930001' },
    { itemCode: 'FM-RAU-002', itemName: 'Cải ngọt', barcode: '8930002' },
    { itemCode: 'FM-RAU-003', itemName: 'Cải thìa', barcode: '' },
    { itemCode: 'FM-CU-001', itemName: 'Cà rốt Đà Lạt', barcode: '8930009' },
    { itemCode: 'X-1', itemName: 'Hàng A', barcode: 'DUP' },
    { itemCode: 'X-2', itemName: 'Hàng B', barcode: 'DUP' },
  ]
  it('matches by code (case-insensitive), then barcode', () => {
    const [a, b] = matchImportRows([{ code: 'fm-rau-002', name: '' }, { code: '8930009', name: '' }], catalog)
    expect(a).toMatchObject({ kind: 'code', item: { itemCode: 'FM-RAU-002' }, nameMismatch: false })
    expect(b).toMatchObject({ kind: 'barcode', item: { itemCode: 'FM-CU-001' } })
  })
  it('ambiguous barcode is not matched', () => {
    expect(matchImportRows([{ code: 'DUP', name: '' }], catalog)[0].kind).toBe('none')
  })
  it('flags code match whose file name differs a lot', () => {
    expect(matchImportRows([{ code: 'FM-RAU-001', name: 'Cà rốt' }], catalog)[0].nameMismatch).toBe(true)
    expect(matchImportRows([{ code: 'FM-RAU-001', name: 'rau muong' }], catalog)[0].nameMismatch).toBe(false)
  })
  it('falls back to fuzzy name, ignoring diacritics; auto-picks only a clear winner', () => {
    const [exact] = matchImportRows([{ code: 'UNKNOWN', name: 'ca rot da lat' }], catalog)
    expect(exact.kind).toBe('name')
    expect(exact.item?.itemCode).toBe('FM-CU-001')
    const [close] = matchImportRows([{ code: '', name: 'Cải' }], catalog)
    expect(close.kind).toBe('name')
    expect(close.item).toBeNull()
    expect(close.candidates.map((c) => c.item.itemCode)).toEqual(expect.arrayContaining(['FM-RAU-002', 'FM-RAU-003']))
  })
  it('none when nothing similar', () => {
    expect(matchImportRows([{ code: '', name: 'Thịt bò' }], catalog)[0]).toMatchObject({ kind: 'none', item: null, candidates: [] })
  })
  it('similarity basics', () => {
    expect(nameSimilarity('Rau Muống', 'rau muong')).toBe(1)
    expect(nameSimilarity('', 'x')).toBe(0)
  })
})
