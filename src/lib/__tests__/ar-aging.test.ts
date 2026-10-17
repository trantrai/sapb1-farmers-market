// ============================================================
// Test logic công nợ phải thu chuẩn SAP B1 — xem @/lib/ar-aging:
// - bucketOf: phân nhóm tuổi nợ theo ngày quá hạn
// - computeDueDate: DueDate = docDate + số ngày ĐKTT
//   (chuẩn SAP B1: StartFrom + NumberOfAdditionalMonths + NumberOfAdditionalDays)
// - daysOverdueOf: số ngày quá hạn theo đầu ngày UTC
// Test thuần (không chạm DB), luôn chạy trong `npx vitest run`.
// ============================================================
import { describe, expect, it } from 'vitest'
import {
  bucketOf,
  computeDueDate,
  daysOverdueOf,
  round2,
  startOfUtcDay,
} from '@/lib/ar-aging'

describe('bucketOf — phân nhóm tuổi nợ', () => {
  it('chưa đến hạn khi daysOverdue <= 0', () => {
    expect(bucketOf(-5)).toBe('notDue')
    expect(bucketOf(0)).toBe('notDue')
  })
  it('1–30 / 31–60 / 61–90 / > 90', () => {
    expect(bucketOf(1)).toBe('d1_30')
    expect(bucketOf(30)).toBe('d1_30')
    expect(bucketOf(31)).toBe('d31_60')
    expect(bucketOf(60)).toBe('d31_60')
    expect(bucketOf(61)).toBe('d61_90')
    expect(bucketOf(90)).toBe('d61_90')
    expect(bucketOf(91)).toBe('over90')
  })
})

describe('computeDueDate — ngày đáo hạn theo ĐKTT (chuẩn SAP B1)', () => {
  it('docDate + số ngày ĐKTT', () => {
    const due = computeDueDate(new Date('2026-10-01T00:00:00Z'), 30)
    expect(due?.toISOString().slice(0, 10)).toBe('2026-10-31')
  })
  it('ĐKTT 0 ngày = đáo hạn ngay ngày chứng từ', () => {
    const due = computeDueDate(new Date('2026-10-01T00:00:00Z'), 0)
    expect(due?.toISOString().slice(0, 10)).toBe('2026-10-01')
  })
  it('không có ĐKTT (null/undefined) → null để fallback docDueDate', () => {
    expect(computeDueDate(new Date('2026-10-01T00:00:00Z'), null)).toBeNull()
    expect(computeDueDate(new Date('2026-10-01T00:00:00Z'), undefined)).toBeNull()
  })
  it('cộng vượt tháng/năm đúng lịch', () => {
    const due = computeDueDate(new Date('2026-01-31T00:00:00Z'), 30)
    expect(due?.toISOString().slice(0, 10)).toBe('2026-03-02')
  })
})

describe('daysOverdueOf — số ngày quá hạn', () => {
  it('quá hạn 10 ngày', () => {
    expect(daysOverdueOf(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-11T12:00:00Z'))).toBe(10)
  })
  it('chưa đến hạn → số âm', () => {
    expect(daysOverdueOf(new Date('2026-10-20T00:00:00Z'), new Date('2026-10-11T00:00:00Z'))).toBe(-9)
  })
  it('cùng ngày → 0', () => {
    expect(daysOverdueOf(new Date('2026-10-11T00:00:00Z'), new Date('2026-10-11T23:59:00Z'))).toBe(0)
  })
})

describe('startOfUtcDay — chuẩn hóa đầu ngày UTC', () => {
  it('bỏ phần giờ, giữ ngày UTC', () => {
    expect(startOfUtcDay(new Date('2026-10-11T23:59:59Z')).toISOString()).toBe('2026-10-11T00:00:00.000Z')
  })
})

describe('round2 — làm tròn 2 chữ số', () => {
  it('làm tròn đúng', () => {
    expect(round2(100.005)).toBe(100.01)
    expect(round2(100.004)).toBe(100)
  })
})
