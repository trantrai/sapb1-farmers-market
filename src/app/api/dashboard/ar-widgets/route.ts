import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/dashboard/ar-widgets — số liệu 2 widget mới của dashboard (Phase 3):
// - "Hóa đơn chờ thanh toán": tổng dư nợ = Σ(grandTotal − paidAmount) các hóa đơn
//   chưa thanh toán hết (loại hủy + loại nháp)
// - "Báo giá chờ duyệt": số Quotation status 'Open' (loại nháp)
//
// LƯU Ý CONTRACT (WORKER A triển khai song song): bộ lọc nháp dùng
// ArInvoice.isDraft / Quotation.isDraft (schema Phase 2) → (prisma as any).
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const dbScope = user.databaseId ? { sapDatabaseId: user.databaseId } : {}
  const anyPrisma = prisma as any

  try {
    const invoices = await anyPrisma.arInvoice.findMany({
      where: { ...dbScope, status: { not: 'Cancelled' }, isDraft: { not: true } },
      select: { grandTotal: true, paidAmount: true },
    })
    let unpaidTotal = 0
    let unpaidCount = 0
    for (const inv of invoices) {
      const balance = (inv.grandTotal ?? 0) - (inv.paidAmount ?? 0)
      if (balance > 0.5) {
        unpaidTotal += balance
        unpaidCount += 1
      }
    }

    const openQuotationCount = await anyPrisma.quotation.count({
      where: { ...dbScope, status: 'Open', isDraft: { not: true } },
    })

    return NextResponse.json({
      unpaidTotal: Math.round(unpaidTotal * 100) / 100,
      unpaidCount,
      openQuotationCount,
    })
  } catch (e) {
    return NextResponse.json(
      { error: 'Widget công nợ cần schema Phase 2 (trường isDraft) — đang chờ backend hoàn tất' },
      { status: 503 },
    )
  }
}
