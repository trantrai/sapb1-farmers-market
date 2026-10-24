// ============================================================
// KIỂM TRA TRƯỚC KHI LƯU ĐƠN — gom MỌI vấn đề 1 lần (thay vì lưu → lỗi →
// sửa → lưu lại). error = phải sửa mới lưu được; warning = vẫn cho lưu
// sau khi người dùng xác nhận.
// ============================================================

export interface PrecheckLine {
  key: number
  itemCode: string | null
  itemName?: string
  quantity: number
  unitPrice: number
  /** Giá tham chiếu (giá đặc biệt OSPP / Price List 1) đã giải khi chọn mặt hàng */
  refPrice?: number | null
  /** 'special' | 'pricelist' | 'manual' */
  priceSource?: string
  isBomChild?: boolean
  warehouseCode?: string | null
  /** Tồn khả dụng (ATP) của kho dòng; null/undefined = chưa kiểm tra được */
  atpAvailable?: number | null
}

export interface PrecheckInput {
  hasPartner: boolean
  lines: PrecheckLine[]
  /** yyyy-mm-dd */
  docDate: string
  /** yyyy-mm-dd — ngày giao hàng */
  docDueDate: string
  /** yyyy-mm-dd — hôm nay (giờ VN), truyền vào để test được */
  today: string
}

export interface PrecheckIssue {
  level: 'error' | 'warning'
  code: 'no-partner' | 'no-lines' | 'qty' | 'neg-price' | 'due-before-doc' | 'atp' | 'below-price' | 'duplicate' | 'due-past' | 'due-sunday'
  message: string
  /** Dòng liên quan (để nhảy tới) */
  lineKey?: number
}

const fmt = (n: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(n)
const vnd = (n: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₫'
const dmy = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')

export function precheckOrder(input: PrecheckInput): PrecheckIssue[] {
  const issues: PrecheckIssue[] = []
  if (!input.hasPartner) issues.push({ level: 'error', code: 'no-partner', message: 'Chưa chọn khách hàng' })

  const lines = input.lines.filter((l) => l.itemCode)
  if (lines.length === 0) issues.push({ level: 'error', code: 'no-lines', message: 'Đơn chưa có dòng hàng nào' })

  const seen = new Map<string, PrecheckLine>()
  for (const l of lines) {
    const name = `${l.itemCode}${l.itemName ? ` — ${l.itemName}` : ''}`
    if (!(l.quantity > 0)) {
      issues.push({ level: 'error', code: 'qty', message: `${name}: số lượng phải lớn hơn 0`, lineKey: l.key })
      continue
    }
    if (l.unitPrice < 0) issues.push({ level: 'error', code: 'neg-price', message: `${name}: đơn giá âm`, lineKey: l.key })
    if (typeof l.atpAvailable === 'number' && l.atpAvailable < l.quantity) {
      issues.push({
        level: 'warning', code: 'atp', lineKey: l.key,
        message: `${name}: thiếu hàng — đặt ${fmt(l.quantity)}, khả dụng ${fmt(Math.max(0, l.atpAvailable))}${l.warehouseCode ? ` (kho ${l.warehouseCode})` : ''}`,
      })
    }
    if (!l.isBomChild && typeof l.refPrice === 'number' && l.refPrice > 0 && l.unitPrice < l.refPrice - 0.5) {
      const pct = Math.round(((l.refPrice - l.unitPrice) / l.refPrice) * 100)
      issues.push({
        level: 'warning', code: 'below-price', lineKey: l.key,
        message: `${name}: giá ${vnd(l.unitPrice)} thấp hơn giá ${l.priceSource === 'special' ? 'đặc biệt của KH' : 'bảng giá'} ${vnd(l.refPrice)} (−${pct}%)`,
      })
    }
    if (!l.isBomChild) {
      const k = `${l.itemCode}|${l.warehouseCode ?? ''}`
      const first = seen.get(k)
      if (first) {
        issues.push({ level: 'warning', code: 'duplicate', lineKey: l.key, message: `${name}: trùng mặt hàng với 1 dòng khác (cùng kho) — có thể gộp số lượng` })
      } else seen.set(k, l)
    }
  }

  const doc = input.docDate.slice(0, 10)
  const due = input.docDueDate.slice(0, 10)
  if (doc && due && due < doc) {
    issues.push({ level: 'error', code: 'due-before-doc', message: `Ngày giao ${dmy(due)} trước ngày chứng từ ${dmy(doc)}` })
  } else if (due && due < input.today.slice(0, 10)) {
    issues.push({ level: 'warning', code: 'due-past', message: `Ngày giao ${dmy(due)} đã qua` })
  }
  if (due && new Date(`${due}T00:00:00Z`).getUTCDay() === 0) {
    issues.push({ level: 'warning', code: 'due-sunday', message: `Ngày giao ${dmy(due)} là Chủ nhật` })
  }
  // Lỗi trước, cảnh báo sau
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
}
