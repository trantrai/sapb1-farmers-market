import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { loadCustomers, clearCustomersCache } from '@/lib/fm-master'
import { startSync, updateSync, endSync, getProgress } from '@/lib/fm-sync-progress'

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

async function lastSyncAt(): Promise<Date | null> {
  const agg = await prisma.businessPartner.aggregate({ _max: { syncedAt: true } })
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

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const page = Math.max(1, Number(sp.get('page') ?? '1') || 1)
  const pageSize = Math.min(100, Math.max(5, Number(sp.get('pageSize') ?? '20') || 20))

  // Tìm kiếm không dấu: từ khóa có dấu → LIKE SQL tiền-lọc; thuần ASCII →
  // lấy hết rồi lọc không dấu tại chỗ (tránh loại nhầm dữ liệu có dấu).
  const hasNonAscii = /[^\x00-\x7F]/.test(q)
  const where: Record<string, unknown> = q && hasNonAscii
    ? {
        OR: [
          { cardCode: { contains: q } },
          { cardName: { contains: q } },
          { phone: { contains: q } },
          { email: { contains: q } },
        ],
      }
    : {}

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

  const s = await loadSapSettings()
  return NextResponse.json({
    data,
    total: totalFiltered,
    page,
    totalPages: Math.max(1, Math.ceil(totalFiltered / pageSize)),
    status: {
      configured: isSapConfigured(s),
      count: await prisma.businessPartner.count(),
      lastSyncAt: await lastSyncAt(),
      progress: getProgress('partners'),
    },
  })
}

// ---------- POST: đồng bộ ngay từ SAP B1 (CHẠY NỀN — trả 202 + progress qua GET) ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đồng bộ khách hàng' }, { status: 403 })
  }

  const s = await loadSapSettings()
  if (!isSapConfigured(s)) {
    return NextResponse.json(
      { error: 'Chưa cấu hình SAP B1 Service Layer — hãy vào Cài đặt SAP B1 nhập URL, CompanyDB, tài khoản trước khi đồng bộ.' },
      { status: 400 },
    )
  }

  if (!startSync('partners')) {
    return NextResponse.json({ error: 'Một lượt đồng bộ khác đang chạy — hãy đợi xong rồi thử lại.' }, { status: 409 })
  }

  void (async () => {
    try {
      const { rows, error } = await loadCustomers(s, (p) => updateSync('partners', p))
      if ((error && rows.length === 0) || rows.length === 0) {
        throw new Error(`Không tải được khách hàng từ SAP B1: ${error ?? '/BusinessPartners trả danh sách rỗng'}`)
      }
      const now = new Date()
      const payload = rows.map((p) => {
        const contact = primaryContact(p)
        return {
          cardCode: p.CardCode,
          cardName: p.CardName ?? p.CardCode,
          address: fullAddress(p),
          phone: p.Phone1 ?? null,
          email: p.EmailAddress ?? null,
          contactPerson: contact.name,
          contactPhone: contact.phone,
          groupType: 'Khách hàng',
          syncedAt: now,
        }
      })

      updateSync('partners', { phase: 'save', message: `Đang lưu ${payload.length.toLocaleString('vi-VN')} khách hàng vào CSDL…`, total: payload.length, processed: 0 })
      // Mirror trọn vẹn: bảng local phản ánh đúng danh mục khách hàng trên SAP
      await prisma.$transaction(async (tx) => {
        await tx.businessPartner.deleteMany()
        for (let i = 0; i < payload.length; i += 500) {
          await tx.businessPartner.createMany({ data: payload.slice(i, i + 500) })
          updateSync('partners', { processed: Math.min(i + 500, payload.length) })
        }
      })

      clearCustomersCache()
      endSync('partners', {
        message: `Đã đồng bộ ${payload.length.toLocaleString('vi-VN')} khách hàng từ SAP B1.`,
        processed: payload.length,
      })
    } catch (e) {
      console.error('POST /api/bpartners/sync (nền)', e)
      const msg = e instanceof Error ? e.message : 'Lỗi không rõ khi đồng bộ khách hàng'
      endSync('partners', { message: '', error: msg })
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

  await prisma.businessPartner.deleteMany()
  clearCustomersCache()
  return NextResponse.json({ ok: true, message: 'Đã xóa toàn bộ dữ liệu khách hàng đã đồng bộ.' })
}
