import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import {
  AR_BUCKETS,
  BALANCE_EPS,
  bucketOf,
  computeDueDate,
  daysOverdueOf,
  round2,
  startOfUtcDay,
  type BucketKey,
} from '@/lib/ar-aging'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapArDocs, isOnSap, type SapArDoc } from '@/lib/sap-ar-report'

// GET /api/reports/ar-aging
// CÔNG NỢ PHẢI THU theo chuẩn SAP B1:
//  - Công nợ ròng theo khách hàng = Σ(Hóa đơn bán hàng: grandTotal − paidAmount)
//    − Σ(Phiếu ghi có: grandTotal − paidAmount)
//  - Hóa đơn đặt cọc là khoản tạm ứng (liability) — KHÔNG trừ vào công nợ;
//    hiển thị riêng section "Tạm ứng chưa áp dụng" (remainingAmount > 0)
//  - Ngày đáo hạn từng chứng từ = docDate + số ngày ĐKTT (PaymentTerm.days,
//    chuẩn SAP B1: DueDate = StartFrom + ExtraMonth + ExtraDays); không có
//    ĐKTT → fallback docDueDate đã lưu
//  - Aging buckets tính theo ngày đáo hạn: chưa đến hạn | 1–30 | 31–60 |
//    61–90 | > 90 ngày quá hạn
//  - Nguồn: HĐ/ghi có CÒN MỞ trên SAP B1 (chỉ đọc; số dư = DocTotal − PaidToDate,
//    đáo hạn = DocDueDate của SAP) + chứng từ local CHƯA lên SAP. SAP lỗi →
//    chỉ số liệu local kèm sapWarning. Tạm ứng vẫn lấy local.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions?.arAgingReport?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem Công nợ phải thu' }, { status: 403 })
  }

  // B1: cách ly DB (giống /api/stats) — kèm chứng từ NULL sapDatabaseId
  const dbScope = user.databaseId ? { OR: [{ sapDatabaseId: user.databaseId }, { sapDatabaseId: "" }, { sapDatabaseId: null }] } : {}

  try {
    // Map ĐKTT: paymentGroupCode → số ngày (PaymentTerm.code unique toàn cục)
    const terms = await prisma.paymentTerm.findMany({ select: { code: true, days: true } })
    const termDays = new Map<number, number>()
    for (const t of terms) termDays.set(t.code, t.days ?? 0)

    const docSelect = {
      id: true,
      docNum: true,
      cardCode: true,
      cardName: true,
      docDate: true,
      docDueDate: true,
      paymentGroupCode: true,
      grandTotal: true,
      paidAmount: true,
      sapSyncStatus: true,
      sapDocEntry: true,
    } as const
    const docWhere = { ...dbScope, status: { not: 'Cancelled' }, isDraft: { not: true } }

    const [invoices, creditMemos, downPayments] = await Promise.all([
      prisma.arInvoice.findMany({ where: docWhere, select: docSelect, orderBy: { docDate: 'asc' } }),
      prisma.arCreditMemo.findMany({ where: docWhere, select: docSelect, orderBy: { docDate: 'asc' } }),
      // Tạm ứng chưa áp: còn remainingAmount > 0 (Decimal → Number)
      prisma.arDownPayment.findMany({
        where: docWhere,
        select: {
          id: true,
          docNum: true,
          cardCode: true,
          cardName: true,
          docDate: true,
          grandTotal: true,
          remainingAmount: true,
        },
        orderBy: { docDate: 'asc' },
      }),
    ])

    const newBuckets = (): Record<BucketKey, { total: number; count: number }> => ({
      notDue: { total: 0, count: 0 },
      d1_30: { total: 0, count: 0 },
      d31_60: { total: 0, count: 0 },
      d61_90: { total: 0, count: 0 },
      over90: { total: 0, count: 0 },
    })
    const bucketTotals = newBuckets()
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

    interface DocRow {
      id: string
      docType: 'invoice' | 'creditMemo'
      docNum: number | null
      cardCode: string
      cardName: string
      docDate: string
      dueDate: string
      termDays: number | null
      grandTotal: number
      paidAmount: number
      balance: number
      daysOverdue: number
      bucket: BucketKey
    }
    const rows: DocRow[] = []

    const addDoc = (
      docType: 'invoice' | 'creditMemo',
      d: {
        id: string; docNum: number | null; cardCode: string; cardName: string
        docDate: Date; docDueDate: Date; paymentGroupCode: number | null
        grandTotal: number | null; paidAmount: number | null
      },
    ) => {
      const balance = round2((d.grandTotal ?? 0) - (d.paidAmount ?? 0))
      if (balance <= BALANCE_EPS) return // đã thanh toán/ghi giảm hết
      const sign = docType === 'invoice' ? 1 : -1 // ghi có ghi GIẢM nợ
      const net = round2(sign * balance)

      // Ngày đáo hạn theo ĐKTT (chuẩn SAP B1); không có ĐKTT → docDueDate
      const days = d.paymentGroupCode != null ? termDays.get(d.paymentGroupCode) ?? null : null
      const due = computeDueDate(d.docDate, days) ?? startOfUtcDay(new Date(d.docDueDate))
      const overdue = daysOverdueOf(due)
      const bucket = bucketOf(overdue)

      bucketTotals[bucket].total = round2(bucketTotals[bucket].total + net)
      bucketTotals[bucket].count += 1

      const c = custMap.get(d.cardCode) ?? {
        cardCode: d.cardCode, cardName: d.cardName, total: 0, count: 0,
        notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, over90: 0,
      }
      c.total = round2(c.total + net)
      c.count += 1
      c[bucket] = round2(c[bucket] + net)
      custMap.set(d.cardCode, c)

      rows.push({
        id: d.id,
        docType,
        docNum: d.docNum,
        cardCode: d.cardCode,
        cardName: d.cardName,
        docDate: new Date(d.docDate).toISOString(),
        dueDate: due.toISOString(),
        termDays: days,
        grandTotal: d.grandTotal ?? 0,
        paidAmount: d.paidAmount ?? 0,
        balance: net,
        daysOverdue: overdue,
        bucket,
      })
    }

    // Chứng từ SAP còn mở (chỉ đọc) — gộp với chứng từ local chưa lên SAP
    let sapWarning: string | undefined
    let invList = invoices
    let cmList = creditMemos
    let sapInv: SapArDoc[] = []
    let sapCm: SapArDoc[] = []
    const s = await loadSapSettings(user.databaseId)
    if (isSapConfigured(s)) {
      const [ri, rc] = await Promise.all([
        fetchSapArDocs(s, 'Invoices', { openOnly: true }),
        fetchSapArDocs(s, 'CreditNotes', { openOnly: true }),
      ])
      if (ri.ok && rc.ok) {
        sapInv = ri.docs
        sapCm = rc.docs
        invList = invoices.filter((d) => !isOnSap(d))
        cmList = creditMemos.filter((d) => !isOnSap(d))
      } else {
        const err = !ri.ok ? ri.error : !rc.ok ? rc.error : ''
        sapWarning = `Chưa lấy được công nợ từ SAP B1 (${err}) — đang hiển thị số liệu trong ứng dụng.`
      }
    }
    // SAP đã tính DocDueDate theo ĐKTT → paymentGroupCode null để dùng thẳng DocDueDate
    const fromSap = (d: SapArDoc, prefix: string) => ({
      id: `${prefix}-${d.docEntry}`, docNum: d.docNum, cardCode: d.cardCode, cardName: d.cardName,
      docDate: new Date(`${d.docDate}T00:00:00.000Z`), docDueDate: new Date(`${d.docDueDate}T00:00:00.000Z`),
      paymentGroupCode: null, grandTotal: d.docTotal, paidAmount: d.paidToDate,
    })
    for (const d of sapInv) addDoc('invoice', fromSap(d, 'sap-inv'))
    for (const d of sapCm) addDoc('creditMemo', fromSap(d, 'sap-cm'))
    for (const inv of invList) addDoc('invoice', inv)
    for (const cm of cmList) addDoc('creditMemo', cm)

    // Section riêng: tạm ứng chưa áp (không trừ vào công nợ — đúng SAP B1)
    const unapplied = downPayments
      .map((dp) => ({ ...dp, remaining: round2(Number(dp.remainingAmount ?? 0)) }))
      .filter((dp) => dp.remaining > BALANCE_EPS)
      .map((dp) => ({
        id: dp.id,
        docNum: dp.docNum,
        cardCode: dp.cardCode,
        cardName: dp.cardName,
        docDate: new Date(dp.docDate).toISOString(),
        grandTotal: dp.grandTotal ?? 0,
        remainingAmount: dp.remaining,
      }))

    rows.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
    const customers = [...custMap.values()]
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))

    const grandTotal = round2(rows.reduce((s, r) => s + r.balance, 0))

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      grandTotal,
      invoiceCount: sapInv.length + invList.length,
      creditMemoCount: sapCm.length + cmList.length,
      sapInvoiceCount: sapInv.length,
      sapCreditMemoCount: sapCm.length,
      ...(sapWarning ? { sapWarning } : {}),
      openDocCount: rows.length,
      buckets: AR_BUCKETS.map((b) => ({
        key: b.key,
        label: b.label,
        total: bucketTotals[b.key].total,
        count: bucketTotals[b.key].count,
      })),
      customers,
      // Chi tiết: cả hóa đơn và phiếu ghi có (docType phân biệt; balance của
      // ghi có là số âm = ghi giảm nợ)
      documents: rows,
      // Tương thích ngược với UI cũ
      invoices: rows,
      // Tạm ứng chưa áp dụng (section riêng)
      downPayments: unapplied,
      unappliedTotal: round2(unapplied.reduce((s, d) => s + d.remainingAmount, 0)),
    })
  } catch (e) {
    console.error('[ar-aging]', e)
    return NextResponse.json({ error: 'Không tính được báo cáo công nợ' }, { status: 500 })
  }
}
