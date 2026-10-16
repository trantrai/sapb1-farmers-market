// Test fillParentCodes — điền mã cha vào workbook (F4-export), fixture tổng hợp
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { fillParentCodes, ITEM_CODE_COL } from '../export-codes'

function buildBook(): XLSX.WorkBook {
  const rows: unknown[][] = [
    ['H1'],
    ['H2'],
    ['H3'],
    ['H4'],
    ['H5'],
    ['H6'],
    // dòng 7 (Excel): cha 1 — cột D đang trống
    [null, null, 'BOM', null, 'CHA MOT'],
    // dòng 8: con
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'I0001'],
    // dòng 9 (Excel): cha 2 — cột D đã có mã cũ
    [null, null, 'BOM', 'OLD001', 'CHA HAI'],
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Template IT up hệ thống')
  return wb
}

const cellVal = (wb: XLSX.WorkBook, rowNo: number) => {
  const ws = wb.Sheets['Template IT up hệ thống']
  const addr = XLSX.utils.encode_cell({ r: rowNo - 1, c: ITEM_CODE_COL })
  return ws[addr]?.v
}

describe('fillParentCodes', () => {
  it('điền mã vào đúng dòng Excel (cột D), giữ nguyên các ô khác', () => {
    const wb = buildBook()
    const { filled, skipped } = fillParentCodes(wb, [
      { rowNo: 7, code: 'CB-202610-0007' },
      { rowNo: 9, code: 'CB-202610-0008' },
    ])
    expect(filled).toBe(2)
    expect(skipped).toHaveLength(0)
    expect(cellVal(wb, 7)).toBe('CB-202610-0007')
    expect(cellVal(wb, 9)).toBe('CB-202610-0008') // ghi đè mã cũ
    // ô khác không đổi
    const ws = wb.Sheets['Template IT up hệ thống']
    expect(ws[XLSX.utils.encode_cell({ r: 6, c: 4 })]?.v).toBe('CHA MOT')
    expect(ws[XLSX.utils.encode_cell({ r: 6, c: 2 })]?.v).toBe('BOM')
  })

  it('entry rỗng / dòng < 1 → skipped', () => {
    const wb = buildBook()
    const { filled, skipped } = fillParentCodes(wb, [
      { rowNo: 0, code: 'X' },
      { rowNo: 7, code: '' },
    ])
    expect(filled).toBe(0)
    expect(skipped).toHaveLength(2)
    expect(cellVal(wb, 7)).toBeUndefined()
  })

  it('tạo ô mới khi ô D chưa tồn tại', () => {
    const wb = buildBook()
    // xóa ô D dòng 7 nếu có
    const ws = wb.Sheets['Template IT up hệ thống']
    delete ws[XLSX.utils.encode_cell({ r: 6, c: ITEM_CODE_COL })]
    const { filled } = fillParentCodes(wb, [{ rowNo: 7, code: 'NEW001' }])
    expect(filled).toBe(1)
    expect(cellVal(wb, 7)).toBe('NEW001')
  })
})
