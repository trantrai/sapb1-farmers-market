// ============================================================
// KIỂM TRA ĐƠN TRỰC TIẾP — gom MỌI vấn đề (chạy lại mỗi khi form đổi).
// error = phải sửa mới lưu được; warning = hiển thị ở vùng "Kiểm tra đơn",
// người dùng có thể bỏ qua và vẫn lưu (không hộp xác nhận).
// insights (lịch sử khách từ /api/orders/insights) bổ sung: đơn trùng,
// số lượng bất thường, giá lệch lần bán trước.
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
  uom?: string | null
}

/** Lịch sử mua 1 mặt hàng của khách (tính ở server — order-insights) */
export interface ItemHistoryStat {
  /** Số đơn đã mua mặt hàng */
  samples: number
  /** Trung vị số lượng mỗi đơn */
  medianQty: number
  /** Đơn vị tính của lần mua gần nhất (khác đơn vị dòng → không so số lượng) */
  uom: string | null
  /** Đơn giá lần bán gần nhất (> 0) */
  lastPrice: number | null
  /** yyyy-mm-dd lần bán gần nhất */
  lastDate: string | null
}

export interface DuplicateOrderHit {
  id: string
  docNum: number | null
  isDraft: boolean
  /** Số mặt hàng trùng / tổng mặt hàng (lớn hơn giữa 2 đơn); 0/0 = đơn đang nhập chưa có dòng */
  overlap: number
  total: number
}

export interface OrderInsights {
  duplicates: DuplicateOrderHit[]
  items: Record<string, ItemHistoryStat>
}

/** Ngưỡng cảnh báo — xuất ra để test và hiển thị */
export const PRECHECK_THRESHOLDS = {
  /** Số đơn lịch sử tối thiểu để so số lượng */
  qtyMinSamples: 3,
  /** Gấp bao nhiêu lần trung vị (hoặc nhỏ hơn 1/x) thì cảnh báo */
  qtyFactor: 3,
  /** Lệch giá so với lần bán trước (tỷ lệ) */
  priceChangePct: 0.1,
} as const

export interface PrecheckInput {
  hasPartner: boolean
  lines: PrecheckLine[]
  /** yyyy-mm-dd */
  docDate: string
  /** yyyy-mm-dd — ngày giao hàng */
  docDueDate: string
  /** yyyy-mm-dd — hôm nay (giờ VN), truyền vào để test được */
  today: string
  insights?: OrderInsights | null
}

export interface PrecheckIssue {
  level: 'error' | 'warning'
  code:
    | 'no-partner' | 'no-lines' | 'qty' | 'neg-price' | 'due-before-doc' | 'atp' | 'below-price' | 'duplicate'
    | 'due-past' | 'due-sunday' | 'dup-order' | 'qty-anomaly' | 'price-change'
  message: string
  /** Dòng liên quan (để nhảy tới) */
  lineKey?: number
  /** Khóa ổn định để "Bỏ qua" — đổi giá trị (SL/giá/ngày) thì khóa đổi, cảnh báo hiện lại */
  key: string
  /** Đơn trùng (dup-order) — để mở đơn đó */
  orderId?: string
}

const fmt = (n: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(n)
const vnd = (n: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₫'
const dmy = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/')

export function precheckOrder(input: PrecheckInput): PrecheckIssue[] {
  const out: PrecheckIssue[] = []
  const issues = {
    push(i: Omit<PrecheckIssue, 'key'> & { key?: string }) {
      out.push({ ...i, key: i.key ?? `${i.code}:${i.lineKey ?? ''}` })
    },
  }
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
        level: 'warning', code: 'atp', lineKey: l.key, key: `atp:${l.key}:${l.quantity}`,
        message: `${name}: thiếu hàng — đặt ${fmt(l.quantity)}, khả dụng ${fmt(Math.max(0, l.atpAvailable))}${l.warehouseCode ? ` (kho ${l.warehouseCode})` : ''}`,
      })
    }
    if (!l.isBomChild && typeof l.refPrice === 'number' && l.refPrice > 0 && l.unitPrice < l.refPrice - 0.5) {
      const pct = Math.round(((l.refPrice - l.unitPrice) / l.refPrice) * 100)
      issues.push({
        level: 'warning', code: 'below-price', lineKey: l.key, key: `below-price:${l.key}:${l.unitPrice}`,
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
    issues.push({ level: 'warning', code: 'due-past', key: `due-past:${due}`, message: `Ngày giao ${dmy(due)} đã qua` })
  }
  if (due && new Date(`${due}T00:00:00Z`).getUTCDay() === 0) {
    issues.push({ level: 'warning', code: 'due-sunday', key: `due-sunday:${due}`, message: `Ngày giao ${dmy(due)} là Chủ nhật` })
  }
  if (input.insights) insightIssues(input, lines, issues)

  // Lỗi trước, cảnh báo sau
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
}

const pctTxt = (r: number) => `${r > 0 ? '+' : '−'}${Math.round(Math.abs(r) * 100)}%`

function insightIssues(
  input: PrecheckInput,
  lines: PrecheckLine[],
  issues: { push(i: Omit<PrecheckIssue, 'key'> & { key?: string }): void },
) {
  const ins = input.insights!
  const due = input.docDueDate.slice(0, 10)
  for (const d of ins.duplicates) {
    const label = d.docNum ? `#${d.docNum}` : d.isDraft ? 'nháp' : 'chưa có số'
    const detail = d.total > 0 ? ` — trùng ${d.overlap}/${d.total} mặt hàng` : ''
    issues.push({
      level: 'warning', code: 'dup-order', orderId: d.id, key: `dup-order:${d.id}:${due}`,
      message: `Đã có đơn ${label} cùng khách, cùng ngày giao ${dmy(due)}${detail}`,
    })
  }
  const T = PRECHECK_THRESHOLDS
  for (const l of lines) {
    if (l.isBomChild || !l.itemCode || !(l.quantity > 0)) continue
    const st = ins.items[l.itemCode]
    if (!st) continue
    const name = `${l.itemCode}${l.itemName ? ` — ${l.itemName}` : ''}`
    const sameUom = !st.uom || !l.uom || st.uom.trim().toLowerCase() === l.uom.trim().toLowerCase()
    if (sameUom && st.samples >= T.qtyMinSamples && st.medianQty > 0) {
      const ratio = l.quantity / st.medianQty
      if (ratio >= T.qtyFactor || ratio <= 1 / T.qtyFactor) {
        const u = l.uom ? ` ${l.uom}` : ''
        issues.push({
          level: 'warning', code: 'qty-anomaly', lineKey: l.key, key: `qty-anomaly:${l.key}:${l.quantity}`,
          message: `${name}: đặt ${fmt(l.quantity)}${u} — khách thường đặt ~${fmt(st.medianQty)}${u} (${st.samples} đơn gần đây)`,
        })
      }
    }
    if (typeof st.lastPrice === 'number' && st.lastPrice > 0) {
      const r = (l.unitPrice - st.lastPrice) / st.lastPrice
      if (Math.abs(r) > T.priceChangePct) {
        issues.push({
          level: 'warning', code: 'price-change', lineKey: l.key, key: `price-change:${l.key}:${l.unitPrice}`,
          message: `${name}: giá ${vnd(l.unitPrice)} lệch ${pctTxt(r)} so với lần bán trước ${vnd(st.lastPrice)}${st.lastDate ? ` (${dmy(st.lastDate)})` : ''}`,
        })
      }
    }
  }
}
