import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { getBomDefinition } from '@/lib/fm-bom'

// ============================================================
// GET /api/bom?parentItemCode=XXX — công thức BOM của 1 mặt hàng cha
// (đọc từ mirror local, đúng database của phiên đăng nhập).
// Trả { bomType: 'none' } khi mặt hàng không phải BOM Template/Production.
// Form tạo đơn dùng để tự bung thành phần con khi chọn mặt hàng BOM.
// ============================================================
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view && !user.permissions.ordersNew?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem công thức BOM' }, { status: 403 })
  }

  const parentItemCode = (req.nextUrl.searchParams.get('parentItemCode') ?? '').trim()
  if (!parentItemCode) {
    return NextResponse.json({ error: 'Thiếu parentItemCode' }, { status: 400 })
  }

  const s = await loadSapSettings(user.databaseId)
  const def = await getBomDefinition(s?.dbId ?? null, parentItemCode)
  if (!def) return NextResponse.json({ bomType: 'none', parentItemCode, components: [] })
  return NextResponse.json(def)
}
