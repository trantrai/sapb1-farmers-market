import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapDeliveries, clearSapDeliveriesCache, type SapDeliveryRow } from '@/lib/sap-deliveries'

// ============================================================
// B2B / SAP B1 (Đợt 2+3): whitelist + chuẩn hóa các trường header
// (bản sao của helper trong src/app/api/orders/route.ts — tách riêng để
//  mỗi resource tự chủ, tránh import chéo giữa các route)
// ============================================================
const B2B_CURRENCIES = ['VND', 'USD', 'EUR', 'JPY']

interface B2BHeaderData {
  salesPersonCode?: number | null
  paymentGroupCode?: number | null
  shipToCode?: string | null
  billToCode?: string | null
  numAtCard?: string | null
  taxDate?: Date | null
  docCurrency?: string
  docRate?: number | null
  projectCode?: string | null
  attachmentsJson?: string | null
  reqDate?: Date | null
}

/** Đọc + validate các trường B2B từ body.
 *  Key vắng mặt → undefined (Prisma bỏ qua: giữ default khi tạo, giữ cũ khi sửa).
 *  Trả { data, error }: error != null → 400. */
export function parseB2BHeader(body: Record<string, unknown>): { data: B2BHeaderData; error?: string } {
  const data: B2BHeaderData = {}

  const optInt = (key: 'salesPersonCode' | 'paymentGroupCode', label: string): string | undefined => {
    if (!(key in body)) return undefined
    const v = body[key]
    if (v === null || v === undefined || v === '') { data[key] = null; return undefined }
    const n = Number(v)
    if (!Number.isFinite(n)) return `${label} không hợp lệ`
    data[key] = Math.trunc(n)
    return undefined
  }
  const optStr = (key: 'shipToCode' | 'billToCode' | 'numAtCard' | 'projectCode', max: number): string | undefined => {
    if (!(key in body)) return undefined
    const s = String(body[key] ?? '').trim()
    if (s.length > max) return `Trường ${key} vượt quá ${max} ký tự`
    data[key] = s === '' ? null : s
    return undefined
  }
  const optDate = (key: 'taxDate' | 'reqDate', label: string): string | undefined => {
    if (!(key in body)) return undefined
    const v = body[key]
    if (v === null || v === undefined || String(v).trim() === '') { data[key] = null; return undefined }
    const d = new Date(String(v))
    if (Number.isNaN(d.getTime())) return `${label} không hợp lệ`
    data[key] = d
    return undefined
  }

  let err: string | undefined
  err = optInt('salesPersonCode', 'Mã nhân viên bán hàng')
  if (err) return { data, error: err }
  err = optInt('paymentGroupCode', 'Mã điều khoản thanh toán')
  if (err) return { data, error: err }
  err = optStr('shipToCode', 50)
  if (err) return { data, error: err }
  err = optStr('billToCode', 50)
  if (err) return { data, error: err }
  err = optStr('numAtCard', 100)
  if (err) return { data, error: err }
  err = optStr('projectCode', 50)
  if (err) return { data, error: err }
  err = optDate('taxDate', 'Ngày tính thuế')
  if (err) return { data, error: err }
  err = optDate('reqDate', 'Ngày cần giao')
  if (err) return { data, error: err }

  if ('docCurrency' in body) {
    const c = String(body.docCurrency ?? '').trim().toUpperCase()
    data.docCurrency = B2B_CURRENCIES.includes(c) ? c : 'VND'
  }
  if ('docRate' in body) {
    const v = body.docRate
    if (v === null || v === undefined || v === '') {
      data.docRate = null
    } else {
      const r = Number(v)
      if (!Number.isFinite(r) || r <= 0) return { data, error: 'Tỷ giá phải là số lớn hơn 0' }
      data.docRate = r
    }
  }
  if ('attachmentsJson' in body) {
    const v = body.attachmentsJson
    if (v === null || v === undefined || v === '') {
      data.attachmentsJson = null
    } else {
      let arr: unknown
      if (typeof v === 'string') {
        try { arr = JSON.parse(v) } catch { return { data, error: 'Đính kèm không phải JSON hợp lệ' } }
      } else {
        arr = v
      }
      if (!Array.isArray(arr)) return { data, error: 'Đính kèm phải là mảng [{name,url}]' }
      const clean = arr
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({
          name: String((a as { name?: unknown }).name ?? '').trim().slice(0, 200),
          url: String((a as { url?: unknown }).url ?? '').trim().slice(0, 500),
        }))
        .filter((a) => a.name || a.url)
        .slice(0, 50)
      data.attachmentsJson = clean.length > 0 ? JSON.stringify(clean) : null
    }
  }
  return { data }
}

// GET /api/deliveries — danh sách (filter: q, status, page, pageSize)
// Khi đã cấu hình SAP B1 → lấy TOÀN BỘ phiếu TRỰC TIẾP từ Service Layer
// (GET /DeliveryNotes) rồi gộp với các phiếu local CHƯA đẩy sang SAP
// (pending/none). Phiếu local đã synced bị ẩn nếu SAP đã có chứng từ cùng DocEntry.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem giao hàng' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const q = (sp.get('q') ?? '').trim()
  const status = sp.get('status') ?? ''
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(50, Math.max(5, parseInt(sp.get('pageSize') ?? '10', 10) || 10))
  // Phase 2: lọc nháp — ?isDraft=true chỉ lấy nháp, ?isDraft=false chỉ lấy chính thức
  const isDraftParam = sp.get('isDraft') ?? ''

  // ---------- 1) Chứng từ từ SAP B1 (nếu đã cấu hình) ----------
  // Phiếu lấy từ đúng database đã chọn khi đăng nhập.
  // 'Cancelled' là trạng thái local — SAP chỉ có Open/Closed nên không tải.
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? user.databaseId ?? null
  let sapRows: SapDeliveryRow[] = []
  let warning = ''
  let source: 'sap' | 'local' = 'local'
  // fresh=1 (nút "Tải lại") → bỏ qua cache 45s, tải mới trực tiếp từ SAP B1
  // Phase 2: khi lọc nháp thì chỉ đọc local — SAP không có khái niệm nháp gộp ở đây
  if (isSapConfigured(s) && status !== 'Cancelled' && sp.get('fresh') === '1' && isDraftParam === '') {
    clearSapDeliveriesCache()
  }
  if (isSapConfigured(s) && status !== 'Cancelled' && isDraftParam === '') {
    const live = await fetchSapDeliveries(s, { q, status })
    if (live.ok && live.data) {
      sapRows = live.data
      source = 'sap'
      if (live.warning) warning = live.warning
    } else {
      // SAP lỗi → vẫn hiển thị phiếu local, kèm cảnh báo
      warning = `Không truy vấn được SAP B1 (${live.error ?? 'lỗi không rõ'}) — đang hiển thị phiếu local`
    }
  }

  // ---------- 1b) Phiếu SAP nào có bản ghi local? (để mở chi tiết local) ----------
  const sapEntries = sapRows.map((r) => r.sapDocEntry).filter((x): x is number => x != null)
  const localByEntry = new Map<number, string>()
  if (sapEntries.length > 0) {
    const syncedLocals = await prisma.delivery.findMany({
      where: {
        sapSyncStatus: 'synced',
        sapDocEntry: { in: sapEntries },
        ...(dbId ? { sapDatabaseId: dbId } : {}),
      },
      select: { id: true, sapDocEntry: true },
    })
    for (const d of syncedLocals) if (d.sapDocEntry != null) localByEntry.set(d.sapDocEntry, d.id)
  }
  if (sapRows.length > 0) {
    sapRows = sapRows.map((r) => ({ ...r, localId: (r.sapDocEntry != null ? localByEntry.get(r.sapDocEntry) : null) ?? null }))
  }

  // ---------- 2) Phiếu local (gộp: các phiếu chưa đẩy / SAP không còn) ----------
  const where: Record<string, unknown> = {}
  // B1: cách ly DB (kèm phiếu NULL sapDatabaseId — tạo trước khi có multi-DB)
  const andConds: Record<string, unknown>[] = []
  if (dbId) andConds.push({ OR: [{ sapDatabaseId: dbId }, { sapDatabaseId: null }] })
  if (q) {
    andConds.push({
      OR: [
        { cardCode: { contains: q } },
        { cardName: { contains: q } },
        { numAtCard: { contains: q } },
        ...(isNaN(Number(q)) ? [] : [{ docNum: Number(q) }]),
      ],
    })
  }
  if (andConds.length > 0) where.AND = andConds
  if (['Open', 'Closed', 'Cancelled'].includes(status)) where.status = status
  // NULL isDraft (phiếu cũ) coi như chính thức
  if (isDraftParam === 'true') where.isDraft = true
  else if (isDraftParam === 'false') where.isDraft = false

  const localRows = await prisma.delivery.findMany({
    where,
    orderBy: { docNum: 'desc' },
    include: {
      lines: { orderBy: { lineNum: 'asc' } },
      sourceOrder: { select: { id: true, docNum: true } },
    },
  })
  const slEntries = new Set(sapRows.map((r) => r.sapDocEntry))
  const localOnly = localRows.filter(
    (o) => !(o.sapSyncStatus === 'synced' && o.sapDocEntry != null && slEntries.has(o.sapDocEntry)),
  )

  // ---------- 3) Gộp + sắp xếp + phân trang trên máy chủ ----------
  // docNum null (nháp) xếp cuối — ?? 0 để sort không vỡ với null (Phase 2)
  const merged = [
    ...sapRows,
    ...localOnly.map((o) => ({ ...o, source: 'local' as const })),
  ].sort((a, b) => (b.docNum ?? 0) - (a.docNum ?? 0))

  const total = merged.length
  const data = merged.slice((page - 1) * pageSize, page * pageSize)

  return NextResponse.json({
    ok: true,
    data,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    source,
    ...(warning ? { warning } : {}),
  })
}

// POST /api/deliveries — tạo delivery thủ công
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo phiếu giao hàng' }, { status: 403 })
  }
  const rl = rateLimit(`delivery:create:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  let body: {
    cardCode?: string; cardName?: string; docDate?: string; remarks?: string
    sourceOrderId?: string; warehouseCode?: string
    /** B2B / SAP B1 (Đợt 2+3) — parse chi tiết bằng parseB2BHeader (whitelist) */
    salesPersonCode?: unknown; paymentGroupCode?: unknown; shipToCode?: unknown; billToCode?: unknown
    numAtCard?: unknown; taxDate?: unknown; docCurrency?: unknown; docRate?: unknown
    projectCode?: unknown; attachmentsJson?: unknown; reqDate?: unknown
    /** Ghi chú soạn/đóng gói (SAP PickAndPackNotes) */
    pickAndPackNotes?: string
    /** CK đầu chứng từ % (SAP DiscountPercent) */
    headerDiscPct?: number
    lines?: Array<{ itemCode: string; itemName: string; quantity: number; uom?: string; unitPrice?: number; taxCode?: string; discPct?: number; sourceOrderLineId?: string; warehouseCode?: string; batchNumber?: string }>
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
  }
  const cardCode = String(body.cardCode ?? '').trim()
  const cardName = String(body.cardName ?? '').trim()
  if (!cardCode || !cardName) {
    return NextResponse.json({ error: 'Vui lòng nhập mã và tên khách hàng' }, { status: 400 })
  }
  // B2B / SAP B1 (Đợt 2+3): whitelist + validate các trường header mới
  const { data: b2b, error: b2bError } = parseB2BHeader(body as unknown as Record<string, unknown>)
  if (b2bError) {
    return NextResponse.json({ error: b2bError }, { status: 400 })
  }
  // CK đầu chứng từ % (SAP DiscountPercent) — 0–100
  let headerDiscPct = 0
  if (body.headerDiscPct !== undefined && body.headerDiscPct !== null && String(body.headerDiscPct) !== '') {
    const hp = Number(body.headerDiscPct)
    if (!Number.isFinite(hp) || hp < 0 || hp > 100) {
      return NextResponse.json({ error: 'Chiết khấu đầu chứng từ phải từ 0 đến 100%' }, { status: 400 })
    }
    headerDiscPct = hp
  }
  // Ghi chú soạn/đóng gói (SAP PickAndPackNotes)
  const pickAndPackNotes = String(body.pickAndPackNotes ?? '').trim() || null
  // Kho xuất hàng header (SAP DeliveryNotes.WarehouseCode) — rỗng = để SAP tự mặc định
  const headerWarehouseCode = String(body.warehouseCode ?? '').trim() || null
  // Giới hạn 200 dòng / phiếu
  if (Array.isArray(body.lines) && body.lines.length > 200) {
    return NextResponse.json({ error: 'Phiếu giao hàng tối đa 200 dòng' }, { status: 400 })
  }
  // Validate đơn nguồn (nếu có): phải tồn tại và cùng database với user (cách ly DB)
  const sourceOrderId = String(body.sourceOrderId ?? '').trim() || null
  if (sourceOrderId) {
    const sourceOrder = await prisma.salesOrder.findUnique({
      where: { id: sourceOrderId },
      select: { id: true, sapDatabaseId: true },
    })
    if (!sourceOrder || (user.databaseId && sourceOrder.sapDatabaseId && sourceOrder.sapDatabaseId !== user.databaseId)) {
      return NextResponse.json({ error: 'Đơn nguồn không hợp lệ' }, { status: 400 })
    }
  }
  // Ép kiểu + validate từng dòng: quantity phải là số hữu hạn > 0,
  // unitPrice phải là số hữu hạn và >= 0 (tránh string lọt vào Prisma gây 500).
  // lineTotal = thành tiền SAU chiết khấu dòng (làm tròn từng dòng, đồng bộ với order-calc).
  const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0)
  const lines = (Array.isArray(body.lines) ? body.lines : [])
    .map((l) => ({
      itemCode: String(l?.itemCode ?? '').trim(),
      itemName: String(l?.itemName ?? l?.itemCode ?? '').trim(),
      quantity: Number(l?.quantity),
      uom: String(l?.uom ?? ''),
      unitPrice: Number(l?.unitPrice ?? 0),
      taxCode: String(l?.taxCode ?? '').trim() || null,
      discPct: clampPct(Number(l?.discPct ?? 0)),
      sourceOrderLineId: String(l?.sourceOrderLineId ?? '').trim() || null,
      warehouseCode: String(l?.warehouseCode ?? '').trim() || headerWarehouseCode,
      /** Số lô (SAP BatchNumbers) — truy xuất nguồn gốc */
      batchNumber: String(l?.batchNumber ?? '').trim().slice(0, 50) || null,
      lineTotal: 0,
    }))
    .filter(
      (l) =>
        l.itemCode.length > 0 &&
        Number.isFinite(l.quantity) && l.quantity > 0 &&
        Number.isFinite(l.unitPrice) && l.unitPrice >= 0,
    )
    .map((l) => {
      const lt = Math.round(l.quantity * l.unitPrice)
      return { ...l, lineTotal: lt - Math.round((lt * l.discPct) / 100) }
    })
  if (lines.length === 0) {
    return NextResponse.json({ error: 'Phiếu giao hàng cần ít nhất 1 dòng' }, { status: 400 })
  }
  // docDate sai định dạng → từ chối 400 thay vì để Prisma ném 500 (Invalid Date)
  let docDate = new Date()
  if (body.docDate !== undefined && body.docDate !== null && String(body.docDate).trim() !== '') {
    docDate = new Date(String(body.docDate))
    if (isNaN(docDate.getTime())) {
      return NextResponse.json({ error: 'Ngày chứng từ không hợp lệ' }, { status: 400 })
    }
  }

  // grandTotal = tổng các lineTotal đã round TRỪ chiết khấu đầu chứng từ
  // (headerDiscPct = 0 → giữ nguyên cách tính cũ)
  // Phase 2: ?draft=true → lưu nháp (isDraft=true, docNum=null, KHÔNG đẩy SAP)
  const isDraft = req.nextUrl.searchParams.get('draft') === 'true'
  const subTotal = lines.reduce((s, l) => s + l.lineTotal, 0)
  const grandTotal = subTotal - Math.round((subTotal * headerDiscPct) / 100)
  let delivery: Awaited<ReturnType<typeof prisma.delivery.create>> | null = null
  for (let attempt = 0; attempt < 5 && !delivery; attempt++) {
    try {
      const last = isDraft ? null : await prisma.delivery.findFirst({ orderBy: { docNum: 'desc' } })
      const docNum = isDraft ? null : (last?.docNum ?? 0) + 1
      delivery = await prisma.delivery.create({
        data: {
          docNum,
          isDraft,
          cardCode,
          cardName,
          docDate,
          remarks: String(body.remarks ?? '').trim() || null,
          warehouseCode: headerWarehouseCode,
          sourceOrderId,
          sapDatabaseId: user.databaseId,
          ...b2b,
          pickAndPackNotes,
          headerDiscPct,
          grandTotal,
          createdBy: user.id,
          lines: {
            create: lines.map((l, i) => ({
              lineNum: i + 1,
              itemCode: l.itemCode.trim(),
              itemName: (l.itemName || l.itemCode).trim(),
              quantity: l.quantity,
              uom: l.uom || '',
              unitPrice: l.unitPrice ?? 0,
              lineTotal: l.lineTotal,
              taxCode: l.taxCode,
              discPct: l.discPct,
              sourceOrderLineId: l.sourceOrderLineId,
              warehouseCode: l.warehouseCode,
              batchNumber: l.batchNumber,
            })),
          },
        },
        include: { lines: true },
      })
    } catch (e) {
      if ((e as { code?: string })?.code !== 'P2002') throw e
      console.warn(`[deliveries] docNum conflict, retry ${attempt + 1}/5`)
    }
  }
  if (!delivery) return NextResponse.json({ error: 'Không thể cấp số phiếu' }, { status: 500 })
  return NextResponse.json({ ok: true, delivery }, { status: 201 })
}
