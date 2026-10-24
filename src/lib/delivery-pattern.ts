// ============================================================
// THÓI QUEN GIAO HÀNG CỦA KHÁCH — suy từ lịch sử đơn (không cần bảng tuyến):
// thứ trong tuần hay giao, số ngày giao sau ngày đặt, kho hay xuất.
// Form tạo đơn dùng để gợi ý ngày giao + kho, người dùng bấm áp dụng.
// ============================================================

export interface PatternOrder {
  docDate: Date | string
  docDueDate: Date | string
  warehouseCode?: string | null
}

export interface DeliveryPattern {
  /** Số đơn dùng để suy luận */
  sample: number
  /** Thứ hay giao (0 = CN … 6 = T7), xếp T2 → CN */
  weekdays: number[]
  /** Số ngày giao sau ngày chứng từ (trung vị) */
  leadDays: number
  /** Kho xuất chiếm ≥ 50% số đơn; null nếu không rõ */
  warehouseCode: string | null
}

const DAY = 86_400_000
const ymd = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10)
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)
const weekOrder = (d: number) => (d === 0 ? 7 : d)

export const WEEKDAY_VN = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

export function deliveryPattern(orders: PatternOrder[], minSample = 2): DeliveryPattern | null {
  const rows = orders
    .map((o) => ({ doc: ymd(o.docDate), due: ymd(o.docDueDate), wh: o.warehouseCode?.trim() || '' }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.doc) && /^\d{4}-\d{2}-\d{2}$/.test(r.due))
  if (rows.length < minSample) return null

  const dayCount = new Map<number, number>()
  const leads: number[] = []
  const whCount = new Map<string, number>()
  for (const r of rows) {
    const due = utc(r.due)
    dayCount.set(due.getUTCDay(), (dayCount.get(due.getUTCDay()) ?? 0) + 1)
    leads.push(Math.max(0, Math.round((due.getTime() - utc(r.doc).getTime()) / DAY)))
    if (r.wh) whCount.set(r.wh, (whCount.get(r.wh) ?? 0) + 1)
  }
  const weekdays = [...dayCount]
    .filter(([, n]) => n / rows.length >= 0.25)
    .map(([d]) => d)
    .sort((a, b) => weekOrder(a) - weekOrder(b))
  leads.sort((a, b) => a - b)
  const leadDays = leads[Math.floor((leads.length - 1) / 2)]
  const [topWh] = [...whCount].sort((a, b) => b[1] - a[1])
  return {
    sample: rows.length,
    weekdays,
    leadDays,
    warehouseCode: topWh && topWh[1] / rows.length >= 0.5 ? topWh[0] : null,
  }
}

/** Ngày giao gợi ý: sớm nhất ≥ ngày chứng từ + leadDays, rơi vào thứ hay giao
 *  (không có thứ nào nổi bật → chỉ tránh Chủ nhật). yyyy-mm-dd */
export function suggestDueDate(docDate: string, p: DeliveryPattern): string {
  const start = utc(docDate.slice(0, 10)).getTime() + p.leadDays * DAY
  for (let i = 0; i < 14; i++) {
    const d = new Date(start + i * DAY)
    const wd = d.getUTCDay()
    if (p.weekdays.length ? p.weekdays.includes(wd) : wd !== 0) return d.toISOString().slice(0, 10)
  }
  return new Date(start).toISOString().slice(0, 10)
}
