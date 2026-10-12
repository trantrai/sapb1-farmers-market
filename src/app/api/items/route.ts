import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadSalesItems, vatRateMap, mapItem, norm } from '@/lib/fm-items'

// GET /api/items?q= — tìm mặt hàng cho autocomplete của form SO
// CHẾ ĐỘ TÌM TRỰC TIẾP: chỉ trả kết quả khi người dùng nhập tối thiểu 2 ký tự.
// Từ khóa được lọc TRÊN CACHE danh mục (không gửi substringof lên SL — nhiều bản
// Service Layer thật từ chối hàm/ngoặc trong $filter với lỗi 400). Chỉ lấy
// MẶT HÀNG BÁN ĐƯỢC (SalesItem = tYES). Chưa cấu hình SL → tìm local.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()

  // ---------- 1) Tìm trực tiếp trên SAP B1 ----------
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  if (isSapConfigured(s)) {
    if (q.length < 2) {
      // Không đủ ký tự tìm kiếm → trả rỗng (autocomplete chỉ gọi khi đã nhập ≥2 ký tự)
      return NextResponse.json({ data: [], total: 0, source: 'sap', hint: 'Nhập tối thiểu 2 ký tự để tìm mặt hàng' })
    }
    const { rows, error } = await loadSalesItems(s)
    if (rows.length === 0 && error) {
      return NextResponse.json({ data: [], source: 'sap', error })
    }
    const nq = norm(q)
    const vatMap = await vatRateMap(s)
    const data = rows
      .filter((it) => norm(it.ItemCode).includes(nq) || norm(it.ItemName ?? '').includes(nq) || norm(it.BarCode ?? '').includes(nq))
      .slice(0, 30)
      .map((it) => mapItem(it, vatMap))
    return NextResponse.json({ data, total: data.length, source: 'sap' })
  }

  // ---------- 2) Fallback dữ liệu local (đúng database của phiên đăng nhập) ----------
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}
  const where: Record<string, unknown> = {
    ...dbScope,
    ...(q
      ? {
          OR: [
            { itemCode: { contains: q } },
            { itemName: { contains: q } },
          ],
        }
      : {}),
  }

  const items = await prisma.item.findMany({
    where,
    orderBy: { itemCode: 'asc' },
  })
  return NextResponse.json({ data: items, total: items.length, source: 'local' })
}
