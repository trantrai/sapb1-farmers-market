// ============================================================
// FARMERS MARKET — Import BOM: parse workbook báo giá (F19, Sprint 2)
// 3 sheet: BẢNG BÁO GIÁ → sets[] + contractTotals
//          LỊCH GIAO HÀNG → deliverySchedule[] (chỉ lưu trace, NQ5)
//          Final Cost → costing[]
// 2 sheet còn lại ('Đề xuất tạo BOM', 'chính sách chiết khấu') bị bỏ qua,
// ghi vào skippedSheets.
// Chỉ đọc cấu trúc file — test dùng fixture tổng hợp, không copy dữ liệu thật.
// ============================================================

import * as XLSX from 'xlsx'

export interface QuotationSetLine {
  itemCode: string
  itemName: string | null
  barcode: string | null
  uom: string | null
  unitPriceExVat: number | null
  vatRate: number | null
  discountPct: number | null
  priceAfterDiscountExVat: number | null
  qty: number | null
  amountExVat: number | null
}

export interface QuotationVatRow {
  rate: number
  amount: number
}

export interface QuotationSet {
  /** Tên set, vd "Set 1" */
  name: string
  lines: QuotationSetLine[]
  /** "GIÁ TRỊ SET QUÀ (chưa VAT)" */
  subtotalExVat: number | null
  vatRows: QuotationVatRow[]
  /** "TỔNG GIÁ TRỊ PHẦN QUÀ (đã VAT)" */
  totalIncVat: number | null
  /** "TỔNG GIÁ TRỊ ĐƠN HÀNG QUÀ" */
  orderTotal: number | null
}

export interface ContractSummaryLine {
  itemCode: string | null
  itemName: string | null
  uom: string | null
  unitPriceExVat: number | null
  vatRate: number | null
  qty: number | null
  amountExVat: number | null
}

export interface ContractTotals {
  totalExVat: number | null
  vatByRate: QuotationVatRow[]
  totalIncVat: number | null
  /** Bảng "III. TỔNG GIÁ TRỊ HỢP ĐỒNG" — tổng hợp theo nhóm thuế */
  summaryLines: ContractSummaryLine[]
}

export interface CostingRow {
  itemCode: string
  barcode: string | null
  itemName: string | null
  uom: string | null
  costExVat: number | null
  priceExVat: number | null
  priceIncVat: number | null
  /** tỷ lệ, vd 0.53 = 53% */
  margin: number | null
}

export interface DeliveryScheduleRow {
  /** YYYY-MM-DD */
  date: string | null
  setName: string | null
  qty: number | null
  address: string | null
  receiver: string | null
  timeSlot: string | null
  department: string | null
}

export interface ParsedQuotation {
  sets: QuotationSet[]
  contractTotals: ContractTotals | null
  costing: CostingRow[]
  deliverySchedule: DeliveryScheduleRow[]
  /** Sheet không parse (ghi log rõ) */
  skippedSheets: string[]
  warnings: string[]
}

// ---------- helpers ----------

function normText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).normalize('NFC').trim()
  return s === '' ? null : s
}

/** Chuẩn hóa tiêu đề cột để map theo keyword: hoa + bỏ mọi khoảng trắng */
function normHeader(v: unknown): string {
  return (normText(v) ?? '').toUpperCase().replace(/[\s_]+/g, '')
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim().replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, '')
  if (s === '' || s === '-' || s === '.') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** "16/10/2026" hoặc Date → "2026-10-16" */
export function parseVnDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  const s = normText(v)
  if (!s) return null
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) {
    const p = (n: string) => n.padStart(2, '0')
    return `${m[3]}-${p(m[2])}-${p(m[1])}`
  }
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m2 ? m2[0] : null
}

/** Map cột theo keyword trên dòng tiêu đề — trả về { key: colIndex } */
function mapColumns(
  headerRow: unknown[],
  defs: { key: string; patterns: RegExp[]; exclude?: RegExp[] }[],
): Record<string, number> {
  const out: Record<string, number> = {}
  headerRow.forEach((cell, idx) => {
    const h = normHeader(cell)
    if (!h) return
    for (const def of defs) {
      if (out[def.key] !== undefined) continue
      if (def.patterns.some((p) => p.test(h)) && !(def.exclude ?? []).some((p) => p.test(h))) {
        out[def.key] = idx
      }
    }
  })
  return out
}

type Rows = unknown[][]

function getRows(ws: XLSX.WorkSheet): Rows {
  return XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  })
}

/** true nếu ô khớp toàn bộ "Set <số>" (không khớp "Set 1 T5..." ở bảng tổng hợp) */
function isSetMarker(v: unknown): string | null {
  const s = normText(v)
  if (!s) return null
  const m = s.match(/^set\s*\d+$/i)
  return m ? s : null
}

/**
 * Cột đánh dấu block "Set N" — file thật đặt ở cột C; các cột khác
 * (vd cột M ghi chú "Set 1" ở dòng tổng hợp) phải bỏ qua.
 */
const SET_MARKER_COL = 2

function rowHas(row: unknown[], re: RegExp): boolean {
  // Chuẩn hóa như normHeader (hoa + bỏ khoảng trắng) để regex viết liền khớp
  return row.some((c) => {
    const s = normText(c)
    return s !== null && re.test(s.toUpperCase().replace(/[\s_]+/g, ''))
  })
}

/** Số lớn nhất trong dòng — dùng cho ô tổng tiền (tổng luôn là số lớn nhất,
 *  tránh nhầm với số lượng/CP vận chuyển nằm cùng dòng) */
function maxNumber(row: unknown[]): number | null {
  let out: number | null = null
  for (const c of row) {
    const n = toNumber(c)
    if (n !== null && (out === null || n > out)) out = n
  }
  return out
}

/** Tách rate (0,1) và amount (số lớn nhất) trong dòng "THUẾ VAT" */
function parseVatRow(row: unknown[]): QuotationVatRow | null {
  let rate: number | null = null
  let amount: number | null = null
  for (const c of row) {
    const n = toNumber(c)
    if (n === null) continue
    if (n > 0 && n < 1 && rate === null) rate = n
    else amount = n
  }
  if (rate === null || amount === null) return null
  return { rate, amount }
}

// ---------- BẢNG BÁO GIÁ ----------

const SET_LINE_COLS = [
  { key: 'stt', patterns: [/^STT$/] },
  { key: 'barcode', patterns: [/BARCODE/] },
  { key: 'itemCode', patterns: [/ITEMCODE/, /MÃHÀNG/] },
  { key: 'itemName', patterns: [/TÊNSẢNPHẨM/, /^TÊN/] },
  { key: 'uom', patterns: [/ĐƠNVỊ/, /ĐVT/] },
  // ĐƠN GIÁ có 2 cột ("ĐƠN GIÁ (-vat)" và "ĐƠN GIÁ SAU CK (-VAT)") — map tay bên dưới
  { key: 'vat', patterns: [/^VAT$/, /THUẾ/] },
  { key: 'discount', patterns: [/CHIẾTKHẤU/] },
  { key: 'qty', patterns: [/SỐLƯỢNG/, /^SL$/] },
  { key: 'amount', patterns: [/THÀNHTIỀN/] },
]

function parseQuoteSheet(ws: XLSX.WorkSheet, warnings: string[]): { sets: QuotationSet[]; contractTotals: ContractTotals | null } {
  const rows = getRows(ws)
  const sets: QuotationSet[] = []
  let contractTotals: ContractTotals | null = null

  // Tìm dòng bắt đầu mục "III. TỔNG GIÁ TRỊ HỢP ĐỒNG" (nếu có)
  let contractSectionAt = -1
  for (let i = 0; i < rows.length; i++) {
    if (rowHas(rows[i], /TỔNGGIÁTRỊHỢPĐỒNG/)) {
      contractSectionAt = i
      break
    }
  }
  const setRegionEnd = contractSectionAt >= 0 ? contractSectionAt : rows.length

  // ---- Block "Set N" ----
  let i = 0
  while (i < setRegionEnd) {
    const marker = isSetMarker(rows[i][SET_MARKER_COL])
    if (!marker) {
      i++
      continue
    }
    const setName = marker
    // Dòng tiếp theo chứa tiêu đề cột (có "TÊN SẢN PHẨM")
    let hi = i + 1
    while (hi < setRegionEnd && !rowHas(rows[hi], /TÊNSẢNPHẨM/)) hi++
    if (hi >= setRegionEnd) {
      warnings.push(`Set "${setName}": không tìm thấy dòng tiêu đề cột — bỏ qua block`)
      i++
      continue
    }
    const headerRow = rows[hi]
    const cols = mapColumns(headerRow, SET_LINE_COLS)
    // 2 cột ĐƠN GIÁ: "ĐƠN GIÁ (-vat)" và "ĐƠN GIÁ SAU CK (-VAT)" — phân biệt bằng SAUCK
    headerRow.forEach((cell, idx) => {
      const h = normHeader(cell)
      if (!/ĐƠNGIÁ/.test(h)) return
      if (/SAUCK/.test(h)) {
        if (cols.priceAfterDiscountExVat === undefined) cols.priceAfterDiscountExVat = idx
      } else if (cols.unitPriceExVat === undefined) {
        cols.unitPriceExVat = idx
      }
    })

    const set: QuotationSet = {
      name: setName,
      lines: [],
      subtotalExVat: null,
      vatRows: [],
      totalIncVat: null,
      orderTotal: null,
    }
    let j = hi + 1
    for (; j < setRegionEnd; j++) {
      const row = rows[j]
      // Gặp marker "Set N" tiếp theo → kết thúc block hiện tại
      if (isSetMarker(row[SET_MARKER_COL]) !== null) break
      // Mục "II. BÁO GIÁ DỊCH VỤ" (nếu có) → kết thúc block, không parse dòng dịch vụ
      if (rowHas(row, /DỊCHVỤ/)) break
      if (rowHas(row, /GIÁTRỊSETQUÀ/)) {
        const amtCol = cols.amount !== undefined ? toNumber(row[cols.amount]) : null
        set.subtotalExVat = amtCol ?? maxNumber(row)
        continue
      }
      if (rowHas(row, /^THUẾVAT/)) {
        const vr = parseVatRow(row)
        if (vr) set.vatRows.push(vr)
        continue
      }
      if (rowHas(row, /TỔNGGIÁTRỊPHẦNQUÀ/)) {
        const amtCol = cols.amount !== undefined ? toNumber(row[cols.amount]) : null
        set.totalIncVat = amtCol ?? maxNumber(row)
        continue
      }
      if (rowHas(row, /TỔNGGIÁTRỊĐƠNHÀNGQUÀ/)) {
        const amtCol = cols.amount !== undefined ? toNumber(row[cols.amount]) : null
        set.orderTotal = amtCol ?? maxNumber(row)
        continue
      }
      // Dòng hàng: STT là số
      const stt = cols.stt !== undefined ? toNumber(row[cols.stt]) : null
      const itemCode = cols.itemCode !== undefined ? normText(row[cols.itemCode]) : null
      if (stt === null || !itemCode) continue
      set.lines.push({
        itemCode,
        itemName: cols.itemName !== undefined ? normText(row[cols.itemName]) : null,
        barcode: cols.barcode !== undefined ? normText(row[cols.barcode]) : null,
        uom: cols.uom !== undefined ? normText(row[cols.uom]) : null,
        unitPriceExVat: cols.unitPriceExVat !== undefined ? toNumber(row[cols.unitPriceExVat]) : null,
        vatRate: cols.vat !== undefined ? toNumber(row[cols.vat]) : null,
        discountPct: cols.discount !== undefined ? toNumber(row[cols.discount]) : null,
        priceAfterDiscountExVat:
          cols.priceAfterDiscountExVat !== undefined ? toNumber(row[cols.priceAfterDiscountExVat]) : null,
        qty: cols.qty !== undefined ? toNumber(row[cols.qty]) : null,
        amountExVat: cols.amount !== undefined ? toNumber(row[cols.amount]) : null,
      })
    }
    sets.push(set)
    i = j
  }

  // ---- Mục III: bảng tổng hợp theo nhóm thuế + tổng HĐ ----
  if (contractSectionAt >= 0) {
    const summaryLines: ContractSummaryLine[] = []
    let totalExVat: number | null = null
    const vatByRate: QuotationVatRow[] = []
    let totalIncVat: number | null = null
    // Dòng tiêu đề bảng tổng hợp (có "MÃ HÀNG")
    let hi = contractSectionAt + 1
    while (hi < rows.length && !rowHas(rows[hi], /MÃHÀNG/)) hi++
    const cols: Record<string, number> = {}
    if (hi < rows.length) {
      const headerRow = rows[hi]
      headerRow.forEach((cell, idx) => {
        const h = normHeader(cell)
        if (!h) return
        if (/^STT$/.test(h) && cols.stt === undefined) cols.stt = idx
        else if (/MÃHÀNG/.test(h) && cols.itemCode === undefined) cols.itemCode = idx
        else if (/TÊNSẢNPHẨM|^TÊN/.test(h) && cols.itemName === undefined) cols.itemName = idx
        else if (/ĐƠNVỊ|ĐVT/.test(h) && cols.uom === undefined) cols.uom = idx
        else if (/ĐƠNGIÁ/.test(h) && cols.unitPriceExVat === undefined) cols.unitPriceExVat = idx
        else if (/^VAT$|THUẾ/.test(h) && cols.vat === undefined) cols.vat = idx
        else if (/SỐLƯỢNG|^SL$/.test(h) && cols.qty === undefined) cols.qty = idx
        else if (/THÀNHTIỀN/.test(h) && cols.amount === undefined) cols.amount = idx
      })
    }
    for (let k = (hi < rows.length ? hi + 1 : contractSectionAt + 1); k < rows.length; k++) {
      const row = rows[k]
      if (rowHas(row, /TỔNGGIÁTRỊHỢPĐỒNGCHƯA/)) {
        totalExVat = maxNumber(row)
        continue
      }
      if (rowHas(row, /^THUẾVAT/)) {
        const vr = parseVatRow(row)
        if (vr) vatByRate.push(vr)
        continue
      }
      if (rowHas(row, /TỔNGGIÁTRỊHỢPĐỒNGCÓ/)) {
        totalIncVat = maxNumber(row)
        continue
      }
      const stt = cols.stt !== undefined ? toNumber(row[cols.stt]) : null
      if (stt === null) continue
      summaryLines.push({
        itemCode: cols.itemCode !== undefined ? normText(row[cols.itemCode]) : null,
        itemName: cols.itemName !== undefined ? normText(row[cols.itemName]) : null,
        uom: cols.uom !== undefined ? normText(row[cols.uom]) : null,
        unitPriceExVat: cols.unitPriceExVat !== undefined ? toNumber(row[cols.unitPriceExVat]) : null,
        vatRate: cols.vat !== undefined ? toNumber(row[cols.vat]) : null,
        qty: cols.qty !== undefined ? toNumber(row[cols.qty]) : null,
        amountExVat: cols.amount !== undefined ? toNumber(row[cols.amount]) : null,
      })
    }
    contractTotals = { totalExVat, vatByRate, totalIncVat, summaryLines }
  }

  return { sets, contractTotals }
}

// ---------- LỊCH GIAO HÀNG (NQ5: chỉ lưu trace) ----------

function parseDeliverySheet(ws: XLSX.WorkSheet, warnings: string[]): DeliveryScheduleRow[] {
  const rows = getRows(ws)
  // Tìm dòng tiêu đề (có "Ngày" + "Số lượng")
  let hi = -1
  for (let i = 0; i < rows.length; i++) {
    if (rowHas(rows[i], /NGÀY/) && rowHas(rows[i], /SỐLƯỢNG/)) {
      hi = i
      break
    }
  }
  if (hi < 0) {
    warnings.push('Sheet LỊCH GIAO HÀNG: không tìm thấy dòng tiêu đề — bỏ qua lịch giao')
    return []
  }
  const cols: Record<string, number> = {}
  rows[hi].forEach((cell, idx) => {
    const h = normHeader(cell)
    if (!h) return
    if (/PHÒNGBAN/.test(h) && cols.department === undefined) cols.department = idx
    else if (/NGÀY/.test(h) && cols.date === undefined) cols.date = idx
    else if (/SỐLƯỢNG/.test(h) && cols.qty === undefined) cols.qty = idx
    else if (/ĐỊACHỈ/.test(h) && cols.address === undefined) cols.address = idx
    else if (/NGƯỜINHẬN/.test(h) && cols.receiver === undefined) cols.receiver = idx
    else if (/THỜIGIAN/.test(h) && cols.timeSlot === undefined) cols.timeSlot = idx
    else if ((/GIỎ|TRÁICÂY|^SET/.test(h) || /TÊNSẢNPHẨM/.test(h)) && cols.setName === undefined) cols.setName = idx
  })

  // Ô merge chỉ giữ giá trị ở ô đầu — forward-fill từ dòng trước
  const out: DeliveryScheduleRow[] = []
  const last: Record<string, unknown> = {}
  for (let i = hi + 1; i < rows.length; i++) {
    const row = rows[i]
    if (rowHas(row, /^TỔNG/)) continue // dòng tổng cuối bảng
    const get = (key: string): unknown => {
      const ci = cols[key]
      if (ci === undefined) return null
      const v = row[ci]
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        last[key] = v
        return v
      }
      return last[key] ?? null // forward-fill ô merge
    }
    const qty = toNumber(get('qty'))
    const setName = normText(get('setName'))
    const date = parseVnDate(get('date'))
    if (qty === null && !setName && !date) continue
    out.push({
      date,
      setName,
      qty,
      address: normText(get('address')),
      receiver: normText(get('receiver')),
      timeSlot: normText(get('timeSlot')),
      department: normText(get('department')),
    })
  }
  return out
}

// ---------- Final Cost ----------

function parseCostingSheet(ws: XLSX.WorkSheet, warnings: string[]): CostingRow[] {
  const rows = getRows(ws)
  let hi = -1
  for (let i = 0; i < rows.length; i++) {
    if (rowHas(rows[i], /TÊNCÔNGTHỨC/)) {
      hi = i
      break
    }
  }
  if (hi < 0) {
    warnings.push('Sheet Final Cost: không tìm thấy dòng tiêu đề — bỏ qua costing')
    return []
  }
  const cols: Record<string, number> = {}
  rows[hi].forEach((cell, idx) => {
    const h = normHeader(cell)
    if (!h) return
    if (/MÃHÀNG/.test(h) && cols.itemCode === undefined) cols.itemCode = idx
    else if (/BARCODE/.test(h) && cols.barcode === undefined) cols.barcode = idx
    else if (/TÊNCÔNGTHỨC|^TÊN/.test(h) && cols.itemName === undefined) cols.itemName = idx
    else if (/ĐVT/.test(h) && cols.uom === undefined) cols.uom = idx
    else if (/GIÁVỐN/.test(h) && cols.costExVat === undefined) cols.costExVat = idx
    else if (/GIÁBÁNFINAL/.test(h) && !/\+VAT/.test(h) && cols.priceExVat === undefined) cols.priceExVat = idx
    else if (/GIÁBÁNFINAL/.test(h) && /\+VAT/.test(h) && cols.priceIncVat === undefined) cols.priceIncVat = idx
    else if (/MARGIN/.test(h) && cols.margin === undefined) cols.margin = idx
  })
  const out: CostingRow[] = []
  for (let i = hi + 1; i < rows.length; i++) {
    const row = rows[i]
    const itemCode = cols.itemCode !== undefined ? normText(row[cols.itemCode]) : null
    if (!itemCode) continue
    out.push({
      itemCode,
      barcode: cols.barcode !== undefined ? normText(row[cols.barcode]) : null,
      itemName: cols.itemName !== undefined ? normText(row[cols.itemName]) : null,
      uom: cols.uom !== undefined ? normText(row[cols.uom]) : null,
      costExVat: cols.costExVat !== undefined ? toNumber(row[cols.costExVat]) : null,
      priceExVat: cols.priceExVat !== undefined ? toNumber(row[cols.priceExVat]) : null,
      priceIncVat: cols.priceIncVat !== undefined ? toNumber(row[cols.priceIncVat]) : null,
      margin: cols.margin !== undefined ? toNumber(row[cols.margin]) : null,
    })
  }
  return out
}

// ---------- entry point ----------

/** Nhận diện sheet theo tên đã trim (chịu được 'LỊCH GIAO HÀNG ' có dấu cách cuối) */
function classifySheet(name: string): 'quote' | 'delivery' | 'costing' | 'skip' {
  const n = name.trim().toUpperCase()
  if (n.startsWith('BẢNG BÁO GIÁ')) return 'quote'
  if (n.startsWith('LỊCH GIAO HÀNG')) return 'delivery'
  if (n.startsWith('FINAL COST')) return 'costing'
  return 'skip'
}

export function parseQuotationFromBuffer(buffer: Buffer): ParsedQuotation {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  return parseQuotationWorkbook(wb)
}

export function parseQuotationWorkbook(wb: XLSX.WorkBook): ParsedQuotation {
  const out: ParsedQuotation = {
    sets: [],
    contractTotals: null,
    costing: [],
    deliverySchedule: [],
    skippedSheets: [],
    warnings: [],
  }
  for (const name of wb.SheetNames) {
    const kind = classifySheet(name)
    const ws = wb.Sheets[name]
    try {
      if (kind === 'quote') {
        const { sets, contractTotals } = parseQuoteSheet(ws, out.warnings)
        out.sets = sets
        out.contractTotals = contractTotals
      } else if (kind === 'delivery') {
        out.deliverySchedule = parseDeliverySheet(ws, out.warnings)
      } else if (kind === 'costing') {
        out.costing = parseCostingSheet(ws, out.warnings)
      } else {
        out.skippedSheets.push(name)
      }
    } catch (e) {
      out.warnings.push(`Sheet "${name}": parse lỗi (${(e as Error).message}) — bỏ qua sheet`)
      if (kind !== 'skip') out.skippedSheets.push(name)
    }
  }
  return out
}
