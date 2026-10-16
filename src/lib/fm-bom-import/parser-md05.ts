// ============================================================
// FARMERS MARKET — Import BOM: parser MD_05 2-pass (F1, T1–T8)
// - Pass 1 (values): đọc giá trị ô qua sheet_to_json.
// - Pass 2 (formulas): đọc cell.f gốc cho cột Q/R/S/T (cross-check T3).
// - Nhận diện dòng cha: cột E non-empty (bỏ header 6 dòng đầu).
// - T8: dòng cha kiêm con đầu tiên nếu cột U non-empty.
// Xử lý 14 quirk Q1–Q14 của file MD_05 (xem docs/giai-phap-mapping-bom.md).
// ============================================================

import * as XLSX from 'xlsx'
import {
  primaryBarcodeOf,
  type BomKind,
  type CanonicalBarcode,
  type CanonicalParent,
} from './canonical'

// Chỉ số cột (0-based) trong sheet "Template IT up hệ thống"
const C = {
  itemTypeLetter: 1, // B
  bomKindRaw: 2, // C
  itemCode: 3, // D
  itemName: 4, // E
  itemNameEn: 5, // F
  supplierName: 6, // G
  supplierCode: 7, // H
  barcodeRaw: 8, // I
  categoryLevel7: 9, // J
  uomPurchase: 10, // K
  uomSales: 11, // L
  uomInventory: 12, // M
  warehouse: 13, // N
  taxIn: 14, // O
  taxOut: 15, // P
  priceQ: 16, // Q (-VAT, công thức)
  priceR: 17, // R (+VAT, công thức)
  priceS: 18, // S (-VAT nhập tay)
  priceT: 19, // T (+VAT nhập tay)
  childCode: 20, // U
  childName: 21, // V
  childUom: 22, // W
  qtyRaw: 23, // X
  note: 24, // Y
  buyPrice: 25, // Z (GIÁ MUA)
  lineTotal: 26, // AA (THÀNH TIỀN)
  systemCost: 28, // AC (GIÁ VỐN)
  dupCheck: 29, // AD (CHECK TRÙNG TÊN) — trong khối Z–AG
} as const

const HEADER_ROWS = 6
export const MD05_SHEET_NAME = 'Template IT up hệ thống'

/**
 * Tìm chỉ số dòng bắt đầu dữ liệu (động, không dùng số cứng).
 * sheet_to_json với blankrows:false đã loại bỏ các dòng trống của Excel,
 * nên chỉ số mảng lệch so với số dòng Excel gốc — file thật bắt đầu dữ liệu
 * ở index 5 chứ không phải 6 (bug: từng làm mất mã cha đầu tiên, chỉ parse
 * được mã cha sau cùng).
 * Quy tắc: dòng header cột là dòng có ô E = "Item name" (không phân biệt
 * hoa/thường); dữ liệu bắt đầu ngay dòng sau. Không tìm thấy → fallback
 * HEADER_ROWS của template chuẩn.
 */
function findDataStart(rows: unknown[][]): number {
  const idx = rows.findIndex(
    (r) => normText((r || [])[C.itemName])?.toUpperCase() === 'ITEM NAME',
  )
  return idx >= 0 ? idx + 1 : HEADER_ROWS
}

/**
 * Suất VAT theo mã P0–P4/S0–S4.
 * Mặc định theo file thật đã verify (S2=5%, S4=8% — quirk Q3);
 * BẮT BUỘC đối chiếu lại với VatGroups trên SAP B1 trước khi dùng
 * production; override qua opts.vatRates (F12 cấu hình ở Sprint 4).
 */
export const DEFAULT_VAT_RATES: Record<string, number> = {
  P0: 0, P1: 0, P2: 0.05, P3: 0.08, P4: 0.1,
  S0: 0, S1: 0, S2: 0.05, S3: 0.08, S4: 0.08,
}

export interface ParseMd05Options {
  sheetName?: string
  /** Số lượng thành phẩm mà định mức X được phát biểu cho (mặc định 1) */
  batchQtyDefault?: number
  vatRates?: Record<string, number>
}

export interface ParseMd05Result {
  parents: CanonicalParent[]
  sheetUsed: string
  dataRows: number
}

/** T1 — trim + NFC; rỗng → null */
export function normText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).normalize('NFC').trim()
  return s === '' ? null : s
}

/**
 * Parse số kiểu Việt Nam: "1.234,56" → 1234.56 ; "1,5" → 1.5 ;
 * " 2 " → 2. Không parse được → null.
 */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  let s = v.normalize('NFC').trim().replace(/\s+/g, '')
  if (s === '' || s === '-') return null
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.') // 1.234,56 → 1234.56
  } else if (s.includes(',')) {
    s = s.replace(',', '.') // 1,5 → 1.5
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000
const round6 = (n: number) => Math.round(n * 1000000) / 1000000

/**
 * T5 — tách ô barcode theo dòng (positional, đúng format header file):
 * dòng 1 = BARCODE THƯƠNG MẠI, dòng 2 = NỘI BỘ ĐẦU 8, dòng 3 = NỘI BỘ ĐẦU I.
 * Dòng trống → slot null. Barcode chính lấy theo Q2a (trade → đầu 8 → đầu I).
 */
export function parseBarcode(raw: string | null): CanonicalBarcode {
  const out: CanonicalBarcode = { trade: null, internal8: null, internalI: null }
  if (!raw) return out
  const lines = raw.split(/\r?\n/).map((s) => s.normalize('NFC').trim())
  const slots: (keyof CanonicalBarcode)[] = ['trade', 'internal8', 'internalI']
  lines.slice(0, 3).forEach((line, i) => {
    if (line) out[slots[i]] = line
  })
  return out
}

/** T7 — nhận diện loại BOM; không nhận diện được → null (V1 fail-fast) */
export function detectBomKind(raw: string | null): BomKind | null {
  if (!raw) return null
  const s = raw.toUpperCase()
  // Kiểm tra ASSEMBLY trước vì "BOM ASEMBLY (COMBO)" cũng chứa chuỗi "BOM"
  if (/2\./.test(s) || s.includes('COMBO') || s.includes('ASEMBLY')) return 'BOM_ASSEMBLY'
  // "BOM" đơn lẻ (file thật ghi "BOM" thay vì "1. BOM PRODUCT") → BOM_PRODUCT
  if (/1\./.test(s) || s.includes('BOM PRODUCT') || s.includes('BOM')) return 'BOM_PRODUCT'
  return null
}

function cellFormula(ws: XLSX.WorkSheet, r: number, c: number): string | undefined {
  const cell = ws[XLSX.utils.encode_cell({ r, c })]
  return cell && typeof cell.f === 'string' ? cell.f : undefined
}

/**
 * Parse workbook MD_05 từ Buffer (đọc 1 lần, dùng cả values lẫn formulas).
 * Trả về danh sách parents đã normalize T1–T8 (chưa validate).
 */
export function parseMd05FromBuffer(
  buffer: Buffer,
  opts: ParseMd05Options = {},
): ParseMd05Result {
  const wb = XLSX.read(buffer, { type: 'buffer', cellFormula: true, cellDates: false })
  return parseMd05Workbook(wb, opts)
}

export function parseMd05Workbook(
  wb: XLSX.WorkBook,
  opts: ParseMd05Options = {},
): ParseMd05Result {
  const want = opts.sheetName ?? MD05_SHEET_NAME
  const sheetUsed = wb.SheetNames.includes(want) ? want : wb.SheetNames[0]
  if (!sheetUsed) throw new Error('Workbook không có sheet nào')
  const ws = wb.Sheets[sheetUsed]
  // Pass 1 — values
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  })
  const vatRates = opts.vatRates ?? DEFAULT_VAT_RATES
  const batchQtyDefault = opts.batchQtyDefault ?? 1

  const parents: CanonicalParent[] = []
  let current: CanonicalParent | null = null
  let sortOrder = 0
  // Tích lũy Σ(giá mua Z × định mức X) theo từng cha để tính costTotal/marginPct
  // khi đóng parent (không tin công thức margin của file — quirk Q7)
  let costAcc = 0
  let hasCost = false

  const pushParent = (p: CanonicalParent) => {
    if (hasCost) {
      p.mdChecks.costTotal = Math.round(costAcc * 100) / 100
      if (p.priceExVat != null && p.priceExVat > 0) {
        p.mdChecks.marginPct = round4((p.priceExVat - costAcc) / p.priceExVat)
      }
    }
    parents.push(p)
  }

  // Pass 2 — formulas được đọc trực tiếp từ ws qua cellFormula() khi cần
  // (dataStart tìm động vì blankrows:false làm lệch chỉ số mảng)
  const dataStart = findDataStart(rows)
  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i] || []
    const rowNo = i + 1 // 1-based như Excel
    const itemName = normText(row[C.itemName])

    if (itemName) {
      // ---- Dòng cha (quirk Q1) ----
      if (current) pushParent(current)
      costAcc = 0
      hasCost = false
      const barcodeRaw = row[C.barcodeRaw]
      const barcode = parseBarcode(
        barcodeRaw == null ? null : String(barcodeRaw).normalize('NFC'),
      )
      const taxOut = normText(row[C.taxOut])
      const priceT = parseNumber(row[C.priceT])
      const rate = taxOut ? vatRates[taxOut] : undefined
      const priceExVat =
        priceT != null && rate !== undefined ? round2(priceT / (1 + rate)) : null
      current = {
        rowNo,
        itemCode: normText(row[C.itemCode]),
        itemName,
        itemNameEn: normText(row[C.itemNameEn]),
        itemTypeLetter: normText(row[C.itemTypeLetter]),
        bomKindRaw: normText(row[C.bomKindRaw]),
        bomKind: detectBomKind(normText(row[C.bomKindRaw])),
        barcode,
        primaryBarcode: primaryBarcodeOf(barcode),
        categoryLevel7: normText(row[C.categoryLevel7]),
        uom: {
          purchase: normText(row[C.uomPurchase]),
          sales: normText(row[C.uomSales]),
          inventory: normText(row[C.uomInventory]),
        },
        warehouse: normText(row[C.warehouse]),
        taxIn: normText(row[C.taxIn]),
        taxOut,
        priceIncVat: priceT,
        priceExVat,
        priceCheckQ: parseNumber(row[C.priceQ]),
        priceCheckS: parseNumber(row[C.priceS]),
        formulas: {
          ...(cellFormula(ws, i, C.priceQ) ? { q: cellFormula(ws, i, C.priceQ) } : {}),
          ...(cellFormula(ws, i, C.priceR) ? { r: cellFormula(ws, i, C.priceR) } : {}),
          ...(cellFormula(ws, i, C.priceS) ? { s: cellFormula(ws, i, C.priceS) } : {}),
          ...(cellFormula(ws, i, C.priceT) ? { t: cellFormula(ws, i, C.priceT) } : {}),
        },
        supplier: {
          name: normText(row[C.supplierName]),
          code: normText(row[C.supplierCode]),
        },
        batchQty: batchQtyDefault,
        components: [],
        mdChecks: {
          costTotal: null,
          marginPct: null,
          systemCost: parseNumber(row[C.systemCost]),
          costDelta: null,
          uomMismatch: [],
          duplicateNameHit: isDupCheckHit(row[C.dupCheck]),
        },
      }
      sortOrder = 0
      // T8 — dòng cha kiêm con đầu tiên
      const firstChildCode = normText(row[C.childCode])
      if (firstChildCode && current) {
        current.components.push(
          makeComponent(row, rowNo, sortOrder++, batchQtyDefault),
        )
        accumulateCost(row)
      }
    } else if (current) {
      // ---- Dòng con ----
      const childCode = normText(row[C.childCode])
      if (childCode) {
        current.components.push(
          makeComponent(row, rowNo, sortOrder++, batchQtyDefault),
        )
        accumulateCost(row)
      }
      // Dòng hoàn toàn trống / dòng ghi chú không có U → bỏ qua
    }
  }
  if (current) pushParent(current)

  return { parents, sheetUsed, dataRows: Math.max(0, rows.length - dataStart) }

  /** Cộng dồn Z × X cho costTotal */
  function accumulateCost(row: unknown[]): void {
    const z = parseNumber(row[C.buyPrice])
    const x = parseNumber(row[C.qtyRaw])
    if (z != null && x != null) {
      costAcc += z * x
      hasCost = true
    }
  }
}

function makeComponent(
  row: unknown[],
  rowNo: number,
  sortOrder: number,
  batchQty: number,
): CanonicalParent['components'][number] {
  const qtyRaw = parseNumber(row[C.qtyRaw])
  return {
    rowNo,
    sortOrder,
    childCode: normText(row[C.childCode]) ?? '',
    childName: normText(row[C.childName]),
    uom: normText(row[C.childUom]),
    qtyRaw,
    // T2 — chuẩn hóa về 1 đơn vị cha, làm tròn 6 decimals
    qtyPerParent: qtyRaw != null && batchQty > 0 ? round6(qtyRaw / batchQty) : null,
    note: normText(row[C.note]),
  }
}

/** CHECK TRÙNG TÊN: ô có giá trị (không phải OK/0/trống) → coi là trùng */
function isDupCheckHit(v: unknown): boolean {
  const s = normText(v)
  if (!s) return false
  return !/^(ok|0|không|khong|no|ko)$/i.test(s)
}
