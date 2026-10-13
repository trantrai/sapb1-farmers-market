import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadSalesItems, loadSalesItemsDelta, mergeItemsCache, clearItemsCache, numv } from '@/lib/fm-items'
import { loadProductTrees, indexTrees } from '@/lib/fm-bom'
import { startSync, updateSync, endSync, getProgress } from '@/lib/fm-sync-progress'
import {
  getWatermark, setWatermark, clearWatermark, watermarkInfo, advanceWatermark,
  type DeltaWatermark,
} from '@/lib/fm-sync-delta'

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

async function lastSyncAt(dbId?: string | null): Promise<Date | null> {
  const agg = await prisma.item.aggregate({
    _max: { syncedAt: true },
    where: dbId ? { sapDatabaseId: dbId } : undefined,
  })
  return agg._max.syncedAt ?? null
}

// ---------- GET: danh sách local + trạng thái ----------
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục mặt hàng' }, { status: 403 })
  }

  // Mirror tách theo database đã chọn khi đăng nhập
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const page = Math.max(1, Number(sp.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(5, Number(sp.get('pageSize') ?? '20') || 20))

  // Tìm kiếm không dấu: nếu từ khóa chứa ký tự tiếng Việt có dấu → dùng LIKE SQL
  // tiền-lọc (raw q khớp raw dữ liệu). Từ khóa thuần ASCII (vd "ca rot") KHÔNG
  // tiền-lọc bằng SQL vì sẽ loại nhầm "Cà Rốt" — lấy hết rồi lọc không dấu tại chỗ.
  const hasNonAscii = /[^\x00-\x7F]/.test(q)
  const where: Record<string, unknown> = {
    ...dbScope,
    ...(q && hasNonAscii
      ? {
          OR: [
            { itemCode: { contains: q } },
            { itemName: { contains: q } },
            { barcode: { contains: q } },
            { taxCode: { contains: q } },
          ],
        }
      : {}),
  }

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

  return NextResponse.json({
    data,
    total: totalFiltered,
    page,
    totalPages: Math.max(1, Math.ceil(totalFiltered / pageSize)),
    status: {
      configured: isSapConfigured(s),
      count: await prisma.item.count({ where: dbScope }),
      lastSyncAt: await lastSyncAt(dbId),
      watermark: await watermarkInfo(dbId, 'items').catch(() => null),
      progress: getProgress('items'),
    },
  })
}

// ---------- POST: đồng bộ từ SAP B1 (CHẠY NỀN — trả 202 + progress qua GET) ----------
// Body JSON: { mode?: 'incremental' | 'full' }
//  · 'incremental' — chỉ tải bản ghi thay đổi kể từ mốc (UpdateDate, UpdateTime)
//    đã lưu, upsert vào mirror (mặc định khi đã có mốc).
//  · 'full' — tải toàn bộ danh mục, thay mới mirror (mặc định khi chưa có mốc).
// LƯU Ý: gia tăng không phát hiện bản ghi BỊ XÓA trên SAP — nên chạy toàn phần
// định kỳ (vd mỗi tuần) để mirror khớp hẳn danh mục SAP.
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đồng bộ mặt hàng' }, { status: 403 })
  }

  const s = await loadSapSettings(user.databaseId)
  if (!isSapConfigured(s)) {
    return NextResponse.json(
      { error: 'Chưa cấu hình SAP B1 Service Layer — hãy vào Cài đặt SAP B1 nhập URL, CompanyDB, tài khoản trước khi đồng bộ.' },
      { status: 400 },
    )
  }
  const syncDbId = s.dbId! // isSapConfigured đảm bảo s.dbId tồn tại

  // Khóa chống song song: 1 thực thể chỉ chạy 1 lượt đồng bộ tại 1 thời điểm
  if (!startSync('items')) {
    return NextResponse.json({ error: 'Một lượt đồng bộ khác đang chạy — hãy đợi xong rồi thử lại.' }, { status: 409 })
  }

  // Chế độ sync: body.mode > mặc định (gia tăng nếu đã có mốc, ngược lại toàn phần)
  let bodyMode: string | undefined
  try {
    bodyMode = (await req.json())?.mode
  } catch { /* không có body */ }
  // Graceful fallback: neu Prisma client/bang SyncWatermark chua duoc generate/push
  // (vd quen chay generate sau khi pull) thi chay full sync thay vi crash 500.
  const wm0 = await getWatermark(syncDbId, 'items').catch(() => null)
  const mode: 'full' | 'incremental' =
    bodyMode === 'full' ? 'full'
    : bodyMode === 'incremental' ? (wm0 ? 'incremental' : 'full')
    : wm0 ? 'incremental' : 'full'

  // Tác vụ chạy nền — client poll GET 2s/lần để vẽ thanh tiến trình
  void (async () => {
    try {
      if (mode === 'incremental' && wm0) {
        await syncIncremental(s, syncDbId, wm0)
      } else {
        await syncFull(s, syncDbId)
      }
    } catch (e) {
      console.error('POST /api/items/sync (nền)', e)
      const msg = e instanceof Error ? e.message : 'Lỗi không rõ khi đồng bộ mặt hàng'
      endSync('items', { message: '', error: msg })
    }
  })()

  return NextResponse.json(
    {
      ok: true,
      started: true,
      mode,
      message: mode === 'incremental'
        ? 'Đã bắt đầu đồng bộ GIA TĂNG từ SAP B1 — chỉ tải mặt hàng thay đổi kể từ mốc đã lưu.'
        : 'Đã bắt đầu đồng bộ TOÀN PHẦN từ SAP B1 — tác vụ chạy nền trên máy chủ.',
    },
    { status: 202 },
  )
}

/** Đồng bộ toàn phần: tải hết danh mục, thay mới mirror, đặt lại mốc watermark */
async function syncFull(s: NonNullable<Awaited<ReturnType<typeof loadSapSettings>>>, syncDbId: string) {
  const { rows, error } = await loadSalesItems(s, (p) => updateSync('items', p))
  // Guard kép: lỗi HOẶC danh sách rỗng đều không được xóa mirror local
  // (SL có thể trả 200 rỗng do sai filter/quyền → xóa sạch là mất dữ liệu)
  if (error || rows.length === 0) {
    throw new Error(
      error ? `Không tải được danh mục từ SAP B1: ${error}` : 'SAP B1 trả về danh sách mặt hàng rỗng — không xóa dữ liệu local để an toàn',
    )
  }
  const bomIndex = await syncBomMirror(s, syncDbId)
  const now = new Date()

  const payload = rows.map((it) => {
    const price = it.ItemPrices?.find((p) => numv(p.PriceList) === 1)?.Price
    const bomDef = bomIndex.get(it.ItemCode)
    return {
      sapDatabaseId: syncDbId,
      itemCode: it.ItemCode,
      itemName: it.ItemName ?? it.ItemCode,
      uom: it.SalesUnit || it.InventoryUOM || '',
      price: numv(price),
      stock: numv(it.QuantityOnStock),
      taxCode: it.SalesVATGroup ?? null,
      barcode: it.BarCode ?? null,
      bomType: bomDef?.bomType ?? 'none',
      syncedAt: now,
    }
  })

  updateSync('items', { phase: 'save', message: `Đang lưu ${payload.length.toLocaleString('vi-VN')} mặt hàng vào CSDL…`, total: payload.length, processed: 0 })
  // Mirror trọn vẹn: bảng local phản ánh đúng danh mục Sales Item hiện tại trên SAP
  await prisma.$transaction(async (tx) => {
    await tx.item.deleteMany({ where: { sapDatabaseId: syncDbId } })
    // Chia lô 500 dòng phòng giới hạn số tham số của SQLite
    for (let i = 0; i < payload.length; i += 500) {
      await tx.item.createMany({ data: payload.slice(i, i + 500) })
      updateSync('items', { processed: Math.min(i + 500, payload.length) })
    }
  })

  // GIỮ cache autocomplete: loadSalesItems vừa nạp dữ liệu TƯƠI NHẤT vào cache,
  // xóa đi sẽ ép lần tìm tiếp theo tải lại toàn bộ danh mục từ SAP (rất chậm).
  // Cache có TTL 5 phút nên không sợ dữ liệu cũ.
  const wm = advanceWatermark(null, rows)
  await setWatermark(syncDbId, 'items', wm, 'full')
  const bomCount = bomIndex.size
  endSync('items', {
    message: `Đã đồng bộ TOÀN PHẦN ${payload.length.toLocaleString('vi-VN')} mặt hàng bán được từ SAP B1${bomCount > 0 ? ` + ${bomCount} công thức BOM` : ''}.`,
    processed: payload.length,
  })
}

/** Đồng bộ gia tăng: chỉ tải bản ghi đổi kể từ mốc, upsert vào mirror, nâng mốc */
async function syncIncremental(
  s: NonNullable<Awaited<ReturnType<typeof loadSapSettings>>>,
  syncDbId: string,
  wm: DeltaWatermark,
) {
  const { rows, error } = await loadSalesItemsDelta(s, wm, (p) => updateSync('items', p))
  if (error) {
    throw new Error(`Không tải được mặt hàng thay đổi từ SAP B1: ${error}`)
  }
  const bomIndex = await syncBomMirror(s, syncDbId)
  const now = new Date()

  if (rows.length === 0) {
    // Không có thay đổi — vẫn ghi nhận lượt chạy để UI hiện "đồng bộ cuối"
    await setWatermark(syncDbId, 'items', wm, 'incremental')
    endSync('items', {
      message: `Không có mặt hàng nào thay đổi trên SAP B1 kể từ mốc ${wm.date}. Mirror giữ nguyên.`,
      processed: 0,
    })
    return
  }

  updateSync('items', { phase: 'save', message: `Đang cập nhật ${rows.length.toLocaleString('vi-VN')} mặt hàng thay đổi…`, total: rows.length, processed: 0 })
  let done = 0
  for (const it of rows) {
    const price = it.ItemPrices?.find((p) => numv(p.PriceList) === 1)?.Price
    const bomDef = bomIndex.get(it.ItemCode)
    const data = {
      itemName: it.ItemName ?? it.ItemCode,
      uom: it.SalesUnit || it.InventoryUOM || '',
      price: numv(price),
      stock: numv(it.QuantityOnStock),
      taxCode: it.SalesVATGroup ?? null,
      barcode: it.BarCode ?? null,
      bomType: bomDef?.bomType ?? 'none',
      syncedAt: now,
    }
    await prisma.item.upsert({
      where: { sapDatabaseId_itemCode: { sapDatabaseId: syncDbId, itemCode: it.ItemCode } },
      create: { sapDatabaseId: syncDbId, itemCode: it.ItemCode, ...data },
      update: data,
    })
    done += 1
    if (done % 50 === 0 || done === rows.length) updateSync('items', { processed: done })
  }

  // Trộn delta vào cache autocomplete để lần tìm sau dùng ngay dữ liệu mới
  mergeItemsCache(s, rows)

  const newWm = advanceWatermark(wm, rows)
  await setWatermark(syncDbId, 'items', newWm, 'incremental')
  endSync('items', {
    message: `Đã đồng bộ GIA TĂNG ${rows.length.toLocaleString('vi-VN')} mặt hàng thay đổi từ SAP B1 (mốc ${wm.date} → ${newWm.date}).`,
    processed: rows.length,
  })
}

/**
 * Mirror BOM: tải ProductTrees (Template + Production + Assembly) từ SAP B1 và thay mới
 * toàn bộ công thức của DB. Chạy trong cả 2 chế độ (toàn phần + gia tăng) vì
 * thêm/sửa công thức trên SAP có thể không làm đổi UpdateDate của mặt hàng cha.
 */
async function syncBomMirror(
  s: NonNullable<Awaited<ReturnType<typeof loadSapSettings>>>,
  syncDbId: string,
) {
  updateSync('items', { phase: 'fetch', message: 'Đang tải công thức BOM (ProductTrees) từ SAP B1…' })
  const { trees, error: bomError } = await loadProductTrees(s)
  if (bomError) {
    // BOM sync thất bại: KHÔNG xóa mirror cũ, KHÔNG gán bomType='none' —
    // ném lỗi để người dùng thấy rõ thay vì lặng lẽ mất dữ liệu BOM.
    throw new Error(`Không tải được công thức BOM từ SAP B1 (ProductTrees): ${bomError}`)
  }
  const bomIndex = indexTrees(trees)
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.bomComponent.deleteMany({ where: { sapDatabaseId: syncDbId } })
    const bomRows: {
      sapDatabaseId: string
      parentItemCode: string
      childItemCode: string
      childItemName: string
      quantity: number
      uom: string
      sortOrder: number
      syncedAt: Date
    }[] = []
    for (const def of bomIndex.values()) {
      for (const c of def.components) {
        bomRows.push({
          sapDatabaseId: syncDbId,
          parentItemCode: def.parentItemCode,
          childItemCode: c.childItemCode,
          childItemName: c.childItemName,
          quantity: c.qtyPerParent,
          uom: c.uom,
          sortOrder: c.sortOrder,
          syncedAt: now,
        })
      }
    }
    // Phòng thủ: khử trùng (parent, child) đề phòng dữ liệu SAP bất thường
    const seen = new Set<string>()
    const uniqRows = bomRows.filter((r) => {
      const k = `${r.parentItemCode}${r.childItemCode}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    for (let i = 0; i < uniqRows.length; i += 500) {
      await tx.bomComponent.createMany({ data: uniqRows.slice(i, i + 500) })
    }
  })
  return bomIndex
}

// ---------- DELETE: xóa toàn bộ dữ liệu đã đồng bộ ----------
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền xóa dữ liệu đồng bộ' }, { status: 403 })
  }

  const s = await loadSapSettings(user.databaseId)
  const dbScope = s?.dbId ? { sapDatabaseId: s.dbId } : {}
  await prisma.item.deleteMany({ where: dbScope })
  await prisma.bomComponent.deleteMany({ where: dbScope })
  if (s?.dbId) await clearWatermark(s.dbId, 'items') // xóa mốc → lần sau đồng bộ toàn phần
  clearItemsCache(s?.dbId)
  return NextResponse.json({ ok: true, message: 'Đã xóa toàn bộ dữ liệu mặt hàng đã đồng bộ.' })
}
