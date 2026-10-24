import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { aggregateBasket } from '@/lib/order-basket'

// ---------- GET /api/orders/suggest-items?cardCode=XXX ----------
// "Giỏ hàng quen": mặt hàng khách hay mua trong N ngày (AppSettings) —
// số đơn, SL lần gần nhất, SL trung bình — kèm thông tin mặt hàng HIỆN TẠI
// trong mirror (giá Price List 1, mã thuế, thuế suất, barcode) để form tính lại.
// Bỏ đơn nháp/đơn hủy và dòng con BOM.
// Sắp xếp: số đơn có mặt hàng DESC, tổng số lượng DESC.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view && !user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const cardCode = (req.nextUrl.searchParams.get('cardCode') || '').trim()
  if (!cardCode || cardCode.length > 50) {
    return NextResponse.json({ error: 'Thiếu mã khách hàng (cardCode)' }, { status: 400 })
  }

  // Đọc setting khoảng thời gian + số lượng tối đa
  let settings = await prisma.appSettings.findUnique({ where: { id: 'main' } })
  if (!settings) {
    settings = await prisma.appSettings.create({ data: { id: 'main' } })
  }
  const historyDays = settings.suggestHistoryDays ?? 90
  const maxItems = settings.suggestMaxItems ?? 10
  const fromDate = new Date()
  fromDate.setDate(fromDate.getDate() - historyDays)

  // B1: cách ly DB theo database đăng nhập (kèm đơn cũ chưa gán DB)
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const orders = await prisma.salesOrder.findMany({
    where: {
      cardCode,
      docDate: { gte: fromDate },
      isDraft: false,
      status: { not: 'Cancelled' },
      ...(dbId ? { OR: [{ sapDatabaseId: dbId }, { sapDatabaseId: '' }, { sapDatabaseId: null }] } : {}),
    },
    select: {
      docDate: true,
      lines: {
        where: { isBomChild: false },
        select: { itemCode: true, itemName: true, quantity: true, unitPrice: true, uom: true, taxCode: true, warehouseCode: true },
      },
    },
    orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
  })
  const agg = aggregateBasket(orders, maxItems)

  // Thông tin mặt hàng hiện tại (mirror) + thuế suất theo mã thuế
  const codes = agg.map((a) => a.itemCode)
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}
  const [items, vgRows] = codes.length
    ? await Promise.all([
        prisma.item.findMany({
          where: { ...dbScope, itemCode: { in: codes } },
          select: { itemCode: true, itemName: true, uom: true, price: true, taxCode: true, barcode: true },
        }),
        prisma.vatGroup.findMany({ where: dbScope, select: { code: true, rate: true, category: true } }),
      ])
    : [[], []]
  const rateMap = new Map<string, number>()
  for (const g of vgRows) {
    if (g.rate == null) continue
    if (g.category === 'S' || !rateMap.has(g.code)) rateMap.set(g.code, g.rate)
  }
  const itemMap = new Map(items.map((it) => [it.itemCode, it]))
  // Mirror rỗng (đang tìm trực tiếp trên SAP) → không đối chiếu được, coi mọi mặt hàng là còn bán
  const catalogEmpty = codes.length > 0 && items.length === 0
    && (await prisma.item.count({ where: dbScope })) === 0

  const data = agg.map((a) => {
    const it = itemMap.get(a.itemCode)
    const taxCode = it?.taxCode || a.taxCode || null
    return {
      ...a,
      itemName: it?.itemName ?? a.itemName,
      uom: it?.uom || a.uom || null,
      taxCode,
      /** false = mặt hàng không còn trong danh mục bán → form không cho thêm */
      available: Boolean(it) || catalogEmpty,
      price: it?.price ?? null,
      vatRate: taxCode ? rateMap.get(taxCode) ?? null : null,
      barcode: it?.barcode ?? null,
    }
  })
  return NextResponse.json({ ok: true, data, historyDays, maxItems })
}
