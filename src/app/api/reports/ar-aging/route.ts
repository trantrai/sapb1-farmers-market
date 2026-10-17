import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/reports/ar-aging
// Phase 3 — CÔNG NỢ PHẢI THU (tuổi nợ): aging buckets theo docDueDate và số dư
// (grandTotal − paidAmount) của các hóa đơn chưa thanh toán hết.
//
// LƯU Ý CONTRACT (WORKER A triển khai song song): bộ lọc nháp dùng
// ArInvoice.isDraft (schema Phase 2). Truy vấn qua (prisma as any) để tsc
// không phụ thuộc thứ tự hoàn thành; chưa có schema → 503 rõ ràng.
type BucketKey = 'notDue' | 'd1_30' | 'd31_60' | 'd61_90' | 'over90'

const BUCKETS: { key: BucketKey; label: string }[] = [
  { key: 'notDue', label: 'Chưa đến hạn' },
  { key: 'd1_30', label: 'Quá hạn 1–30 ngày' },
  { key: 'd31_60', label: 'Quá hạn 31–60 ngày' },
  { key: 'd61_90', label: 'Quá hạn 61–90 ngày' },
  { key: 'over90', label: 'Quá hạn > 90 ngày' },
]

function bucketOf(daysOverdue: number): BucketKey {
  if (daysOverdue <= 0) return 'notDue'
  if (daysOverdue <= 30) return 'd1_30'
  if (daysOverdue <= 60) return 'd31_60'
  if (daysOverdue <= 90) return 'd61_90'
  return 'over90'
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions?.arAgingReport?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem Công nợ phải thu' }, { status: 403 })
  }

  // B1: cách ly DB (giống /api/stats)
  const dbScope = user.databaseId ? { sapDatabaseId: user.databaseId } : {}
  const anyPrisma = prisma as any

  try {
    const invoices = await anyPrisma.arInvoice.findMany({
      where: { ...dbScope, status: { not: 'Cancelled' }, isDraft: { not: true } },
      select: {
        id: true,
        docNum: true,
        cardCode: true,
        cardName: true,
        docDate: true,
        docDueDate: true,
        grandTotal: true,
        paidAmount: true,
        paymentStatus: true,
      },
      orderBy: { docDueDate: 'asc' },
    })

    const now = new Date()
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

    const bucketTotals: Record<BucketKey, { total: number; count: number }> = {
      notDue: { total: 0, count: 0 },
      d1_30: { total: 0, count: 0 },
      d31_60: { total: 0, count: 0 },
      d61_90: { total: 0, count: 0 },
      over90: { total: 0, count: 0 },
    }
    const custMap = new Map<string, {
      cardCode: string
      cardName: string
      total: number
      count: number
      notDue: number
      d1_30: number
      d31_60: number
      d61_90: number
      over90: number
    }>()
    const rows: {
      id: string
      docNum: number
      cardCode: string
      cardName: string
      docDate: string
      docDueDate: string
      grandTotal: number
      paidAmount: number
      balance: number
      daysOverdue: number
      bucket: BucketKey
    }[] = []

    for (const inv of invoices) {
      const balance = Math.round(((inv.grandTotal ?? 0) - (inv.paidAmount ?? 0)) * 100) / 100
      if (balance <= 0.5) continue // đã thanh toán hết (dung sai làm tròn)
      const due = new Date(inv.docDueDate)
      const dueStart = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()))
      const daysOverdue = Math.floor((todayStart.getTime() - dueStart.getTime()) / 86400000)
      const bucket = bucketOf(daysOverdue)

      bucketTotals[bucket].total += balance
      bucketTotals[bucket].count += 1

      const c = custMap.get(inv.cardCode) ?? {
        cardCode: inv.cardCode,
        cardName: inv.cardName,
        total: 0,
        count: 0,
        notDue: 0,
        d1_30: 0,
        d31_60: 0,
        d61_90: 0,
        over90: 0,
      }
      c.total += balance
      c.count += 1
      c[bucket] += balance
      custMap.set(inv.cardCode, c)

      rows.push({
        id: inv.id,
        docNum: inv.docNum,
        cardCode: inv.cardCode,
        cardName: inv.cardName,
        docDate: inv.docDate,
        docDueDate: inv.docDueDate,
        grandTotal: inv.grandTotal ?? 0,
        paidAmount: inv.paidAmount ?? 0,
        balance,
        daysOverdue,
        bucket,
      })
    }

    rows.sort((a, b) => b.balance - a.balance)
    const customers = [...custMap.values()]
      .sort((a, b) => b.total - a.total)
      .map((c) => ({ ...c, total: Math.round(c.total * 100) / 100 }))

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      grandTotal: Math.round(rows.reduce((s, r) => s + r.balance, 0) * 100) / 100,
      invoiceCount: rows.length,
      buckets: BUCKETS.map((b) => ({
        key: b.key,
        label: b.label,
        total: Math.round(bucketTotals[b.key].total * 100) / 100,
        count: bucketTotals[b.key].count,
      })),
      customers,
      invoices: rows,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Báo cáo công nợ cần schema Phase 2 (trường isDraft) — đang chờ backend hoàn tất' },
      { status: 503 },
    )
  }
}
