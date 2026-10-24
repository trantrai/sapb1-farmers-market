import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { BALANCE_EPS, round2 } from '@/lib/ar-aging'

// GET /api/dashboard/ar-widgets — số liệu 2 widget mới của dashboard (Phase 3):
// - "Hóa đơn chờ thanh toán": công nợ RÒNG theo chuẩn SAP B1 =
//   Σ(hóa đơn: grandTotal − paidAmount) − Σ(phiếu ghi có: grandTotal − paidAmount)
//   (loại hủy + loại nháp)
// - "Tạm ứng chưa áp": Σ(đặt cọc còn remainingAmount > 0) — hiển thị riêng,
//   không trừ vào công nợ (đúng SAP B1: down payment là liability)
// - "Báo giá chờ duyệt": số Quotation status 'Open' (loại nháp)
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const dbScope = user.databaseId ? { OR: [{ sapDatabaseId: user.databaseId }, { sapDatabaseId: "" }, { sapDatabaseId: null }] } : {}

  try {
    const [invoices, creditMemos, downPayments] = await Promise.all([
      prisma.arInvoice.findMany({
        where: { ...dbScope, status: { not: 'Cancelled' }, isDraft: { not: true } },
        select: { grandTotal: true, paidAmount: true },
      }),
      prisma.arCreditMemo.findMany({
        where: { ...dbScope, status: { not: 'Cancelled' }, isDraft: { not: true } },
        select: { grandTotal: true, paidAmount: true },
      }),
      prisma.arDownPayment.findMany({
        where: { ...dbScope, status: { not: 'Cancelled' }, isDraft: { not: true } },
        select: { remainingAmount: true },
      }),
    ])

    let unpaidTotal = 0
    let unpaidCount = 0
    for (const inv of invoices) {
      const balance = (inv.grandTotal ?? 0) - (inv.paidAmount ?? 0)
      if (balance > BALANCE_EPS) {
        unpaidTotal += balance
        unpaidCount += 1
      }
    }
    // Phiếu ghi có ghi GIẢM nợ (chuẩn SAP B1)
    for (const cm of creditMemos) {
      const balance = (cm.grandTotal ?? 0) - (cm.paidAmount ?? 0)
      if (balance > BALANCE_EPS) unpaidTotal -= balance
    }

    let unappliedTotal = 0
    let unappliedCount = 0
    for (const dp of downPayments) {
      const rem = Number(dp.remainingAmount ?? 0)
      if (rem > BALANCE_EPS) {
        unappliedTotal += rem
        unappliedCount += 1
      }
    }

    const openQuotationCount = await prisma.quotation.count({
      where: { ...dbScope, status: 'Open', isDraft: { not: true } },
    })

    return NextResponse.json({
      unpaidTotal: round2(unpaidTotal),
      unpaidCount,
      unappliedTotal: round2(unappliedTotal),
      unappliedCount,
      openQuotationCount,
    })
  } catch (e) {
    console.error('[dashboard/ar-widgets]', e)
    return NextResponse.json({ error: 'Không tính được số liệu widget công nợ' }, { status: 500 })
  }
}
