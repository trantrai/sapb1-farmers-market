// Test parser MD_05 2-pass (F1, T1–T8) — trên fixture tổng hợp
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  parseMd05Workbook,
  parseMd05FromBuffer,
  parseBarcode,
  detectBomKind,
  parseNumber,
  normText,
} from '../parser-md05'
import { buildMd05Fixture } from './fixtures'

describe('parseMd05Workbook — nhận diện cấu trúc', () => {
  it('parse đúng 2 cha, 6 dòng con (2-pass values + formulas)', () => {
    const { parents, sheetUsed, dataRows } = parseMd05Workbook(buildMd05Fixture())
    expect(sheetUsed).toBe('Template IT up hệ thống')
    expect(dataRows).toBe(7)
    expect(parents).toHaveLength(2)
    expect(parents[0].components).toHaveLength(4)
    expect(parents[1].components).toHaveLength(2)
  })

  it('T8: dòng cha kiêm con đầu tiên → component sortOrder=0, rowNo của dòng cha', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    const first = parents[0].components[0]
    expect(first.sortOrder).toBe(0)
    expect(first.rowNo).toBe(7)
    expect(first.childCode).toBe('I0000001')
    // các con sau tăng dần
    expect(parents[0].components.map((c) => c.sortOrder)).toEqual([0, 1, 2, 3])
  })

  it('không có dòng cha → parents rỗng (validator V1 sẽ chặn)', () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['H1'], ['H2'], ['H3'], ['H4'], ['H5'], ['H6'], ['', '', '', '', '']])
    XLSX.utils.book_append_sheet(wb, ws, 'Template IT up hệ thống')
    const { parents } = parseMd05Workbook(wb)
    expect(parents).toHaveLength(0)
  })

  it('round-trip qua buffer vẫn giữ công thức (pass 2)', () => {
    const buf = XLSX.write(buildMd05Fixture(), { type: 'buffer', bookType: 'xlsx' })
    const { parents } = parseMd05FromBuffer(buf)
    expect(parents).toHaveLength(2)
    expect(parents[0].formulas?.q).toBe('R7/1.05')
    expect(parents[0].formulas?.r).toBe('T7')
  })

  it('dòng header trống (blankrows:false loại bỏ) → vẫn parse đủ 2 cha (regression: từng mất cha đầu)', () => {
    // Mô phỏng file thật: trong 6 dòng đầu có dòng hoàn toàn trống;
    // sheet_to_json blankrows:false loại bỏ nó nên dữ liệu bắt đầu ở index 5,
    // không phải 6 như hằng số HEADER_ROWS cũ (bug: chỉ parse được cha sau cùng).
    const wb = buildMd05Fixture()
    const ws = wb.Sheets['Template IT up hệ thống']
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][]
    // rows[0..5] = 6 dòng header, rows[6] = cha 1
    rows[1] = [] // dòng header trống → sẽ bị loại bỏ khi parse
    const lastHeader = [...(rows[5] as unknown[])]
    lastHeader[4] = 'Item name' // template thật: ô E dòng header cột = "Item name"
    rows[5] = lastHeader
    const ws2 = XLSX.utils.aoa_to_sheet(rows)
    const wb2 = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb2, ws2, 'Template IT up hệ thống')
    const { parents } = parseMd05Workbook(wb2)
    expect(parents).toHaveLength(2)
    expect(parents[0].itemName).toBe('PHẦN QUÀ TEST 01')
    expect(parents[1].itemName).toBe('COMBO QUÀ TEST 02')
    expect(parents[0].components).toHaveLength(4)
    // rowNo = số dòng Excel thật (giữ dòng trống): cha 1 ở dòng 7
    expect(parents[0].rowNo).toBe(7)
    expect(parents[0].components[0].rowNo).toBe(7) // T8: con đầu ở dòng cha
  })
})

describe('T1 — chuẩn hóa text', () => {
  it('trim + NFC: "Kg " → "Kg"', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    expect(parents[0].components[0].uom).toBe('Kg')
  })
  it('normText: null/undefined/blank → null', () => {
    expect(normText(null)).toBeNull()
    expect(normText('   ')).toBeNull()
    expect(normText(' Hộp ')).toBe('Hộp')
  })
})

describe('T2 — chuẩn hóa định mức', () => {
  it('qtyPerParent = X / batchQty, làm tròn 6 decimals', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture(), { batchQtyDefault: 3 })
    // X=2, batch=3 → 0.666667
    expect(parents[0].components[0].qtyPerParent).toBe(0.666667)
  })
  it('mặc định batchQty=1 → giữ nguyên X', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    expect(parents[1].components[1].qtyPerParent).toBe(0.02)
  })
})

describe('T3 — giá trước VAT', () => {
  it('S2 (5%): T=105000 → 100000', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    expect(parents[0].priceExVat).toBe(100000)
  })
  it('S4 (8%): T=108000 → 100000', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    expect(parents[1].priceExVat).toBe(100000)
  })
})

describe('T5 — barcode 3 loại (positional theo header file)', () => {
  it('3 dòng → trade/internal8/internalI đúng slot; trade làm chính (Q2a)', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    const b = parents[0].barcode
    expect(b.trade).toBe('8931234567890')
    expect(b.internal8).toBe('8123456789012')
    expect(b.internalI).toBe('I0000001234')
    expect(parents[0].primaryBarcode).toBe('8931234567890')
  })
  it('dòng 1 trống, dòng 2 có → internal8, làm chính khi trade trống', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    expect(parents[1].barcode.trade).toBeNull()
    expect(parents[1].barcode.internal8).toBe('8123456789013')
    expect(parents[1].primaryBarcode).toBe('8123456789013')
  })
  it('parseBarcode: rỗng → tất cả null; quá 3 dòng → bỏ qua dòng thừa', () => {
    expect(parseBarcode(null)).toEqual({ trade: null, internal8: null, internalI: null })
    expect(parseBarcode('a\nb\nc\nd')).toEqual({ trade: 'a', internal8: 'b', internalI: 'c' })
  })
})

describe('T7 — nhận diện bomKind', () => {
  it('"1. BOM PRODUCT (BOM)" → BOM_PRODUCT; "2. BOM ASEMBLY (COMBO)" → BOM_ASSEMBLY', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    expect(parents[0].bomKind).toBe('BOM_PRODUCT')
    expect(parents[1].bomKind).toBe('BOM_ASSEMBLY')
  })
  it('không nhận diện được → null (V1 fail-fast)', () => {
    expect(detectBomKind('XYZ lạ')).toBeNull()
    expect(detectBomKind(null)).toBeNull()
  })
  it('"BOM" đơn lẻ (giá trị thật trong file) → BOM_PRODUCT', () => {
    expect(detectBomKind('BOM')).toBe('BOM_PRODUCT')
    expect(detectBomKind('bom')).toBe('BOM_PRODUCT')
  })
  it('"BOM ASEMBLY (COMBO)" → BOM_ASSEMBLY (ưu tiên assembly vì chứa "BOM")', () => {
    expect(detectBomKind('BOM ASEMBLY (COMBO)')).toBe('BOM_ASSEMBLY')
    expect(detectBomKind('COMBO')).toBe('BOM_ASSEMBLY')
  })
})

describe('parseNumber — số kiểu Việt Nam', () => {
  it('"1.234,56" → 1234.56; "1,5" → 1.5', () => {
    expect(parseNumber('1.234,56')).toBe(1234.56)
    expect(parseNumber('1,5')).toBe(1.5)
    expect(parseNumber(' 2 ')).toBe(2)
    expect(parseNumber(3.5)).toBe(3.5)
  })
  it('không parse được → null', () => {
    expect(parseNumber('abc')).toBeNull()
    expect(parseNumber('')).toBeNull()
  })
})

describe('mdChecks — tự tính lại (không tin công thức file, Q7)', () => {
  it('costTotal = Σ(Z×X); marginPct = (priceExVat − costTotal)/priceExVat', () => {
    const { parents } = parseMd05Workbook(buildMd05Fixture())
    // cha 1: 30000*2 + 20000*1 + 5000*4 + 40000*0.5 = 120000
    expect(parents[0].mdChecks.costTotal).toBe(120000)
    expect(parents[0].mdChecks.marginPct).toBeCloseTo(-0.2, 4)
  })
})
