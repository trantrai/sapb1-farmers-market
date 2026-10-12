import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// ---------- GET /api/search?q=XXX ----------
// Tìm kiếm toàn văn cho command palette (Ctrl+K):
// - Đơn hàng: số chứng từ (docNum), tên KH, mã KH
// - Mặt hàng: mã hàng, tên hàng
// - Khách hàng: mã KH, tên KH
// Tối đa 5 kết quả mỗi loại. Yêu cầu đăng nhập; từng loại kết quả
// chỉ trả về khi user có quyền xem tương ứng.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) {
    return NextResponse.json({ ok: true, orders: [], items: [], partners: [] })
  }

  const canOrders = !!user.permissions.orders?.view
  const canMaster = !!user.permissions.settings?.view

  const num = Number(q)
  const isDocNum = q !== '' && Number.isInteger(num) && num > 0

  const [orders, items, partners] = await Promise.all([
    canOrders
      ? prisma.salesOrder.findMany({
          where: {
            OR: [
              ...(isDocNum ? [{ docNum: num }] : []),
              { cardName: { contains: q } },
              { cardCode: { contains: q } },
            ],
          },
          select: {
            id: true,
            docNum: true,
            cardCode: true,
            cardName: true,
            docDate: true,
            status: true,
            grandTotal: true,
          },
          orderBy: { docDate: 'desc' },
          take: 5,
        })
      : Promise.resolve([]),
    canMaster
      ? prisma.item.findMany({
          where: {
            OR: [{ itemCode: { contains: q } }, { itemName: { contains: q } }],
          },
          select: { id: true, itemCode: true, itemName: true, price: true, uom: true },
          orderBy: { itemCode: 'asc' },
          take: 5,
        })
      : Promise.resolve([]),
    canMaster
      ? prisma.businessPartner.findMany({
          where: {
            OR: [{ cardCode: { contains: q } }, { cardName: { contains: q } }],
          },
          select: { id: true, cardCode: true, cardName: true, groupType: true },
          orderBy: { cardCode: 'asc' },
          take: 5,
        })
      : Promise.resolve([]),
  ])

  return NextResponse.json({ ok: true, orders, items, partners })
}
