import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadSalesItems, vatRateMap, numv, clearItemsCache } from '@/lib/fm-items'
import { startSync, updateSync, endSync, getProgress } from '@/lib/fm-sync-progress'

// ============================================================
// ĐỒNG BỘ MẶT HÀNG — mirror danh mục Sales Item của SAP B1 vào
// bảng Item local để:
//  · Màn hình "Đồng bộ Mặt hàng" xem/tìm toàn bộ danh mục.
//  · Fallback tìm mặt hàng khi Service Layer mất kết nối.
// GET    /api/items/sync?q=&page=&pageSize= — danh sách + trạng thái
// POST   /api/items/sync — đồng bộ ngay từ SAP B1 (cần quyền settings.edit)
// DELETE /api/items/sync — xóa toàn bộ dữ liệu đã đồng bộ (cần settings.edit)
// ============================================================

const normQ = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')

async function lastSyncAt(): Promise<Date | null> {
  const agg = await prisma.item.aggregate({ _max: { syncedAt: true } })
  return agg._max.syncedAt ?? null
}

// ---------- GET: danh sách local + trạng thái ----------
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục mặt hàng' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const page = Math.max(1, Number(sp.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(5, Number(sp.get('pageSize') ?? '20') || 20))

  // Tìm kiếm không dấu: nếu từ khóa chứa ký tự tiếng Việt có dấu → dùng LIKE SQL
  // tiền-lọc (raw q khớp raw dữ liệu). Từ khóa thuần ASCII (vd "ca rot") KHÔNG
  // tiền-lọc bằng SQL vì sẽ loại nhầm "Cà Rốt" — lấy hết rồi lọc không dấu tại chỗ.
  const hasNonAscii = /[^\x00-\x7F]/.test(q)
  const where: Record<string, unknown> = q && hasNonAscii
    ? {
        OR: [
          { itemCode: { contains: q } },
          { itemName: { contains: q } },
          { barcode: { contains: q } },
          { taxCode: { contains: q } },
        ],
      }
    : {}

  const [total, rows] = await Promise.all([
    prisma.item.count({ where }),
    prisma.item.findMany({
      where,
      orderBy: { itemCode: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  // Lọc không dấu + tính lại phân trang khi có từ khóa
  let data = rows
  let totalFiltered = total
  if (q) {
    const nq = normQ(q)
    const match = (r: { itemCode: string; itemName: string; barcode: string | null; taxCode: string | null }) =>
      normQ(r.itemCode).includes(nq) || normQ(r.itemName).includes(nq) ||
      normQ(r.barcode ?? '').includes(nq) || normQ(r.taxCode ?? '').includes(nq)
    const all = await prisma.item.findMany({ where, orderBy: { itemCode: 'asc' } })
    const filtered = all.filter(match)
    totalFiltered = filtered.length
    data = filtered.slice((page - 1) * pageSize, page * pageSize)
  }

  const s = await loadSapSettings()
  return NextResponse.json({
    data,
    total: totalFiltered,
    page,
    totalPages: Math.max(1, Math.ceil(totalFiltered / pageSize)),
    status: {
      configured: isSapConfigured(s),
      count: await prisma.item.count(),
      lastSyncAt: await lastSyncAt(),
      progress: getProgress('items'),
    },
  })
}

// ---------- POST: đồng bộ ngay từ SAP B1 (CHẠY NỀN — trả 202 + progress qua GET) ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đồng bộ mặt hàng' }, { status: 403 })
  }

  const s = await loadSapSettings()
  if (!isSapConfigured(s)) {
    return NextResponse.json(
      { error: 'Chưa cấu hình SAP B1 Service Layer — hãy vào Cài đặt SAP B1 nhập URL, CompanyDB, tài khoản trước khi đồng bộ.' },
      { status: 400 },
    )
  }

  // Khóa chống song song: 1 thực thể chỉ chạy 1 lượt đồng bộ tại 1 thời điểm
  if (!startSync('items')) {
    return NextResponse.json({ error: 'Một lượt đồng bộ khác đang chạy — hãy đợi xong rồi thử lại.' }, { status: 409 })
  }

  // Tác vụ chạy nền — client poll GET 2s/lần để vẽ thanh tiến trình
  void (async () => {
    try {
      const { rows, error } = await loadSalesItems(s, (p) => updateSync('items', p))
      if (error && rows.length === 0) throw new Error(`Không tải được danh mục từ SAP B1: ${error}`)
      updateSync('items', { phase: 'fetch', message: `Đã nhận ${rows.length} mặt hàng — đang tải bảng thuế suất…` })
      const vatMap = await vatRateMap(s)
      const now = new Date()

      const payload = rows.map((it) => {
        const price = it.ItemPrices?.find((p) => numv(p.PriceList) === 1)?.Price
        return {
          itemCode: it.ItemCode,
          itemName: it.ItemName ?? it.ItemCode,
          uom: it.SalesUnit || it.InventoryUOM || '',
          price: numv(price),
          stock: numv(it.QuantityOnStock),
          taxCode: it.SalesVATGroup ?? null,
          barcode: it.BarCode ?? null,
          syncedAt: now,
        }
      })

      updateSync('items', { phase: 'save', message: `Đang lưu ${payload.length.toLocaleString('vi-VN')} mặt hàng vào CSDL…`, total: payload.length, processed: 0 })
      // Mirror trọn vẹn: bảng local phản ánh đúng danh mục Sales Item hiện tại trên SAP
      await prisma.$transaction(async (tx) => {
        await tx.item.deleteMany()
        // Chia lô 500 dòng phòng giới hạn số tham số của SQLite
        for (let i = 0; i < payload.length; i += 500) {
          await tx.item.createMany({ data: payload.slice(i, i + 500) })
          updateSync('items', { processed: Math.min(i + 500, payload.length) })
        }
      })

      // Cache autocomplete chứa dữ liệu cũ — ép tải lại
      clearItemsCache()
      endSync('items', { message: `Đã đồng bộ ${payload.length.toLocaleString('vi-VN')} mặt hàng bán được từ SAP B1.`, processed: payload.length })
    } catch (e) {
      console.error('POST /api/items/sync (nền)', e)
      const msg = e instanceof Error ? e.message : 'Lỗi không rõ khi đồng bộ mặt hàng'
      endSync('items', { message: '', error: msg })
    }
  })()

  return NextResponse.json(
    { ok: true, started: true, message: 'Đã bắt đầu đồng bộ từ SAP B1 — tác vụ chạy nền trên máy chủ.' },
    { status: 202 },
  )
}

// ---------- DELETE: xóa toàn bộ dữ liệu đã đồng bộ ----------
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền xóa dữ liệu đồng bộ' }, { status: 403 })
  }

  await prisma.item.deleteMany()
  clearItemsCache()
  return NextResponse.json({ ok: true, message: 'Đã xóa toàn bộ dữ liệu mặt hàng đã đồng bộ.' })
}
