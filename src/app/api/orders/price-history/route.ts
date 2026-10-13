import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// ---------- GET /api/orders/price-history?cardCode=XXX&itemCode=YYY ----------
// Lịch sử giá đã bán mặt hàng cho khách hàng: 5 lần bán gần nhất.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const cardCode = (req.nextUrl.searchParams.get('cardCode') || '').trim()
  const itemCode = (req.nextUrl.searchParams.get('itemCode') || '').trim()
  if (!cardCode || !itemCode) {
    return NextResponse.json({ error: 'Thiếu mã khách hàng hoặc mã hàng' }, { status: 400 })
  }

  // 5 đơn gần nhất của KH có chứa mặt hàng (kèm dòng hàng đó)
  // B1: cách ly DB
  const dbScope = user.databaseId ? { sapDatabaseId: user.databaseId } : {}
  const orders = await prisma.salesOrder.findMany({
    where: {
      ...dbScope,
      cardCode,
      lines: { some: { itemCode } },
    },
    select: {
      docNum: true,
      docDate: true,
      lines: {
        where: { itemCode },
        select: {
          quantity: true,
          unitPrice: true,
          discPct: true,
          uom: true,
        },
      },
    },
    orderBy: { docDate: 'desc' },
    take: 5,
  })

  const history = orders.map((o) => {
    const l = o.lines[0]
    return {
      docNum: o.docNum,
      docDate: o.docDate.toISOString(),
      quantity: l?.quantity ?? 0,
      unitPrice: l?.unitPrice ?? 0,
      discPct: l?.discPct ?? 0,
      uom: l?.uom ?? 'kg',
    }
  })

  return NextResponse.json({ ok: true, data: history })
}
