import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'

// ============================================================
// GET /api/orders/recent?cardCode=&limit=3
// "Đặt lại đơn gần nhất": N đơn hàng chính thức gần nhất của khách hàng
// (bỏ nháp, bỏ đơn hủy) kèm dòng hàng để form tạo đơn dùng lại.
// Chỉ trả dòng CHA/hàng thường (dòng con BOM sẽ bung lại theo công thức
// hiện hành khi chọn mặt hàng cha) + thông tin mặt hàng HIỆN TẠI trong
// mirror (giá Price List 1, mã thuế, thuế suất, ĐVT, barcode) để form
// tính lại giá — không dùng lại giá cũ của đơn.
// ============================================================

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create && !user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const cardCode = (req.nextUrl.searchParams.get('cardCode') ?? '').trim()
  if (!cardCode || cardCode.length > 50) {
    return NextResponse.json({ error: 'Thiếu mã khách hàng (cardCode)' }, { status: 400 })
  }
  const limit = Math.min(10, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 3))

  // Cách ly theo database đăng nhập (giống danh sách đơn): kèm đơn cũ chưa gán DB
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const orders = await prisma.salesOrder.findMany({
    where: {
      cardCode,
      isDraft: false,
      status: { not: 'Cancelled' },
      ...(dbId ? { OR: [{ sapDatabaseId: dbId }, { sapDatabaseId: '' }, { sapDatabaseId: null }] } : {}),
    },
    orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true, docNum: true, docDate: true, grandTotal: true, status: true,
      lines: {
        where: { isBomChild: false },
        orderBy: { lineNum: 'asc' },
        select: { itemCode: true, itemName: true, quantity: true, uom: true, warehouseCode: true },
      },
    },
  })

  // Thông tin mặt hàng hiện tại (mirror) + thuế suất theo mã thuế
  const codes = [...new Set(orders.flatMap((o) => o.lines.map((l) => l.itemCode)))]
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

  const data = orders.map((o) => ({
    id: o.id,
    docNum: o.docNum,
    docDate: o.docDate,
    grandTotal: o.grandTotal,
    status: o.status,
    lines: o.lines.map((l) => {
      const it = itemMap.get(l.itemCode)
      return {
        itemCode: l.itemCode,
        itemName: it?.itemName ?? l.itemName,
        quantity: l.quantity,
        uom: it?.uom || l.uom,
        warehouseCode: l.warehouseCode,
        /** false = mặt hàng không còn trong danh mục bán → form bỏ qua + báo */
        available: Boolean(it) || catalogEmpty,
        price: it?.price ?? null,
        taxCode: it?.taxCode ?? null,
        vatRate: it?.taxCode ? rateMap.get(it.taxCode) ?? null : null,
        barcode: it?.barcode ?? null,
      }
    }),
  }))
  return NextResponse.json({ data })
}
