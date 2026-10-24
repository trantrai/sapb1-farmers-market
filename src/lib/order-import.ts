// ============================================================
// NHẬP DÒNG HÀNG TỪ EXCEL — logic thuần (dùng cả client & server)
// 1) parseImportRows: đọc từng dòng theo template, kiểm số học
// 2) matchImportRows: khớp với danh mục — mã hàng → mã vạch → tên gần đúng
// Kết quả hiển thị ở bước XEM TRƯỚC; chỉ dòng người dùng chọn mới điền vào đơn.
// ============================================================

export interface ImportItem {
  itemCode: string
  itemName: string
  uom?: string | null
  price?: number | null
  taxCode?: string | null
  vatRate?: number | null
  barcode?: string | null
}

export interface ParsedImportRow {
  /** Số dòng trên file (1-based, đã tính dòng tiêu đề) */
  excelRow: number
  code: string
  name: string
  quantity: number
  /** null = file không khai → lấy giá danh mục */
  unitPrice: number | null
  discPct: number | null
  uom: string
  taxCode: string
  warehouseCode: string
}

export interface ImportRowError {
  excelRow: number
  code: string
  name: string
  message: string
}

/** Cách khớp: mã hàng | mã vạch | tên gần đúng | không tìm thấy */
export type MatchKind = 'code' | 'barcode' | 'name' | 'none'

export interface ImportMatch {
  kind: MatchKind
  /** Mặt hàng được chọn sẵn (null = cần người dùng chọn / không có) */
  item: ImportItem | null
  /** Ứng viên theo tên (tối đa 3, điểm giảm dần) */
  candidates: { item: ImportItem; score: number }[]
  /** Khớp mã nhưng tên trong file khác hẳn tên danh mục → nên kiểm lại */
  nameMismatch: boolean
}

export const IMPORT_MAX_ROWS = 1000

/** Parse số từ ô Excel: chấp nhận "1.234,56" (vi), "1,234.56" (en), "1,5".
 *  Trả null khi ô trống, NaN khi không phải số. */
export function parseExcelNum(v: string): number | null {
  const s = v.trim().replace(/\s/g, '')
  if (s === '') return null
  let norm = s
  if (norm.includes(',') && norm.includes('.')) {
    norm =
      norm.lastIndexOf(',') > norm.lastIndexOf('.')
        ? norm.replace(/\./g, '').replace(',', '.')
        : norm.replace(/,/g, '')
  } else if (norm.includes(',')) {
    norm = norm.replace(',', '.')
  }
  const n = Number(norm)
  return Number.isFinite(n) ? n : NaN
}

/** Đọc các dòng Excel (sheet_to_json) theo mapping cột → field của template */
export function parseImportRows(
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
): { parsed: ParsedImportRow[]; errors: ImportRowError[] } {
  const fieldToCol: Record<string, string> = {}
  for (const [col, field] of Object.entries(mapping)) fieldToCol[field] = col
  const parsed: ParsedImportRow[] = []
  const errors: ImportRowError[] = []
  rows.forEach((row, idx) => {
    const excelRow = idx + 2
    const get = (field: string): string => {
      const col = fieldToCol[field]
      return col ? String(row[col] ?? '').trim() : ''
    }
    const code = get('itemCode')
    const name = get('itemName')
    const fail = (message: string) => errors.push({ excelRow, code, name, message })
    const rawQty = get('quantity')
    // Dòng trống hoàn toàn (thường ở cuối file) → bỏ qua im lặng
    if (!code && !name && !rawQty) return
    if (!code && !name) return fail('Thiếu mã hàng và tên hàng')
    const quantity = parseExcelNum(rawQty)
    if (quantity === null || Number.isNaN(quantity)) return fail('Số lượng trống hoặc không phải số')
    if (quantity <= 0) return fail('Số lượng phải > 0')
    const unitPrice = parseExcelNum(get('unitPrice'))
    if (unitPrice !== null && (Number.isNaN(unitPrice) || unitPrice < 0)) return fail('Đơn giá không hợp lệ')
    const discPct = parseExcelNum(get('discPct'))
    if (discPct !== null && (Number.isNaN(discPct) || discPct < 0 || discPct > 100)) return fail('Chiết khấu % phải từ 0 đến 100')
    parsed.push({
      excelRow, code, name, quantity, unitPrice, discPct,
      uom: get('uom'), taxCode: get('taxCode'), warehouseCode: get('warehouseCode'),
    })
  })
  return { parsed, errors }
}

/** Chuẩn hoá để so khớp: thường, bỏ dấu tiếng Việt, gộp khoảng trắng */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

interface NameGrams { chars: Set<string>; words: Set<string> }

function grams(s: string): NameGrams {
  const n = normText(s)
  const t = n.replace(/ /g, '')
  const chars = new Set<string>()
  if (t.length === 1) chars.add(t)
  for (let i = 0; i < t.length - 1; i++) chars.add(t.slice(i, i + 2))
  return { chars, words: new Set(n ? n.split(' ') : []) }
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return (2 * inter) / (a.size + b.size)
}

/** Trung bình Dice theo cặp ký tự (chịu lỗi gõ) và theo từ (tránh trùng ngẫu nhiên ở tên ngắn) */
function score(a: NameGrams, b: NameGrams): number {
  return (dice(a.chars, b.chars) + dice(a.words, b.words)) / 2
}

/** Độ giống tên (0..1), không phân biệt hoa thường / dấu tiếng Việt */
export function nameSimilarity(a: string, b: string): number {
  return score(grams(a), grams(b))
}

/** Ngưỡng gợi ý ứng viên / tự chọn sẵn / cảnh báo tên lệch */
const SUGGEST_MIN = 0.45
const AUTO_PICK_MIN = 0.8
const AUTO_PICK_GAP = 0.1
const MISMATCH_MAX = 0.3

/** Khớp các dòng (mã, tên) với danh mục. Kết quả cùng thứ tự với `rows`. */
export function matchImportRows(rows: { code: string; name: string }[], catalog: ImportItem[]): ImportMatch[] {
  const byCode = new Map<string, ImportItem>()
  const byBarcode = new Map<string, ImportItem | null>() // null = mã vạch trùng nhiều mặt hàng
  for (const it of catalog) {
    byCode.set(it.itemCode.trim().toLowerCase(), it)
    const bc = (it.barcode ?? '').trim().toLowerCase()
    if (bc) byBarcode.set(bc, byBarcode.has(bc) ? null : it)
  }
  // Bigram tên danh mục chỉ tính khi thật sự cần khớp theo tên (thường rất ít dòng)
  let nameIndex: { item: ImportItem; g: NameGrams }[] | null = null
  const getNameIndex = () => (nameIndex ??= catalog.map((item) => ({ item, g: grams(item.itemName) })))

  return rows.map(({ code, name }) => {
    const key = code.trim().toLowerCase()
    const direct = key ? byCode.get(key) : undefined
    const viaBarcode = !direct && key ? byBarcode.get(key) : undefined
    const hit = direct ?? viaBarcode ?? null
    if (hit) {
      const nameMismatch = Boolean(name) && nameSimilarity(name, hit.itemName) < MISMATCH_MAX
      return { kind: direct ? 'code' : 'barcode', item: hit, candidates: [], nameMismatch }
    }
    if (!name) return { kind: 'none', item: null, candidates: [], nameMismatch: false }
    const q = grams(name)
    const candidates = getNameIndex()
      .map(({ item, g }) => ({ item, score: score(q, g) }))
      .filter((c) => c.score >= SUGGEST_MIN)
      .sort((a, b) => b.score - a.score || a.item.itemCode.localeCompare(b.item.itemCode))
      .slice(0, 3)
    if (candidates.length === 0) return { kind: 'none', item: null, candidates: [], nameMismatch: false }
    const [best, second] = candidates
    const autoPick = best.score >= AUTO_PICK_MIN && (!second || best.score - second.score >= AUTO_PICK_GAP)
    return { kind: 'name', item: autoPick ? best.item : null, candidates, nameMismatch: false }
  })
}
