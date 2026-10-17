import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGetAll } from '@/lib/sap-service-layer'

interface B1Partner {
  CardCode: string
  CardName: string
  Address?: string
  Phone1?: string
  ContactEmployees?: Array<{
    Name?: string
    FirstName?: string
    LastName?: string
    Phone1?: string
    MobilePhone?: string
  }>
}

// Chuẩn hóa tìm kiếm không phân biệt hoa/thường + dấu tiếng Việt
const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')

// ---------- Cache danh sách khách hàng 5 phút ----------
// Từ khóa tìm kiếm được lọc TRÊN CACHE này, KHÔNG gửi substringof lên SL:
// nhiều bản Service Layer thật từ chối hàm/ngoặc tròn trong $filter với lỗi 400
// ("Query string error - the value 'true' of property ')' is invalid").
const PARTNERS_TTL = 5 * 60_000
let partnersCache: { ts: number; rows: B1Partner[] } | null = null

async function loadCustomers(s: {
  serviceLayerUrl: string; companyDb: string; sapUser: string; sapPassword: string; sslSkipVerify?: boolean
}): Promise<{ rows: B1Partner[]; error?: string }> {
  if (partnersCache && Date.now() - partnersCache.ts < PARTNERS_TTL) return { rows: partnersCache.rows }
  const live = await sapGetAll<B1Partner>(s, '/BusinessPartners', {
    $select: 'CardCode,CardName,Address,Phone1,ContactEmployees',
    $filter: `CardType eq 'C'`,
    $orderby: 'CardCode',
  })
  if (live.ok && live.data) {
    partnersCache = { ts: Date.now(), rows: live.data }
    return { rows: live.data }
  }
  // Cache cũ vẫn dùng được → dùng tạm thay vì báo lỗi (SL có thể đang gián đoạn)
  if (partnersCache) return { rows: partnersCache.rows }
  return { rows: [], error: live.error ?? 'Lỗi Service Layer' }
}

const toUi = (p: B1Partner, extra?: { addressesJson?: string | null; groupNum?: number | null }) => {
  const ce = Array.isArray(p.ContactEmployees) ? p.ContactEmployees : []
  const c = ce.find((x) => (x.Name ?? '').trim() !== '') ?? ce[0]
  const contactPerson = c ? ((c.Name ?? '').trim() || [c.FirstName, c.LastName].filter(Boolean).join(' ').trim() || '') : ''
  const contactPhone = c ? ((c.Phone1 ?? '').trim() || (c.MobilePhone ?? '').trim() || '') : ''
  return {
    id: '',
    cardCode: p.CardCode,
    cardName: p.CardName ?? p.CardCode,
    address: p.Address ?? '',
    phone: p.Phone1 ?? '',
    contactPerson,
    contactPhone,
    groupType: 'Khách hàng',
    // Đợt 2 — gộp địa chỉ + ĐKTT từ mirror local (đồng bộ qua /api/bpartners/sync)
    addressesJson: extra?.addressesJson ?? null,
    groupNum: extra?.groupNum ?? null,
  }
}

// GET /api/partners?q= — chọn khách hàng trong form SO
// Ưu tiên query TRỰC TIẾP từ SAP B1 Service Layer khi đã cấu hình
// (lấy TẤT CẢ khách hàng — tự phân trang theo đợt 500 bản ghi);
// nếu chưa cấu hình thì dùng dữ liệu local (SQLite).
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()

  // ---------- 1) Live query từ SAP B1 ----------
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  if (isSapConfigured(s)) {
    const { rows, error } = await loadCustomers(s)
    if (rows.length === 0 && error) {
      return NextResponse.json({ data: [], source: 'sap', error })
    }
    // Đợt 2 — gộp addressesJson/groupNum từ mirror local (đồng bộ qua /api/bpartners/sync)
    // để form chứng từ có dropdown địa chỉ giao/ghi hóa đơn ngay cả khi query live từ SAP.
    let mirror: Record<string, { addressesJson?: string | null; groupNum?: number | null }> = {}
    try {
      const codes = rows.map((p) => p.CardCode)
      const mrows = await prisma.businessPartner.findMany({
        where: { cardCode: { in: codes }, ...(dbId ? { sapDatabaseId: dbId } : {}) },
        select: { cardCode: true, addressesJson: true, groupNum: true },
      })
      for (const m of mrows) mirror[m.cardCode] = m
    } catch { /* mirror lỗi → vẫn trả dữ liệu SAP live */ }
    if (q) {
      // Lọc từ khóa tại chỗ trên cache (không substringof — an toàn mọi bản SL)
      const nq = norm(q)
      const data = rows
        .filter((p) => norm(p.CardCode).includes(nq) || norm(p.CardName ?? '').includes(nq) || norm(p.Phone1 ?? '').includes(nq))
        .slice(0, 100)
        .map((p) => toUi(p, mirror[p.CardCode]))
      return NextResponse.json({ data, total: data.length, source: 'sap' })
    }
    const data = rows.map((p) => toUi(p, mirror[p.CardCode]))
    return NextResponse.json({ data, total: data.length, source: 'sap' })
  }

  // ---------- 2) Fallback dữ liệu local (đúng database của phiên đăng nhập) ----------
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}
  const where: Record<string, unknown> = {
    ...dbScope,
    ...(q
      ? {
          OR: [
            { cardCode: { contains: q } },
            { cardName: { contains: q } },
          ],
        }
      : {}),
  }

  const partners = await prisma.businessPartner.findMany({
    where,
    orderBy: { cardCode: 'asc' },
  })
  return NextResponse.json({ data: partners, total: partners.length, source: 'local' })
}
