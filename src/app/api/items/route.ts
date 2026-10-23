import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadSalesItems, vatRateMap, mapItem, norm } from '@/lib/fm-items'

// GET /api/items?q= — tìm mặt hàng cho autocomplete của form SO.
// ƯU TIÊN mirror local (dữ liệu đã "Đồng bộ Mặt hàng"): tìm trong DB chỉ mất
// vài ms, trong khi tìm trực tiếp trên SAP B1 lần đầu (cache lạnh) phải tải
// toàn bộ danh mục phân trang — rất chậm với kho lớn, dễ timeout.
// Giá tươi được resolve lại khi CHỌN mặt hàng (resolvePrice → /api/items/price),
// tồn kho check riêng qua /api/items/stock, nên mirror hơi cũ vẫn an toàn.
// Chỉ tìm trực tiếp trên SAP khi mirror còn trống (chưa từng đồng bộ).
// Từ khóa lọc TRÊN CACHE/mirror (không gửi substringof lên SL — nhiều bản
// Service Layer thật từ chối hàm/ngoặc trong $filter với lỗi 400). Chỉ lấy
// MẶT HÀNG BÁN ĐƯỢC (SalesItem = tYES).
export async function GET(req: NextRequest) {
  try {
    return await handleGet(req)
  } catch (e) {
    // Không để Next.js trả 500 trống — frontend cần thông điệp thật để chẩn đoán.
    // Làm sạch message (bỏ stack trace turbopack, chỉ giữ dòng lỗi chính).
    const raw = e instanceof Error ? e.message : String(e)
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('→') && !l.includes('__TURBOPACK__') && !/^\d+\s/.test(l))
    const message = lines.length > 0 ? lines[lines.length - 1] : raw.slice(0, 200)
    console.error('[GET /api/items] unexpected:', raw)
    return NextResponse.json(
      { data: [], total: 0, source: '', error: `Lỗi máy chủ: ${message}` },
      { status: 500 },
    )
  }
}

async function handleGet(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()

  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}

  // ---------- 1) Ưu tiên mirror local đã đồng bộ (nhanh) ----------
  const mirrorCount = await prisma.item.count({ where: dbScope })
  if (mirrorCount > 0) {
    if (q.length < 2) {
      return NextResponse.json({ data: [], total: 0, source: 'mirror', hint: 'Nhập tối thiểu 2 ký tự để tìm mặt hàng' })
    }
    const items = await prisma.item.findMany({
      where: {
        ...dbScope,
        OR: [
          { itemCode: { contains: q } },
          { itemName: { contains: q } },
          { barcode: { contains: q } },
        ],
      },
      orderBy: { itemCode: 'asc' },
      take: 200,
    })
    // Khớp chính xác mã vạch / mã hàng (quét barcode) lên đầu danh sách
    const ql = q.toLowerCase()
    const rank = (it: { itemCode: string; barcode: string | null }) =>
      (it.barcode ?? '').toLowerCase() === ql ? 0 : it.itemCode.toLowerCase() === ql ? 1 : 2
    items.sort((a, b) => rank(a) - rank(b))
    // Bổ sung thuế suất theo mã thuế từ mirror VatGroup (ưu tiên nhóm BÁN)
    const vgRows = await prisma.vatGroup.findMany({ where: dbScope })
    const rateMap = new Map<string, number>()
    for (const g of vgRows) {
      if (g.rate == null) continue
      if (g.category === 'S' || !rateMap.has(g.code)) rateMap.set(g.code, g.rate)
    }
    const data = items.map((it) => ({
      id: it.id,
      itemCode: it.itemCode,
      itemName: it.itemName,
      uom: it.uom,
      price: it.price,
      stock: it.stock,
      category: it.category,
      taxCode: it.taxCode,
      vatRate: it.taxCode ? rateMap.get(it.taxCode) : undefined,
      barcode: it.barcode,
      bomType: it.bomType,
    }))
    return NextResponse.json({ data, total: data.length, source: 'mirror' })
  }

  // ---------- 2) Mirror trống + có cấu hình SAP → tìm trực tiếp trên SAP B1 ----------
  // (chậm ở lần đầu vì phải tải toàn bộ danh mục; các lần sau dùng cache 5 phút)
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
      // Khớp chính xác mã vạch / mã hàng (quét barcode) lên đầu danh sách
      .sort((a, b) => Number(norm(b.BarCode ?? '') === nq || norm(b.ItemCode) === nq) - Number(norm(a.BarCode ?? '') === nq || norm(a.ItemCode) === nq))
      .slice(0, 30)
      .map((it) => mapItem(it, vatMap))
    return NextResponse.json({ data, total: data.length, source: 'sap' })
  }

  // ---------- 3) Chưa cấu hình SAP và mirror trống ----------
  return NextResponse.json({ data: [], total: 0, source: 'local' })
}
