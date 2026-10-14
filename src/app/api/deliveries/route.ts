import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapDeliveries, clearSapDeliveriesCache, type SapDeliveryRow } from '@/lib/sap-deliveries'

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

  // ---------- 1) Chứng từ từ SAP B1 (nếu đã cấu hình) ----------
  // Phiếu lấy từ đúng database đã chọn khi đăng nhập.
  // 'Cancelled' là trạng thái local — SAP chỉ có Open/Closed nên không tải.
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? user.databaseId ?? null
  let sapRows: SapDeliveryRow[] = []
  let warning = ''
  let source: 'sap' | 'local' = 'local'
  // fresh=1 (nút "Tải lại") → bỏ qua cache 45s, tải mới trực tiếp từ SAP B1
  if (isSapConfigured(s) && status !== 'Cancelled' && sp.get('fresh') === '1') {
    clearSapDeliveriesCache()
  }
  if (isSapConfigured(s) && status !== 'Cancelled') {
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
  // B1: cách ly DB
  if (dbId) where.sapDatabaseId = dbId
  if (q) {
    where.OR = [
      { cardCode: { contains: q } },
      { cardName: { contains: q } },
      ...(isNaN(Number(q)) ? [] : [{ docNum: Number(q) }]),
    ]
  }
  if (['Open', 'Closed', 'Cancelled'].includes(status)) where.status = status

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
  const merged = [
    ...sapRows,
    ...localOnly.map((o) => ({ ...o, source: 'local' as const })),
  ].sort((a, b) => b.docNum - a.docNum)

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
    sourceOrderId?: string
    lines?: Array<{ itemCode: string; itemName: string; quantity: number; uom?: string; unitPrice?: number; sourceOrderLineId?: string }>
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
    if (!sourceOrder || sourceOrder.sapDatabaseId !== user.databaseId) {
      return NextResponse.json({ error: 'Đơn nguồn không hợp lệ' }, { status: 400 })
    }
  }
  // Ép kiểu + validate từng dòng: quantity phải là số hữu hạn > 0,
  // unitPrice phải là số hữu hạn và >= 0 (tránh string lọt vào Prisma gây 500).
  const lines = (Array.isArray(body.lines) ? body.lines : [])
    .map((l) => ({
      itemCode: String(l?.itemCode ?? '').trim(),
      itemName: String(l?.itemName ?? l?.itemCode ?? '').trim(),
      quantity: Number(l?.quantity),
      uom: String(l?.uom ?? ''),
      unitPrice: Number(l?.unitPrice ?? 0),
      sourceOrderLineId: String(l?.sourceOrderLineId ?? '').trim() || null,
      lineTotal: 0,
    }))
    .filter(
      (l) =>
        l.itemCode.length > 0 &&
        Number.isFinite(l.quantity) && l.quantity > 0 &&
        Number.isFinite(l.unitPrice) && l.unitPrice >= 0,
    )
    .map((l) => ({ ...l, lineTotal: Math.round(l.quantity * l.unitPrice) }))
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

  // grandTotal = tổng các lineTotal đã round (không tính lại từ unitPrice*qty)
  const grandTotal = lines.reduce((s, l) => s + l.lineTotal, 0)
  let delivery: Awaited<ReturnType<typeof prisma.delivery.create>> | null = null
  for (let attempt = 0; attempt < 5 && !delivery; attempt++) {
    try {
      const last = await prisma.delivery.findFirst({ orderBy: { docNum: 'desc' } })
      const docNum = (last?.docNum ?? 0) + 1
      delivery = await prisma.delivery.create({
        data: {
          docNum,
          cardCode,
          cardName,
          docDate,
          remarks: String(body.remarks ?? '').trim() || null,
          sourceOrderId,
          sapDatabaseId: user.databaseId,
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
              sourceOrderLineId: l.sourceOrderLineId,
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
