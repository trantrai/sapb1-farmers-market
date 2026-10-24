import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGetAll } from '@/lib/sap-service-layer'
import { rateLimit } from '@/lib/rate-limit'

// ============================================================
// ĐỒNG BỘ ĐIỀU KHOẢN THANH TOÁN — mirror danh mục
// /PaymentTermsTypes (OCTG) của SAP B1 vào bảng PaymentTerm local
// (GroupNum → code, PymntGroup → name):
//  · Màn hình "Đồng bộ ĐKTT" xem/tìm toàn bộ điều khoản thanh toán.
//  · GET /api/payment-terms dùng mirror này cho dropdown ĐKTT.
// OCTG rất ít dòng → POST chạy ĐỒNG BỘ trong request (không cần
// tiến trình nền như partners/vatgroups).
// GET    /api/payment-terms/sync?q=&page=&pageSize= — danh sách + trạng thái
// POST   /api/payment-terms/sync — đồng bộ ngay từ SAP B1 (cần quyền settings.edit)
// DELETE /api/payment-terms/sync — xóa toàn bộ dữ liệu đã đồng bộ (cần settings.edit)
// ============================================================

/**
 * Dòng /PaymentTermsTypes thô từ Service Layer. SL đặt tên field theo $metadata
 * (GroupNumber/PaymentTermsGroupName), KHÔNG theo cột OCTG (GroupNum/PymntGroup)
 * — đọc cả hai để tương thích.
 */
interface OctgRow {
  GroupNumber?: number
  PaymentTermsGroupName?: string
  GroupNum?: number
  PymntGroup?: string
  /** Số ngày cộng thêm tính ngày đáo hạn (chuẩn SAP B1:
   * DueDate = StartFrom + NumberOfAdditionalMonths + NumberOfAdditionalDays) */
  NumberOfAdditionalDays?: number
  NumberOfAdditionalMonths?: number
  /** Một số bản SL có Active (BoYesNoEnum) — không chắc chắn nên xử lý mềm */
  Active?: string | boolean
}

/** Quy đổi số tháng + số ngày của OCTG thành tổng số ngày (tháng ≈ 30 ngày) */
function octgToDays(r: OctgRow): number {
  const months = Number(r.NumberOfAdditionalMonths ?? 0)
  const days = Number(r.NumberOfAdditionalDays ?? 0)
  const total = (Number.isFinite(months) ? months : 0) * 30 + (Number.isFinite(days) ? days : 0)
  return Math.max(0, Math.round(total))
}

const normQ = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')

async function lastSyncAt(dbId?: string | null): Promise<Date | null> {
  const agg = await prisma.paymentTerm.aggregate({
    _max: { updatedAt: true },
    where: dbId ? { sapDatabaseId: dbId } : undefined,
  })
  return agg._max.updatedAt ?? null
}

// ---------- GET: danh sách local + trạng thái ----------
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục điều khoản thanh toán' }, { status: 403 })
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
    prisma.paymentTerm.count({ where }),
    prisma.paymentTerm.findMany({
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
    const all = await prisma.paymentTerm.findMany({ where, orderBy: { code: 'asc' } })
    const filtered = all.filter((r) =>
      normQ(r.name).includes(nq) || String(r.code).includes(nq),
    )
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
      count: await prisma.paymentTerm.count({ where: dbScope }),
      lastSyncAt: await lastSyncAt(dbId),
    },
  })
}

// ---------- POST: đồng bộ ngay từ SAP B1 (ĐỒNG BỘ — OCTG rất ít dòng) ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đồng bộ điều khoản thanh toán' }, { status: 403 })
  }

  // Giới hạn: tối đa 5 lượt / 5 phút / user (đồng bộ là tác vụ nặng)
  const rl = rateLimit(`sync:paymentterms:${user.id}`, 5, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Đã vượt giới hạn 5 lượt đồng bộ điều khoản thanh toán trong 5 phút — vui lòng thử lại sau ${rl.retryAfterSec} giây.` },
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

  const r = await sapGetAll<OctgRow>(
    s,
    '/PaymentTermsTypes',
    // Không dùng $select/$orderby — một số bản SAP B1 báo lỗi "Property invalid" với $select;
    // lấy toàn bộ field rồi lọc ở client (OCTG rất ít dòng nên không ảnh hưởng hiệu năng)
    {},
  )
  if (!r.ok || !r.data) {
    return NextResponse.json(
      { error: `Không tải được điều khoản thanh toán từ SAP B1: ${r.error ?? 'lỗi không rõ'}` },
      { status: 502 },
    )
  }
  const rows = r.data
    .map((x) => ({ ...x, GroupNum: x.GroupNumber ?? x.GroupNum, PymntGroup: x.PaymentTermsGroupName ?? x.PymntGroup }))
    .filter((x) => typeof x.GroupNum === 'number')
    // Khử trùng theo mã (SL không hỗ trợ $skip có thể trả lặp trang)
    .filter((x, i, arr) => arr.findIndex((y) => y.GroupNum === x.GroupNum) === i)
    .sort((a, b) => (a.GroupNum as number) - (b.GroupNum as number))
  if (rows.length === 0) {
    return NextResponse.json(
      { error: 'SAP B1 trả danh sách điều khoản thanh toán rỗng — chưa đồng bộ.' },
      { status: 502 },
    )
  }

  const now = new Date()
  const existingCodes = new Set(
    (await prisma.paymentTerm.findMany({ select: { code: true } })).map((x) => x.code),
  )
  let created = 0
  let updated = 0
  // LƯU Ý SCHEMA: PaymentTerm.code là @unique TOÀN CỤC (không theo DB) —
  // upsert theo code; DB khác có cùng GroupNum sẽ ghi đè bản ghi này.
  for (const x of rows) {
    const code = x.GroupNum as number
    const name = (x.PymntGroup ?? '').trim() || `ĐKTT ${code}`
    const data = {
      name,
      // Chuẩn SAP B1: ngày đáo hạn = mốc + số tháng + số ngày (tháng ≈ 30 ngày)
      days: octgToDays(x),
      sapDatabaseId: syncDbId,
      updatedAt: now,
    }
    if (existingCodes.has(code)) {
      await prisma.paymentTerm.update({ where: { code }, data })
      updated++
    } else {
      await prisma.paymentTerm.create({ data: { code, createdAt: now, ...data } })
      existingCodes.add(code)
      created++
    }
  }

  return NextResponse.json({
    ok: true,
    created,
    updated,
    total: rows.length,
    message: `Đã đồng bộ ${rows.length} điều khoản thanh toán từ SAP B1 (${created} mới, ${updated} cập nhật).`,
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
  await prisma.paymentTerm.deleteMany({ where: dbScope })
  return NextResponse.json({ ok: true, message: 'Đã xóa toàn bộ dữ liệu điều khoản thanh toán đã đồng bộ.' })
}
