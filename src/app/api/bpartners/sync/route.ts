import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, SyncCancelled, sapGetAll } from '@/lib/sap-service-layer'
import { rateLimit } from '@/lib/rate-limit'
import { loadCustomers, loadCustomersDelta, mergeCustomersCache, clearCustomersCache } from '@/lib/fm-master'
import { startSync, updateSync, endSync, getProgress, requestSyncCancel, isSyncCancelRequested } from '@/lib/fm-sync-progress'
import {
  getWatermark, setWatermark, clearWatermark, watermarkInfo, advanceWatermark,
  type DeltaWatermark,
} from '@/lib/fm-sync-delta'

// ============================================================
// ĐỒNG BỘ KHÁCH HÀNG — mirror danh mục /BusinessPartners của
// SAP B1 vào bảng BusinessPartner local (chỉ KHÁCH HÀNG,
// CardType='C' — không kéo Nhà cung cấp/khách tiềm năng):
//  · Màn hình "Đồng bộ Khách hàng" xem/tìm toàn bộ khách hàng.
//  · Dữ liệu local là dự phòng cho form khi Service Layer mất kết nối.
// GET    /api/bpartners/sync?q=&page=&pageSize= — danh sách + trạng thái
// POST   /api/bpartners/sync — đồng bộ ngay từ SAP B1 (cần quyền settings.edit)
// DELETE /api/bpartners/sync — xóa toàn bộ dữ liệu đã đồng bộ (cần settings.edit)
// ============================================================

const normQ = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')

async function lastSyncAt(dbId?: string | null): Promise<Date | null> {
  const agg = await prisma.businessPartner.aggregate({
    _max: { syncedAt: true },
    where: dbId ? { sapDatabaseId: dbId } : undefined,
  })
  return agg._max.syncedAt ?? null
}

/** Người liên hệ chính: ContactEmployees[0] (ưu tiên có tên) */
function primaryContact(p: { ContactEmployees?: Array<{ Name?: string; FirstName?: string; LastName?: string; Phone1?: string; MobilePhone?: string }> }): { name: string | null; phone: string | null } {
  const list = Array.isArray(p.ContactEmployees) ? p.ContactEmployees : []
  const c = list.find((x) => (x.Name ?? '').trim() !== '') ?? list[0]
  if (!c) return { name: null, phone: null }
  const name = (c.Name ?? '').trim() || [c.FirstName, c.LastName].filter(Boolean).join(' ').trim() || null
  const phone = (c.Phone1 ?? '').trim() || (c.MobilePhone ?? '').trim() || null
  return { name, phone }
}

/** Địa chỉ đầy đủ: ưu tiên địa chỉ BillTo trong BPAddresses, fallback sang trường Address */
function fullAddress(p: { Address?: string; BPAddresses?: Array<{ AddressType?: string; Street?: string; City?: string; ZipCode?: string; Country?: string }> }): string | null {
  const list = Array.isArray(p.BPAddresses) ? p.BPAddresses : []
  const billTo = list.find((a) => a.AddressType === 'B') ?? list[0]
  if (billTo) {
    const parts = [billTo.Street, billTo.City, billTo.ZipCode, billTo.Country].map((x) => (x ?? '').trim()).filter(Boolean)
    if (parts.length > 0) return parts.join(', ')
  }
  return (p.Address ?? '').trim() || null
}

// ---------- GET: danh sách local + trạng thái ----------
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục khách hàng' }, { status: 403 })
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
      ? {
          OR: [
            { cardCode: { contains: q } },
            { cardName: { contains: q } },
            { phone: { contains: q } },
            { email: { contains: q } },
          ],
        }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.businessPartner.count({ where }),
    prisma.businessPartner.findMany({
      where,
      orderBy: { cardCode: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  // Lọc không dấu + tính lại phân trang khi có từ khóa
  let data = rows
  let totalFiltered = total
  if (q && !hasNonAscii) {
    const nq = normQ(q)
    const all = await prisma.businessPartner.findMany({ where, orderBy: { cardCode: 'asc' } })
    const filtered = all.filter((r) =>
      normQ(r.cardCode).includes(nq) || normQ(r.cardName).includes(nq) ||
      normQ(r.phone ?? '').includes(nq) || normQ(r.email ?? '').includes(nq),
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
      count: await prisma.businessPartner.count({ where: dbScope }),
      lastSyncAt: await lastSyncAt(dbId),
      watermark: await watermarkInfo(dbId, 'partners').catch(() => null),
      progress: getProgress('partners'),
    },
  })
}

// ---------- POST: đồng bộ từ SAP B1 (CHẠY NỀN — trả 202 + progress qua GET) ----------
// Body JSON: { mode?: 'incremental' | 'full' }
//  · 'incremental' — chỉ tải khách hàng thay đổi kể từ mốc (UpdateDate, UpdateTime)
//    đã lưu, upsert vào mirror (mặc định khi đã có mốc).
//  · 'full' — tải toàn bộ khách hàng, thay mới mirror (mặc định khi chưa có mốc).
// LƯU Ý: gia tăng không phát hiện bản ghi BỊ XÓA trên SAP — nên chạy toàn phần
// định kỳ để mirror khớp hẳn danh mục SAP.
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đồng bộ khách hàng' }, { status: 403 })
  }

  // M10: đồng bộ là tác vụ nặng — tối đa 5 lượt / 5 phút / user
  const rl = rateLimit(`sync:partners:${user.id}`, 5, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Đã vượt giới hạn 5 lượt đồng bộ khách hàng trong 5 phút — vui lòng thử lại sau ${rl.retryAfterSec} giây.` },
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

  if (!startSync('partners')) {
    return NextResponse.json({ error: 'Một lượt đồng bộ khác đang chạy — hãy đợi xong rồi thử lại.' }, { status: 409 })
  }

  let bodyMode: string | undefined
  try {
    bodyMode = (await req.json())?.mode
  } catch { /* không có body */ }
  // Graceful fallback: neu Prisma client/bang SyncWatermark chua duoc generate/push
  // (vd quen chay generate sau khi pull) thi chay full sync thay vi crash 500.
  const wm0 = await getWatermark(syncDbId, 'partners').catch(() => null)
  const mode: 'full' | 'incremental' =
    bodyMode === 'full' ? 'full'
    : bodyMode === 'incremental' ? (wm0 ? 'incremental' : 'full')
    : wm0 ? 'incremental' : 'full'

  void (async () => {
    try {
      if (mode === 'incremental' && wm0) {
        await syncIncremental(s, syncDbId, wm0)
      } else {
        await syncFull(s, syncDbId)
      }
    } catch (e) {
      // DỪNG THEO YÊU CẦU (nút "Dừng" trên UI) → kết thúc nhẹ nhàng, không báo lỗi
      if (e instanceof SyncCancelled || isSyncCancelRequested('partners')) {
        console.log('POST /api/bpartners/sync (nền): đã dừng theo yêu cầu người dùng')
        endSync('partners', { message: 'Đã dừng đồng bộ khách hàng theo yêu cầu người dùng.' })
        return
      }
      console.error('POST /api/bpartners/sync (nền)', e)
      const msg = e instanceof Error ? e.message : 'Lỗi không rõ khi đồng bộ khách hàng'
      endSync('partners', { message: '', error: msg })
    }
  })()

  return NextResponse.json(
    {
      ok: true,
      started: true,
      mode,
      message: mode === 'incremental'
        ? 'Đã bắt đầu đồng bộ GIA TĂNG từ SAP B1 — chỉ tải khách hàng thay đổi kể từ mốc đã lưu.'
        : 'Đã bắt đầu đồng bộ TOÀN PHẦN từ SAP B1 — tác vụ chạy nền trên máy chủ.',
    },
    { status: 202 },
  )
}

type SapCfg = NonNullable<Awaited<ReturnType<typeof loadSapSettings>>>

/**
 * Chuẩn hóa BPAddresses của SAP thành JSON gọn lưu vào addressesJson.
 *
 * SHAPE ĐÃ CHỌN (2026-10-17, Đợt 2+3):
 *   [{ code, name, detail: "Street, City", type: 'B' | 'S' | 'BS' }]
 *  - code/name = SAP AddressName (BPAddresses không có trường tên riêng).
 *  - detail = "Street, City" (nối bằng dấu phẩy; trống → "").
 *  - type: 'B' = bo_BillTo (địa chỉ ghi hóa đơn), 'S' = bo_ShipTo (địa chỉ
 *    giao hàng). GỘP theo AddressName: cùng 1 AddressName có cả 2 loại
 *    (B và S) → 1 entry duy nhất type 'BS' (thay vì 2 entry trùng địa chỉ)
 *    để form chọn địa chỉ giao/hóa đơn gọn và không trùng lặp.
 */
function buildAddressesJson(
  list?: Array<{ AddressName?: string; AddressType?: string; Street?: string; City?: string; ZipCode?: string; Country?: string }>,
): string | null {
  if (!Array.isArray(list) || list.length === 0) return null
  const byCode = new Map<string, { code: string; name: string; detail: string; type: 'B' | 'S' | 'BS' }>()
  for (const a of list ?? []) {
    const code = (a.AddressName ?? '').trim()
    if (!code) continue
    const t: 'B' | 'S' = a.AddressType === 'S' ? 'S' : 'B'
    const detail = [a.Street, a.City].map((x) => (x ?? '').trim()).filter(Boolean).join(', ')
    const cur = byCode.get(code)
    if (cur) {
      // Cùng AddressName có cả 2 loại → gộp thành 'BS'
      if (cur.type !== t) cur.type = 'BS'
      if (!cur.detail && detail) cur.detail = detail
    } else {
      byCode.set(code, { code, name: code, detail, type: t })
    }
  }
  if (byCode.size === 0) return null
  return JSON.stringify([...byCode.values()])
}

function toPayload(p: {
  CardCode: string
  CardName?: string
  Address?: string
  Phone1?: string
  EmailAddress?: string
  GroupNum?: number
  ContactEmployees?: Array<{ Name?: string; FirstName?: string; LastName?: string; Phone1?: string; MobilePhone?: string }>
  BPAddresses?: Array<{ AddressName?: string; AddressType?: string; Street?: string; City?: string; ZipCode?: string; Country?: string }>
}, syncDbId: string, now: Date, groupNums: Map<string, number>) {
  const contact = primaryContact(p)
  return {
    sapDatabaseId: syncDbId,
    cardCode: p.CardCode,
    cardName: p.CardName ?? p.CardCode,
    address: fullAddress(p),
    phone: p.Phone1 ?? null,
    email: p.EmailAddress ?? null,
    contactPerson: contact.name,
    contactPhone: contact.phone,
    groupType: 'Khách hàng',
    // Đợt 2+3: điều khoản thanh toán (OCRD.GroupNum) — ưu tiên từ query phụ
    // (loadCustomers $select không gồm GroupNum), fallback sang bản ghi gốc.
    groupNum: groupNums.get(p.CardCode) ?? (typeof p.GroupNum === 'number' ? p.GroupNum : null),
    addressesJson: buildAddressesJson(p.BPAddresses),
    syncedAt: now,
  }
}

/**
 * Tải map CardCode → GroupNum (OCRD.GroupNum — điều khoản thanh toán) bằng
 * 1 query $select gọn. Cần thiết vì loadCustomers/loadCustomersDelta dùng
 * $select cố định KHÔNG gồm GroupNum (không sửa fm-master.ts ở đợt này).
 * Lỗi SL → trả map rỗng, caller fallback sang GroupNum trên bản ghi gốc.
 */
async function loadGroupNums(
  s: SapCfg,
  opts?: { shouldCancel?: () => boolean },
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    const r = await sapGetAll<{ CardCode?: string; GroupNum?: number }>(
      s,
      '/BusinessPartners',
      { $select: 'CardCode,GroupNum', $filter: `CardType eq 'C'`, $orderby: 'CardCode' },
      opts,
    )
    if (r.ok && r.data) {
      for (const p of r.data) {
        if (typeof p.CardCode === 'string' && typeof p.GroupNum === 'number') {
          map.set(p.CardCode, p.GroupNum)
        }
      }
    }
  } catch {
    /* SL gián đoạn — caller fallback */
  }
  return map
}

/** Đồng bộ toàn phần: tải hết khách hàng, thay mới mirror, đặt lại mốc watermark */
async function syncFull(s: SapCfg, syncDbId: string) {
  const shouldCancel = () => isSyncCancelRequested('partners')
  const { rows, error } = await loadCustomers(s, (p) => updateSync('partners', p), { shouldCancel })
  if ((error && rows.length === 0) || rows.length === 0) {
    throw new Error(`Không tải được khách hàng từ SAP B1: ${error ?? '/BusinessPartners trả danh sách rỗng'}`)
  }
  const now = new Date()
  // Đợt 2+3: GroupNum không nằm trong $select của loadCustomers → tải riêng
  const groupNums = await loadGroupNums(s, { shouldCancel })
  const payload = rows.map((p) => toPayload(p, syncDbId, now, groupNums))

  updateSync('partners', { phase: 'save', message: `Đang lưu ${payload.length.toLocaleString('vi-VN')} khách hàng vào CSDL…`, total: payload.length, processed: 0 })
  // Mirror trọn vẹn: bảng local phản ánh đúng danh mục khách hàng trên SAP
  // B5: không ôm transaction dài (xem items/sync)
  // Kiểm tra cancel TRƯỚC khi xóa — tránh bảng rỗng nếu user dừng giữa chừng
  if (shouldCancel()) throw new SyncCancelled()
  await prisma.businessPartner.deleteMany({ where: { sapDatabaseId: syncDbId } })
  for (let i = 0; i < payload.length; i += 500) {
    if (shouldCancel()) throw new SyncCancelled()
    await prisma.businessPartner.createMany({ data: payload.slice(i, i + 500) })
    updateSync('partners', { processed: Math.min(i + 500, payload.length) })
  }

  const wm = advanceWatermark(null, rows)
  await setWatermark(syncDbId, 'partners', wm, 'full')
  endSync('partners', {
    message: `Đã đồng bộ TOÀN PHẦN ${payload.length.toLocaleString('vi-VN')} khách hàng từ SAP B1.`,
    processed: payload.length,
  })
}

/** Đồng bộ gia tăng: chỉ tải khách hàng đổi kể từ mốc, upsert vào mirror, nâng mốc */
async function syncIncremental(s: SapCfg, syncDbId: string, wm: DeltaWatermark) {
  const shouldCancel = () => isSyncCancelRequested('partners')
  const { rows, error } = await loadCustomersDelta(s, wm, (p) => updateSync('partners', p), { shouldCancel })
  if (error) {
    throw new Error(`Không tải được khách hàng thay đổi từ SAP B1: ${error}`)
  }
  const now = new Date()

  if (rows.length === 0) {
    await setWatermark(syncDbId, 'partners', wm, 'incremental')
    endSync('partners', {
      message: `Không có khách hàng nào thay đổi trên SAP B1 kể từ mốc ${wm.date}. Mirror giữ nguyên.`,
      processed: 0,
    })
    return
  }

  updateSync('partners', { phase: 'save', message: `Đang cập nhật ${rows.length.toLocaleString('vi-VN')} khách hàng thay đổi…`, total: rows.length, processed: 0 })
  // Đợt 2+3: GroupNum không nằm trong $select của loadCustomersDelta → tải riêng
  const groupNums = await loadGroupNums(s, { shouldCancel })
  // M11: gom upsert thành batch (chunk 100, mỗi chunk 1 $transaction) thay vì
  // await từng dòng nối tiếp (O(n) round-trip SQLite).
  const ops = rows.map((p) => {
    const data = toPayload(p, syncDbId, now, groupNums)
    return prisma.businessPartner.upsert({
      where: { sapDatabaseId_cardCode: { sapDatabaseId: syncDbId, cardCode: p.CardCode } },
      create: data,
      update: data,
    })
  })
  const CHUNK = 100
  for (let i = 0; i < ops.length; i += CHUNK) {
    if (shouldCancel()) throw new SyncCancelled()
    await prisma.$transaction(ops.slice(i, i + CHUNK))
    updateSync('partners', { processed: Math.min(i + CHUNK, ops.length) })
  }

  // Trộn delta vào cache để lần tìm sau dùng ngay dữ liệu mới
  mergeCustomersCache(s, rows)

  const newWm = advanceWatermark(wm, rows)
  await setWatermark(syncDbId, 'partners', newWm, 'incremental')
  endSync('partners', {
    message: `Đã đồng bộ GIA TĂNG ${rows.length.toLocaleString('vi-VN')} khách hàng thay đổi từ SAP B1 (mốc ${wm.date} → ${newWm.date}).`,
    processed: rows.length,
  })
}

// ---------- PATCH: YÊU CẦU DỪNG lượt đồng bộ đang chạy (cần quyền settings.edit)
// Nút "Dừng" trên UI gọi vào đây; tác vụ nền tự dừng ở checkpoint tiếp theo.
export async function PATCH(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền dừng đồng bộ khách hàng' }, { status: 403 })
  }
  const ok = requestSyncCancel('partners')
  return NextResponse.json(
    ok
      ? { ok: true, message: 'Đã gửi yêu cầu dừng — lượt đồng bộ sẽ kết thúc ở checkpoint tiếp theo.' }
      : { ok: false, error: 'Không có lượt đồng bộ khách hàng nào đang chạy.' },
    { status: ok ? 200 : 409 },
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
  await prisma.businessPartner.deleteMany({ where: dbScope })
  if (s?.dbId) await clearWatermark(s.dbId, 'partners') // xóa mốc → lần sau đồng bộ toàn phần
  clearCustomersCache(s?.dbId)
  return NextResponse.json({ ok: true, message: 'Đã xóa toàn bộ dữ liệu khách hàng đã đồng bộ.' })
}
