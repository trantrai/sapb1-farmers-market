import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadVatGroups, clearVatGroupsCache } from '@/lib/fm-master'
import { startSync, updateSync, endSync, getProgress } from '@/lib/fm-sync-progress'

// ============================================================
// ĐỒNG BỘ NHÓM THUẾ (Sale VAT Group) — mirror danh mục /VatGroups
// (OVTG) của SAP B1 vào bảng VatGroup local:
//  · Màn hình "Đồng bộ Nhóm thuế" xem/tìm toàn bộ nhóm thuế.
//  · Giữ CẢ HAI dòng S (Bán/output) và P (Mua/input) của mỗi mã —
//    mirror đúng danh mục SAP; màn hình có chip lọc Bán/Mua.
// GET    /api/vatgroups/sync?q=&cat=&page=&pageSize= — danh sách + trạng thái
// POST   /api/vatgroups/sync — đồng bộ ngay từ SAP B1 (cần quyền settings.edit)
// DELETE /api/vatgroups/sync — xóa toàn bộ dữ liệu đã đồng bộ (cần settings.edit)
// ============================================================

const normQ = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')

async function lastSyncAt(dbId?: string | null): Promise<Date | null> {
  const agg = await prisma.vatGroup.aggregate({
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
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục nhóm thuế' }, { status: 403 })
  }

  // Mirror tách theo database đã chọn khi đăng nhập
  const sTop = await loadSapSettings(user.databaseId)
  const dbIdTop = sTop?.dbId ?? null

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const cat = (sp.get('cat') ?? '').trim().toUpperCase() // '' | 'S' | 'P'
  const page = Math.max(1, Number(sp.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(5, Number(sp.get('pageSize') ?? '20') || 20))

  // Tìm kiếm không dấu: từ khóa có dấu → LIKE SQL tiền-lọc; thuần ASCII →
  // lấy hết rồi lọc không dấu tại chỗ (tránh loại nhầm dữ liệu có dấu).
  const hasNonAscii = /[^\x00-\x7F]/.test(q)
  const and: Record<string, unknown>[] = []
  if (dbIdTop) and.push({ sapDatabaseId: dbIdTop })
  if (cat === 'S' || cat === 'P') and.push({ category: cat })
  if (q && hasNonAscii) {
    and.push({
      OR: [
        { code: { contains: q } },
        { name: { contains: q } },
      ],
    })
  }
  const where = and.length > 0 ? { AND: and } : {}

  const [total, rows] = await Promise.all([
    prisma.vatGroup.count({ where }),
    prisma.vatGroup.findMany({
      where,
      orderBy: [{ code: 'asc' }, { category: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  // Lọc không dấu + tính lại phân trang khi có từ khóa
  let data = rows
  let totalFiltered = total
  if (q && !hasNonAscii) {
    const nq = normQ(q)
    const all = await prisma.vatGroup.findMany({ where, orderBy: [{ code: 'asc' }, { category: 'asc' }] })
    const filtered = all.filter((r) =>
      normQ(r.code).includes(nq) || normQ(r.name).includes(nq),
    )
    totalFiltered = filtered.length
    data = filtered.slice((page - 1) * pageSize, page * pageSize)
  }

  const dbScope = dbIdTop ? { sapDatabaseId: dbIdTop } : {}
  const [salesCount, purchaseCount, missingRateCount] = await Promise.all([
    prisma.vatGroup.count({ where: { ...dbScope, category: 'S' } }),
    prisma.vatGroup.count({ where: { ...dbScope, category: 'P' } }),
    prisma.vatGroup.count({ where: { ...dbScope, rate: null } }),
  ])
  return NextResponse.json({
    data,
    total: totalFiltered,
    page,
    totalPages: Math.max(1, Math.ceil(totalFiltered / pageSize)),
    status: {
      configured: isSapConfigured(sTop),
      count: await prisma.vatGroup.count({ where: dbScope }),
      salesCount,
      purchaseCount,
      missingRateCount,
      lastSyncAt: await lastSyncAt(dbIdTop),
      progress: getProgress('vatgroups'),
    },
  })
}

// ---------- POST: đồng bộ ngay từ SAP B1 (CHẠY NỀN — trả 202 + progress qua GET) ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đồng bộ nhóm thuế' }, { status: 403 })
  }

  const s = await loadSapSettings(user.databaseId)
  if (!isSapConfigured(s)) {
    return NextResponse.json(
      { error: 'Chưa cấu hình SAP B1 Service Layer — hãy vào Cài đặt SAP B1 nhập URL, CompanyDB, tài khoản trước khi đồng bộ.' },
      { status: 400 },
    )
  }
  const syncDbId = s.dbId! // isSapConfigured đảm bảo s.dbId tồn tại

  if (!startSync('vatgroups')) {
    return NextResponse.json({ error: 'Một lượt đồng bộ khác đang chạy — hãy đợi xong rồi thử lại.' }, { status: 409 })
  }

  void (async () => {
    try {
      const { rows, error } = await loadVatGroups(s, (p) => updateSync('vatgroups', p))
      if ((error && rows.length === 0) || rows.length === 0) {
        throw new Error(`Không tải được nhóm thuế từ SAP B1: ${error ?? '/VatGroups trả danh sách rỗng'}`)
      }
      const now = new Date()
      const payload = rows.map((v) => ({
        sapDatabaseId: syncDbId,
        code: v.code,
        category: v.category,
        name: v.name,
        rate: v.rate,
        syncedAt: now,
      }))

      updateSync('vatgroups', { phase: 'save', message: `Đang lưu ${payload.length.toLocaleString('vi-VN')} nhóm thuế vào CSDL…`, total: payload.length, processed: 0 })
      // Mirror trọn vẹn: bảng local phản ánh đúng danh mục OVTG hiện tại trên SAP
      await prisma.$transaction(async (tx) => {
        await tx.vatGroup.deleteMany({ where: { sapDatabaseId: syncDbId } })
        for (let i = 0; i < payload.length; i += 500) {
          await tx.vatGroup.createMany({ data: payload.slice(i, i + 500) })
          updateSync('vatgroups', { processed: Math.min(i + 500, payload.length) })
        }
      })

      clearVatGroupsCache(syncDbId)

      const sales = payload.filter((v) => v.category === 'S').length
      endSync('vatgroups', {
        message: `Đã đồng bộ ${payload.length.toLocaleString('vi-VN')} nhóm thuế (${sales} nhóm bán) từ SAP B1.`,
        processed: payload.length,
      })
    } catch (e) {
      console.error('POST /api/vatgroups/sync (nền)', e)
      const msg = e instanceof Error ? e.message : 'Lỗi không rõ khi đồng bộ nhóm thuế'
      endSync('vatgroups', { message: '', error: msg })
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

  const s = await loadSapSettings(user.databaseId)
  const dbScope = s?.dbId ? { sapDatabaseId: s.dbId } : {}
  await prisma.vatGroup.deleteMany({ where: dbScope })
  clearVatGroupsCache(s?.dbId)
  clearVatGroupsCache()
  return NextResponse.json({ ok: true, message: 'Đã xóa toàn bộ dữ liệu nhóm thuế đã đồng bộ.' })
}
