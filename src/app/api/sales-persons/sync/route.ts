import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGetAll } from '@/lib/sap-service-layer'
import { rateLimit } from '@/lib/rate-limit'

// ============================================================
// ĐỒNG BỘ NHÂN VIÊN BÁN HÀNG — mirror danh mục /SalesPersons
// (OSLP) của SAP B1 vào bảng SalesPerson local (SlpCode → code,
// SlpName → name):
//  · Màn hình "Đồng bộ NVBH" xem/tìm toàn bộ nhân viên bán hàng.
//  · GET /api/sales-persons dùng mirror này cho dropdown NVBH.
// OSLP rất ít dòng → POST chạy ĐỒNG BỘ trong request (không cần
// tiến trình nền như partners/vatgroups).
// GET    /api/sales-persons/sync?q=&page=&pageSize= — danh sách + trạng thái
// POST   /api/sales-persons/sync — đồng bộ ngay từ SAP B1 (cần quyền settings.edit)
// DELETE /api/sales-persons/sync — xóa toàn bộ dữ liệu đã đồng bộ (cần settings.edit)
// ============================================================

/** Dòng OSLP thô từ Service Layer */
interface SlpRow {
  SlpCode?: number
  SlpName?: string
  /** BoYesNoEnum: 'tYES' | 'tNO' */
  Active?: string
}

const normQ = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')

async function lastSyncAt(dbId?: string | null): Promise<Date | null> {
  const agg = await prisma.salesPerson.aggregate({
    _max: { updatedAt: true },
    where: dbId ? { sapDatabaseId: dbId } : undefined,
  })
  return agg._max?.updatedAt ?? null
}

// ---------- GET: danh sách local + trạng thái ----------
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục nhân viên bán hàng' }, { status: 403 })
  }

  // Mirror tách theo database đã chọn khi đăng nhập
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const page = Math.max(1, Number(sp.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(5, Number(sp.get('pageSize') ?? '20') || 20))

  // Tìm kiếm không dấu: từ khóa có dấu → LIKE SQL tiền-lọc; thuần ASCII →
  // lấy hết rồi lọc không dấu tại chỗ (tránh loại nhầm dữ liệu có dấu).
  const hasNonAscii = /[^\x00-\x7F]/.test(q)
  const where: Record<string, unknown> = {
    ...dbScope,
    ...(q && hasNonAscii
      ? { OR: [{ name: { contains: q } }] }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.salesPerson.count({ where }),
    prisma.salesPerson.findMany({
      where,
      orderBy: { code: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  // Lọc không dấu + tính lại phân trang khi có từ khóa
  let data = rows
  let totalFiltered = total
  if (q && !hasNonAscii) {
    const nq = normQ(q)
    const all = await prisma.salesPerson.findMany({ where, orderBy: { code: 'asc' } })
    const filtered = all.filter((r) =>
      normQ(r.name).includes(nq) || String(r.code).includes(nq),
    )
    totalFiltered = filtered.length
    data = filtered.slice((page - 1) * pageSize, page * pageSize)
  }

  const [activeCount] = await Promise.all([
    prisma.salesPerson.count({ where: { ...dbScope, active: true } }),
  ])

  return NextResponse.json({
    data,
    total: totalFiltered,
    page,
    totalPages: Math.max(1, Math.ceil(totalFiltered / pageSize)),
    status: {
      configured: isSapConfigured(s),
      count: await prisma.salesPerson.count({ where: dbScope }),
      activeCount,
      lastSyncAt: await lastSyncAt(dbId),
    },
  })
}

// ---------- POST: đồng bộ ngay từ SAP B1 (ĐỒNG BỘ — OSLP rất ít dòng) ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đồng bộ nhân viên bán hàng' }, { status: 403 })
  }

  // Giới hạn: tối đa 5 lượt / 5 phút / user (đồng bộ là tác vụ nặng)
  const rl = rateLimit(`sync:salespersons:${user.id}`, 5, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Đã vượt giới hạn 5 lượt đồng bộ nhân viên bán hàng trong 5 phút — vui lòng thử lại sau ${rl.retryAfterSec} giây.` },
      { status: 429 },
    )
  }

  const s = await loadSapSettings(user.databaseId)
  if (!isSapConfigured(s)) {
    return NextResponse.json(
      { error: 'Chưa cấu hình SAP B1 Service Layer — hãy vào Cài đặt SAP B1 nhập URL, CompanyDB, tài khoản trước khi đồng bộ.' },
      { status: 400 },
    )
  }
  const syncDbId = s.dbId! // isSapConfigured đảm bảo s.dbId tồn tại

  const r = await sapGetAll<SlpRow>(
    s,
    '/SalesPersons',
    { $select: 'SlpCode,SlpName,Active', $orderby: 'SlpCode' },
  )
  if (!r.ok || !r.data) {
    return NextResponse.json(
      { error: `Không tải được nhân viên bán hàng từ SAP B1: ${r.error ?? 'lỗi không rõ'}` },
      { status: 502 },
    )
  }
  const rows = r.data.filter((x) => typeof x.SlpCode === 'number')
  if (rows.length === 0) {
    return NextResponse.json(
      { error: 'SAP B1 trả danh sách nhân viên bán hàng rỗng — chưa đồng bộ.' },
      { status: 502 },
    )
  }

  const now = new Date()
  const existingCodes = new Set(
    (await prisma.salesPerson.findMany({ select: { code: true } })).map((x) => x.code),
  )
  let created = 0
  let updated = 0
  // LƯU Ý SCHEMA: SalesPerson.code là @unique TOÀN CỤC (không theo DB) —
  // upsert theo code; DB khác có cùng SlpCode sẽ ghi đè bản ghi này.
  for (const x of rows) {
    const code = x.SlpCode as number
    const name = (x.SlpName ?? '').trim() || `NVBH ${code}`
    const data = {
      name,
      active: x.Active !== 'tNO',
      sapDatabaseId: syncDbId,
      syncedAt: now,
      updatedAt: now,
    }
    if (existingCodes.has(code)) {
      await prisma.salesPerson.update({ where: { code }, data })
      updated++
    } else {
      await prisma.salesPerson.create({ data: { code, createdAt: now, ...data } })
      existingCodes.add(code)
      created++
    }
  }

  return NextResponse.json({
    ok: true,
    created,
    updated,
    total: rows.length,
    message: `Đã đồng bộ ${rows.length} nhân viên bán hàng từ SAP B1 (${created} mới, ${updated} cập nhật).`,
  })
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
  await prisma.salesPerson.deleteMany({ where: dbScope })
  return NextResponse.json({ ok: true, message: 'Đã xóa toàn bộ dữ liệu nhân viên bán hàng đã đồng bộ.' })
}
