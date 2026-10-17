// ============================================================
// CÔNG NỢ PHẢI THU — logic dùng chung (chuẩn SAP B1)
// - Ngày đáo hạn: DueDate = StartFrom + NumberOfAdditionalMonths +
//   NumberOfAdditionalDays (DI API PaymentTermsTypes; tháng ≈ 30 ngày).
//   Mốc mặc định là ngày chứng từ (docDate); không có ĐKTT → dùng
//   docDueDate đã lưu trên chứng từ.
// - Aging buckets tính theo ngày đáo hạn.
// ============================================================

export type BucketKey = 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'over90'

export const AR_BUCKETS: { key: BucketKey; label: string }[] = [
  { key: 'notDue', label: 'Chưa đến hạn' },
  { key: 'd1_30', label: 'Quá hạn 1–30 ngày' },
  { key: 'd31_60', label: 'Quá hạn 31–60 ngày' },
  { key: 'd61_90', label: 'Quá hạn 61–90 ngày' },
  { key: 'over90', label: 'Quá hạn > 90 ngày' },
]

export function bucketOf(daysOverdue: number): BucketKey {
  if (daysOverdue <= 0) return 'notDue'
  if (daysOverdue <= 30) return 'd1_30'
  if (daysOverdue <= 60) return 'd31_60'
  if (daysOverdue <= 90) return 'd61_90'
  return 'over90'
}

/** Chuẩn hóa về đầu ngày UTC để so sánh tuổi nợ ổn định theo múi giờ */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Tính ngày đáo hạn theo ĐKTT (chuẩn SAP B1): docDate + termDays.
 * @param termDays số ngày của ĐKTT (null = không có ĐKTT → trả null để
 *                 caller fallback về docDueDate đã lưu)
 */
export function computeDueDate(docDate: Date, termDays: number | null | undefined): Date | null {
  if (termDays == null || !Number.isFinite(termDays)) return null
  const base = startOfUtcDay(new Date(docDate))
  base.setUTCDate(base.getUTCDate() + Math.round(termDays))
  return base
}

/** Số ngày quá hạn = hôm nay (UTC) − ngày đáo hạn */
export function daysOverdueOf(dueDate: Date, now: Date = new Date()): number {
  const today = startOfUtcDay(now)
  const due = startOfUtcDay(new Date(dueDate))
  return Math.floor((today.getTime() - due.getTime()) / 86400000)
}

export const round2 = (n: number) => Math.round(n * 100) / 100

/** Dung sai làm tròn khi coi chứng từ đã thanh toán hết */
export const BALANCE_EPS = 0.5
