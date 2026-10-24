import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { INSIGHT_LIMITS, loadOrderInsights } from '@/lib/order-insights'
import { db as prisma } from '@/lib/db'
import { historyNeeds, parseOrderCheckConfig } from '@/lib/order-check-config'

// ---------- POST /api/orders/insights ----------
// Body: { cardCode, docDueDate (yyyy-mm-dd), itemCodes[], excludeOrderId? }
// Trả lịch sử khách cho vùng "Kiểm tra đơn": đơn trùng + thống kê SL/giá
// từng mặt hàng. Chỉ đọc DB local (không gọi SAP). POST vì danh sách mã dài.
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view && !user.permissions.ordersNew?.create && !user.permissions.orders?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const cardCode = typeof body?.cardCode === 'string' ? body.cardCode.trim() : ''
  if (!cardCode || cardCode.length > 50) {
    return NextResponse.json({ error: 'Thiếu mã khách hàng (cardCode)' }, { status: 400 })
  }
  const dueRaw = typeof body?.docDueDate === 'string' ? body.docDueDate.slice(0, 10) : ''
  const docDueDate = /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) && !Number.isNaN(Date.parse(dueRaw)) ? dueRaw : null
  const rawCodes = Array.isArray(body?.itemCodes) ? body.itemCodes : []
  if (rawCodes.length > INSIGHT_LIMITS.maxItemCodes) {
    return NextResponse.json({ error: 'Quá nhiều mặt hàng' }, { status: 400 })
  }
  const itemCodes = rawCodes.filter((c): c is string => typeof c === 'string' && c.trim().length > 0 && c.length <= 50).map((c) => c.trim())
  const ex = typeof body?.excludeOrderId === 'string' ? body.excludeOrderId.trim() : ''
  const excludeOrderId = ex && ex.length <= 64 ? ex : null

  // Cảnh báo lịch sử bị tắt trong Cài đặt → không truy vấn phần đó
  const app = await prisma.appSettings.findUnique({ where: { id: 'main' }, select: { orderCheckConfig: true } })
  const needs = historyNeeds(parseOrderCheckConfig(app?.orderCheckConfig ?? ''))
  if (!needs.duplicates && !needs.items) return NextResponse.json({ ok: true, duplicates: [], items: {} })
  const s = await loadSapSettings(user.databaseId)
  const data = await loadOrderInsights(s?.dbId ?? null, { cardCode, docDueDate, itemCodes, excludeOrderId }, new Date(), needs)
  return NextResponse.json({ ok: true, ...data })
}
