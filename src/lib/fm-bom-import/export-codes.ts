// ============================================================
// Điền mã cha (Q1) vào file Excel BOM gốc (F4-export).
// Đọc workbook gốc đã ingest (IN-1), ghi mã vào cột D (Mã hàng / itemCode)
// tại đúng dòng Excel của từng mã cha, giữ nguyên mọi nội dung/kiểu còn lại.
// rowNo của canonical = số dòng Excel thật (parser giữ dòng trống).
// ============================================================

import * as XLSX from 'xlsx'

/** Chỉ số cột 0-based trong sheet MD_05 (khớp parser-md05.ts) */
export const ITEM_CODE_COL = 3 // D — "Mã hàng"

export interface ParentCodeEntry {
  /** Số dòng Excel thật (1-based) của dòng cha */
  rowNo: number
  code: string
}

export interface FillResult {
  filled: number
  /** Các entry không điền được (ngoài phạm vi sheet) */
  skipped: { rowNo: number; code: string }[]
}

/**
 * Ghi mã cha vào workbook (mutate wb). Trả về số dòng đã điền.
 * Ô chưa tồn tại sẽ được tạo mới dạng text.
 */
export function fillParentCodes(wb: XLSX.WorkBook, entries: ParentCodeEntry[]): FillResult {
  const sheetName = wb.SheetNames.includes('Template IT up hệ thống')
    ? 'Template IT up hệ thống'
    : wb.SheetNames[0]
  if (!sheetName) throw new Error('Workbook không có sheet nào')
  const ws = wb.Sheets[sheetName]

  let filled = 0
  const skipped: { rowNo: number; code: string }[] = []
  for (const e of entries) {
    if (!e.code || e.rowNo < 1) {
      skipped.push({ rowNo: e.rowNo, code: e.code })
      continue
    }
    const addr = XLSX.utils.encode_cell({ r: e.rowNo - 1, c: ITEM_CODE_COL })
    const cell = ws[addr] as XLSX.CellObject | undefined
    if (cell) {
      cell.v = e.code
      cell.t = 's'
      delete cell.f // không để formula cũ sót lại ở ô mã
    } else {
      ws[addr] = { v: e.code, t: 's' } as XLSX.CellObject
    }
    filled++
  }

  // Mở rộng !ref nếu mã nằm ngoài vùng cũ (ô mới tạo ở dòng/cột biên)
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  let dirty = false
  for (const e of entries) {
    if (e.rowNo - 1 > range.e.r) {
      range.e.r = e.rowNo - 1
      dirty = true
    }
  }
  if (dirty) ws['!ref'] = XLSX.utils.encode_range(range)

  return { filled, skipped }
}
