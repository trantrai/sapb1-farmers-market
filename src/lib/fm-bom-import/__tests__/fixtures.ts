// Fixture TỔNG HỢP cho test Import BOM — dữ liệu giả lập, KHÔNG phải dữ liệu thật công ty.
// Dựng workbook MD_05 trong bộ nhớ (không đọc file), mô phỏng 14 quirk Q1–Q14.
import * as XLSX from 'xlsx'
import type { CanonicalParent } from '../canonical'

/** Chỉ số cột 0-based (khớp parser-md05.ts) */
export const COL = {
  itemTypeLetter: 1, bomKindRaw: 2, itemCode: 3, itemName: 4, itemNameEn: 5,
  supplierName: 6, supplierCode: 7, barcodeRaw: 8, categoryLevel7: 9,
  uomPurchase: 10, uomSales: 11, uomInventory: 12, warehouse: 13,
  taxIn: 14, taxOut: 15, priceQ: 16, priceR: 17, priceS: 18, priceT: 19,
  childCode: 20, childName: 21, childUom: 22, qtyRaw: 23, note: 24,
  buyPrice: 25, lineTotal: 26, systemCost: 28, dupCheck: 29,
} as const

function row(): unknown[] {
  return new Array(33).fill(null)
}

/**
 * Workbook MD_05 giả lập:
 * - 6 dòng header
 * - Cha 1 (dòng 7): "1. BOM PRODUCT (BOM)", T=105000/S2 → trước VAT 100000,
 *   barcode 3 dòng, dòng cha kiêm con đầu tiên (T8), ĐVT "Kg " bẩn (T1)
 * - 3 dòng con tiếp theo
 * - Cha 2 (dòng 11): "2. BOM ASEMBLY (COMBO)", T=108000/S4 → trước VAT 100000,
 *   chỉ có barcode đầu 8
 * - 2 dòng con
 */
export function buildMd05Fixture(): XLSX.WorkBook {
  const rows: unknown[][] = []
  for (let i = 0; i < 6; i++) rows.push([`HEADER ${i + 1}`])

  const p1 = row()
  p1[COL.itemTypeLetter] = 'I'
  p1[COL.bomKindRaw] = '1. BOM PRODUCT (BOM)'
  p1[COL.itemCode] = ''
  p1[COL.itemName] = 'PHẦN QUÀ TEST 01'
  p1[COL.itemNameEn] = 'TEST GIFT 01'
  p1[COL.supplierName] = 'NCC Test'
  p1[COL.supplierCode] = 'NCC001'
  p1[COL.barcodeRaw] = '8931234567890\n8123456789012\nI0000001234'
  p1[COL.categoryLevel7] = '1040101010101 - DAILY IMPORT FRUIT HAMPER'
  p1[COL.uomPurchase] = 'Phần'
  p1[COL.uomSales] = 'Phần'
  p1[COL.uomInventory] = 'Phần'
  p1[COL.warehouse] = ''
  p1[COL.taxIn] = 'P2'
  p1[COL.taxOut] = 'S2'
  p1[COL.priceQ] = 100000
  p1[COL.priceR] = 105000
  p1[COL.priceS] = 100000
  p1[COL.priceT] = 105000
  p1[COL.childCode] = 'I0000001' // T8: dòng cha kiêm con đầu tiên
  p1[COL.childName] = 'Táo test'
  p1[COL.childUom] = 'Kg ' // trailing space — T1
  p1[COL.qtyRaw] = 2
  p1[COL.buyPrice] = 30000
  rows.push(p1)

  const c = (code: string, name: string, uom: string, qty: number, buy: number) => {
    const r = row()
    r[COL.childCode] = code
    r[COL.childName] = name
    r[COL.childUom] = uom
    r[COL.qtyRaw] = qty
    r[COL.buyPrice] = buy
    return r
  }
  rows.push(c('I0000002', 'Nho test', 'Hộp', 1, 20000))
  rows.push(c('I0000003', 'Cam test', 'Cái', 4, 5000))
  rows.push(c('I0000004', 'Lê test', 'Bó', 0.5, 40000))

  const p2 = row()
  p2[COL.bomKindRaw] = '2. BOM ASEMBLY (COMBO)'
  p2[COL.itemName] = 'COMBO QUÀ TEST 02'
  p2[COL.barcodeRaw] = '\n8123456789013' // dòng 1 trống, dòng 2 = nội bộ đầu 8 (positional)
  p2[COL.uomSales] = 'Phần'
  p2[COL.uomInventory] = 'Phần'
  p2[COL.taxIn] = 'P4'
  p2[COL.taxOut] = 'S4'
  p2[COL.priceT] = 108000
  p2[COL.priceS] = 100000
  rows.push(p2)
  rows.push(c('N0000001', 'Hộp quà', 'Cái', 1, 15000))
  rows.push(c('N0000002', 'Ruy băng', 'Cuộn', 0.02, 100000))

  const ws = XLSX.utils.aoa_to_sheet(rows)
  // Pass 2 — công thức gốc (quirk Q3)
  const setF = (addr: string, f: string) => {
    const cell = ws[addr]
    if (cell) cell.f = f
  }
  setF('Q7', 'R7/1.05')
  setF('R7', 'T7')
  setF('Q11', 'R11/1.08')
  setF('R11', 'T11')

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Template IT up hệ thống')
  return wb
}

/** Parent tối giản để test validator (override từng case) */
export function makeParent(over: Partial<CanonicalParent> = {}): CanonicalParent {
  return {
    rowNo: 7,
    itemCode: null,
    itemName: 'PHẦN QUÀ TEST',
    itemNameEn: null,
    itemTypeLetter: 'I',
    bomKind: 'BOM_PRODUCT',
    bomKindRaw: '1. BOM PRODUCT (BOM)',
    barcode: { trade: '8931234567890', internal8: null, internalI: null },
    primaryBarcode: '8931234567890',
    categoryLevel7: null,
    uom: { purchase: 'Phần', sales: 'Phần', inventory: 'Phần' },
    warehouse: null,
    taxIn: 'P2',
    taxOut: 'S2',
    priceIncVat: 105000,
    priceExVat: 100000,
    priceCheckQ: 100000,
    priceCheckS: 100000,
    supplier: { name: null, code: null },
    batchQty: 1,
    components: [
      {
        rowNo: 7, sortOrder: 0, childCode: 'I0000001', childName: 'Táo test',
        uom: 'Kg', qtyRaw: 2, qtyPerParent: 2, note: null,
      },
    ],
    mdChecks: {
      costTotal: 60000, marginPct: 0.4, systemCost: null,
      costDelta: null, uomMismatch: [], duplicateNameHit: false,
    },
    ...over,
  }
}
