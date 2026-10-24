import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|week|month
// Phase 3 — BÁO CÁO BÁN HÀNG: aggregate từ DB local (Prisma).
//
// LƯU Ý CONTRACT (WORKER A triển khai song song):
// - Bộ lọc nháp dùng ArInvoice.isDraft / SalesOrder.isDraft / Delivery.isDraft
//   và loại hóa đơn ArInvoice.docType — các field này thuộc schema Phase 2.
//   Để tsc không phụ thuộc thứ tự hoàn thành, truy vấn qua (prisma as any).
// - Chưa có schema Phase 2 → trả 503 với thông báo rõ ràng (thay vì 500 khó hiểu).
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions?.salesReport?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem Báo cáo bán hàng' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const groupBy = sp.get('groupBy') === 'week' ? 'week' : sp.get('groupBy') === 'month' ? 'month' : 'day'

  const today = new Date()
  const end = sp.get('to') ? new Date(`${sp.get('to')}T23:59:59.999Z`) : new Date(today)
  if (sp.get('to')) end.setUTCHours(23, 59, 59, 999)
  const start = sp.get('from')
    ? new Date(`${sp.get('from')}T00:00:00.000Z`)
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 29))

  // B1: cách ly DB (giống /api/stats) — kèm chứng từ NULL sapDatabaseId
  const dbScope = user.databaseId ? { OR: [{ sapDatabaseId: user.databaseId }, { sapDatabaseId: "" }, { sapDatabaseId: null }] } : {}
  const anyPrisma = prisma as any

  try {
    // ---- Hóa đơn trong khoảng (loại hủy + loại nháp) kèm dòng hàng ----
    const invoices = await anyPrisma.arInvoice.findMany({
      where: {
        ...dbScope,
        docDate: { gte: start, lte: end },
        status: { not: 'Cancelled' },
        isDraft: { not: true },
      },
      select: {
        id: true,
        docNum: true,
        cardCode: true,
        cardName: true,
        docDate: true,
        docType: true,
        grandTotal: true,
        createdBy: true,
        lines: { select: { itemCode: true, itemName: true, quantity: true, grandTotal: true } },
      },
      orderBy: { docDate: 'asc' },
    })

    // ---- Gom theo kỳ (day / week / month) ----
    const pad = (n: number) => String(n).padStart(2, '0')
    const bucketOf = (d: Date) => {
      const dt = new Date(d)
      if (groupBy === 'month') {
        const key = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`
        return { key, label: `${pad(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}` }
      }
      if (groupBy === 'week') {
        const dow = (dt.getUTCDay() + 6) % 7 // Thứ 2 = đầu tuần
        const monday = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate() - dow))
        return {
          key: monday.toISOString().slice(0, 10),
          label: `Tuần ${pad(monday.getUTCDate())}/${pad(monday.getUTCMonth() + 1)}`,
        }
      }
      return { key: dt.toISOString().slice(0, 10), label: `${pad(dt.getUTCDate())}/${pad(dt.getUTCMonth() + 1)}` }
    }
    const buckets = new Map<string, { label: string; total: number; count: number }>()
    for (const inv of invoices) {
      const b = bucketOf(new Date(inv.docDate))
      const cur = buckets.get(b.key) ?? { label: b.label, total: 0, count: 0 }
      cur.total += inv.grandTotal ?? 0
      cur.count += 1
      buckets.set(b.key, cur)
    }
    const revenueByPeriod = [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, v]) => ({ key, label: v.label, total: Math.round(v.total), count: v.count }))

    // ---- Top 10 mặt hàng / khách hàng / nhân viên ----
    const itemMap = new Map<string, { itemCode: string; itemName: string; quantity: number; total: number }>()
    for (const inv of invoices) {
      for (const l of inv.lines ?? []) {
        const cur = itemMap.get(l.itemCode) ?? { itemCode: l.itemCode, itemName: l.itemName, quantity: 0, total: 0 }
        cur.quantity += l.quantity ?? 0
        cur.total += l.grandTotal ?? 0
        itemMap.set(l.itemCode, cur)
      }
    }
    const topItems = [...itemMap.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map((x) => ({ ...x, total: Math.round(x.total), quantity: Math.round(x.quantity * 100) / 100 }))

    const custMap = new Map<string, { cardCode: string; cardName: string; total: number; count: number }>()
    const staffMap = new Map<string, { createdBy: string; total: number; count: number }>()
    for (const inv of invoices) {
      const c = custMap.get(inv.cardCode) ?? { cardCode: inv.cardCode, cardName: inv.cardName, total: 0, count: 0 }
      c.total += inv.grandTotal ?? 0
      c.count += 1
      custMap.set(inv.cardCode, c)
      const who = inv.createdBy ?? '(không rõ)'
      const s = staffMap.get(who) ?? { createdBy: who, total: 0, count: 0 }
      s.total += inv.grandTotal ?? 0
      s.count += 1
      staffMap.set(who, s)
    }
    const topCustomers = [...custMap.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map((x) => ({ ...x, total: Math.round(x.total) }))
    const topStaff = [...staffMap.values()]
      .sort((a, b) => b.total - a.total)
      .map((x) => ({ ...x, total: Math.round(x.total) }))

    // ---- Đơn hàng mở quá hạn (docDueDate < hôm nay) ----
    const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
    const overdueOrders = await anyPrisma.salesOrder.findMany({
      where: { ...dbScope, status: 'Open', docDueDate: { lt: todayStart }, isDraft: { not: true } },
      select: { id: true, docNum: true, cardCode: true, cardName: true, docDate: true, docDueDate: true, grandTotal: true },
      orderBy: { docDueDate: 'asc' },
      take: 20,
    })
    const openOverdueOrders = overdueOrders.map((o: any) => ({
      ...o,
      daysOverdue: Math.floor((todayStart.getTime() - new Date(o.docDueDate).getTime()) / 86400000),
    }))

    // ---- Hiệu suất giao hàng: đúng hạn = delivery.docDate <= order.docDueDate ----
    const deliveries = await anyPrisma.delivery.findMany({
      where: { ...dbScope, docDate: { gte: start, lte: end }, status: { not: 'Cancelled' }, isDraft: { not: true }, sourceOrderId: { not: null } },
      select: { docDate: true, sourceOrder: { select: { docDueDate: true } } },
    })
    let onTime = 0
    let late = 0
    for (const d of deliveries) {
      const due = d.sourceOrder?.docDueDate ? new Date(d.sourceOrder.docDueDate) : null
      if (!due) continue
      const dayOf = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
      if (dayOf(new Date(d.docDate)) <= dayOf(due)) onTime++
      else late++
    }
    const deliveryPerf = {
      total: onTime + late,
      onTime,
      late,
      onTimePct: onTime + late > 0 ? Math.round((onTime / (onTime + late)) * 1000) / 10 : 0,
    }

    const totalRevenue = invoices.reduce((s: number, i: any) => s + (i.grandTotal ?? 0), 0)
    return NextResponse.json({
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      groupBy,
      invoiceCount: invoices.length,
      totalRevenue: Math.round(totalRevenue),
      revenueByPeriod,
      topItems,
      topCustomers,
      topStaff,
      openOverdueOrders,
      deliveryPerf,
    })
  } catch (e) {
    // Schema Phase 2 (isDraft/docType) chưa có → Prisma ném lỗi field không tồn tại
    return NextResponse.json(
      { error: 'Báo cáo bán hàng cần schema Phase 2 (trường isDraft/docType) — đang chờ backend hoàn tất' },
      { status: 503 },
    )
  }
}
