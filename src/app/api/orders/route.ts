import { NextRequest, NextResponse } from 'next/server'
import { parsePageParam } from '@/lib/fm-shared'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { pushOrderToSap, type SapPushResult } from '@/lib/sap-push-order'
import { acquireOrderPushLock, releaseOrderPushLock } from '@/lib/order-push-lock'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapOrders, fetchSapOrderDetail, clearSapOrdersCache, type SapOrderRow } from '@/lib/sap-orders'
import { calcOrderLines, orderTotals, validateOrderLines } from '@/lib/order-calc'
import { normalizeBomLines } from '@/lib/order-bom'

// ============================================================
// B2B / SAP B1 (Đợt 2+3): whitelist + chuẩn hóa các trường header
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

// ---------- GET /api/orders : danh sách SO + filter + phân trang ----------
// Khi đã cấu hình SAP B1 → lấy TOÀN BỘ chứng từ TRỰC TIẾP từ Service Layer
// (GET /Orders, tự phân trang) rồi gộp với các đơn local CHƯA đẩy sang SAP
// (pending/none). Đơn local đã synced bị ẩn nếu SAP đã có chứng từ cùng DocEntry.
// ?docEntry=<n> → lấy chi tiết 1 đơn SAP (kèm DocumentLines) cho modal chi tiết.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams

  // ---------- Chi tiết 1 đơn từ SAP B1 (dòng hàng cho modal) ----------
  const docEntryParam = sp.get('docEntry')
  if (docEntryParam) {
    const docEntry = Number(docEntryParam)
    if (!Number.isInteger(docEntry) || docEntry <= 0) {
      return NextResponse.json({ ok: false, error: 'DocEntry không hợp lệ' }, { status: 400 })
    }
    const s = await loadSapSettings(user.databaseId)
    if (!isSapConfigured(s)) {
      return NextResponse.json({ ok: false, error: 'Chưa cấu hình SAP B1 Service Layer' }, { status: 400 })
    }
    const det = await fetchSapOrderDetail(s, docEntry)
    if (!det.ok || !det.order) {
      return NextResponse.json({ ok: false, error: det.error ?? 'Không lấy được chi tiết đơn từ SAP B1' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, order: det.order })
  }

  const page = parsePageParam(sp.get('page'), 1, 1, 100000)
  const pageSize = parsePageParam(sp.get('pageSize'), 8, 5, 50)
  const q = (sp.get('q') ?? '').trim()
  const status = sp.get('status') ?? ''
  const from = sp.get('from') ?? ''
  const to = sp.get('to') ?? ''

  const where: Record<string, unknown> = {}
  // B1: cách ly theo database — user chỉ thấy đơn của DB mình đăng nhập
  // (kèm đơn NULL sapDatabaseId — tạo trước khi có multi-DB)
  const andConds: Record<string, unknown>[] = []
  {
    const sDb = await loadSapSettings(user.databaseId)
    if (sDb?.dbId) andConds.push({ OR: [{ sapDatabaseId: sDb.dbId }, { sapDatabaseId: "" }] })
  }
  if (q) {
    andConds.push({
      OR: [
        { docNum: isNaN(Number(q)) ? undefined : Number(q) },
        { cardName: { contains: q } },
        { cardCode: { contains: q } },
        { numAtCard: { contains: q } },
      ].filter(Boolean),
    })
  }
  // Phase 2: lọc nháp — ?isDraft=true chỉ lấy nháp, ?isDraft=false lấy chính thức (NULL = cũ = chính thức)
  const isDraftParam = sp.get('isDraft') ?? ''
  if (isDraftParam === 'true') andConds.push({ isDraft: true })
  else if (isDraftParam === 'false') andConds.push({ isDraft: false })
  if (andConds.length > 0) where.AND = andConds
  if (status === 'Open' || status === 'Closed') where.status = status
  if (from || to) {
    where.docDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
    }
  }

  // ---------- 1) Chứng từ từ SAP B1 (nếu đã cấu hình) ----------
  // Đơn SAP lấy từ đúng database đã chọn khi đăng nhập
  const s = await loadSapSettings(user.databaseId)
  let sapRows: SapOrderRow[] = []
  let warning = ''
  let source: 'sap' | 'local' = 'local'
  // Phase 2: khi lọc nháp thì chỉ đọc local — SAP không có khái niệm nháp gộp ở đây
  if (isSapConfigured(s) && isDraftParam === '') {
    const live = await fetchSapOrders(s, { q, status, from, to })
    if (live.ok && live.data) {
      sapRows = live.data
      source = 'sap'
      if (live.warning) warning = live.warning
    } else {
      // SAP lỗi → vẫn hiển thị đơn local, kèm cảnh báo
      warning = `Không truy vấn được SAP B1 (${live.error ?? 'lỗi không rõ'}) — đang hiển thị đơn local`
    }
  }

  // ---------- 1b) Đơn SAP nào có bản ghi local? (để cho phép SỬA đơn từ danh sách) ----------
  const sapEntries = sapRows.map((r) => r.sapDocEntry).filter((x): x is number => x != null)
  const localByEntry = new Map<number, string>()
  if (sapEntries.length > 0) {
    const syncedLocals = await prisma.salesOrder.findMany({
      where: {
        sapSyncStatus: 'synced',
        sapDocEntry: { in: sapEntries },
        ...(s?.dbId ? { sapDatabaseId: s.dbId } : {}),
      },
      select: { id: true, sapDocEntry: true },
    })
    for (const o of syncedLocals) if (o.sapDocEntry != null) localByEntry.set(o.sapDocEntry, o.id)
  }
  if (sapRows.length > 0) {
    sapRows = sapRows.map((r) => ({ ...r, localId: (r.sapDocEntry != null ? localByEntry.get(r.sapDocEntry) : null) ?? null }))
  }

  // ---------- 2) Đơn local (gộp: các đơn chưa đẩy / SAP không còn) ----------
  const localRows = await prisma.salesOrder.findMany({
    where,
    orderBy: { docNum: 'desc' },
    include: { lines: true },
  })
  const slEntries = new Set(sapRows.map((r) => r.sapDocEntry))
  const localOnly = localRows.filter(
    (o) => !(o.sapSyncStatus === 'synced' && o.sapDocEntry != null && slEntries.has(o.sapDocEntry)),
  )

  // ---------- 3) Gộp + sắp xếp + phân trang trên máy chủ ----------
  // docNum null (nháp) xếp cuối — ?? 0 để sort không vỡ với null (Phase 2)
  let merged = [
    ...sapRows,
    ...localOnly.map((o) => ({ ...o, source: 'local' as const })),
  ].sort((a, b) => (b.docNum ?? 0) - (a.docNum ?? 0))

  // Lọc nhanh theo hạn giao: overdue = Open + quá hạn; dueSoon = Open + hạn trong 3 ngày tới
  const due = sp.get('due') ?? ''
  if (due === 'overdue' || due === 'dueSoon') {
    const t = new Date()
    t.setHours(0, 0, 0, 0)
    const soonEnd = new Date(t)
    soonEnd.setDate(soonEnd.getDate() + 3)
    soonEnd.setHours(23, 59, 59, 999)
    merged = merged.filter((r) => {
      if (r.status !== 'Open' || !r.docDueDate) return false
      const d = new Date(r.docDueDate as string)
      return due === 'overdue' ? d < t : d >= t && d <= soonEnd
    })
  }

  const total = merged.length
  const data = merged.slice((page - 1) * pageSize, page * pageSize)

  return NextResponse.json({
    data,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    source,
    ...(warning ? { warning } : {}),
  })
}

// ---------- POST /api/orders : tạo SO mới ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo đơn hàng' }, { status: 403 })
  }

  try {
    const body = await req.json()
    const {
      cardCode, cardName, docDate, docDueDate, remarks, warehouseCode,
      headerDiscPct,
      lines,
    } = body as {
      cardCode: string; cardName: string; docDate: string; docDueDate: string
      remarks?: string
      /** Kho hàng xuất bán mặc định áp dụng cho các dòng hàng */
      warehouseCode?: string
      /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
      headerDiscPct?: number
      lines: Array<{ itemCode: string; itemName: string; uom: string; quantity: number; unitPrice: number; discPct?: number; vatPct?: number; taxCode?: string; warehouseCode?: string; isBomChild?: boolean; bomGroupKey?: string | null; bomEditable?: boolean; bomQtyPerParent?: number | null }>
    }

    if (!cardCode || !cardName) {
      return NextResponse.json({ error: 'Vui lòng chọn khách hàng (CardCode)' }, { status: 400 })
    }
    if (!docDate || !docDueDate) {
      return NextResponse.json({ error: 'Vui lòng chọn ngày chứng từ và ngày giao hàng' }, { status: 400 })
    }
    // B2B / SAP B1 (Đợt 2+3): whitelist + validate các trường header mới
    const { data: b2b, error: b2bError } = parseB2BHeader(body as Record<string, unknown>)
    if (b2bError) {
      return NextResponse.json({ error: b2bError }, { status: 400 })
    }

    // Database SAP đích của đơn: lấy theo phiên đăng nhập; đơn ghi nhận lại để
    // mọi lần đẩy/retry/sửa sau này luôn dùng đúng DB này (không lẫn DB khác).
    // Cần dbId TRƯỚC validate BOM để đọc công thức từ đúng mirror.
    const orderSap = await loadSapSettings(user.databaseId)
    const orderDbId = orderSap?.dbId ?? null

    const { lines: validLines, error: linesError } = validateOrderLines(lines)
    if (linesError) {
      return NextResponse.json({ error: linesError }, { status: 400 })
    }
    // Validate nhóm BOM: Production phải đúng công thức, Template kiểm tra mã con
    const { lines: bomLines, error: bomError } = await normalizeBomLines(orderDbId, validLines)
    if (bomError) {
      return NextResponse.json({ error: bomError }, { status: 400 })
    }

    // Tính toán theo từng dòng (SAP B1 RDR1): LineTotal → Discount% dòng
    // → CK ĐẦU CHỨNG TỪ (phân bổ về dòng) → Vat%
    const headerPct = Math.min(100, Math.max(0, Number(headerDiscPct) || 0))
    const calcLines = calcOrderLines(bomLines, headerPct)
    const totals = orderTotals(calcLines)
    const { totalBeforeDisc, discountAmt, headerDiscAmt, vatAmt, grandTotal } = totals

    // Database SAP đích của đơn: lấy theo phiên đăng nhập; đơn ghi nhận lại để
    // mọi lần đẩy/retry/sửa sau này luôn dùng đúng DB này (không lẫn DB khác)
    // (orderSap / orderDbId đã lấy ở trên để validate BOM)

    // Cấp docNum + tạo đơn trong 1 transaction: 2 request tạo đơn đồng thời
    // không thể nhận cùng docNum (trước đây findFirst + create rời nhau → trùng số).
    // Vẫn có cửa sổ đua cực hẹp giữa 2 transaction đồng thời → retry tối đa 3 lần
    // khi dính lỗi unique-violation của docNum (P2002) thay vì trả 500.
    // Phase 2: ?draft=true → lưu nháp (isDraft=true, docNum=null, KHÔNG đẩy SAP)
    const isDraft = req.nextUrl.searchParams.get('draft') === 'true'
    const createdBy = user.username
    let created: Awaited<ReturnType<typeof createOrderTx>> | null = null
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      try {
        created = await createOrderTx()
      } catch (e) {
        lastErr = e
        const code = (e as { code?: string })?.code
        if (code !== 'P2002' && code !== 'P2034') throw e
        // trùng docNum → thử lại vòng sau sẽ đọc lại số mới nhất
      }
    }
    if (!created) throw lastErr ?? new Error('Không thể cấp số chứng từ')
    async function createOrderTx() {
      return prisma.$transaction(async (tx) => {
      const last = isDraft ? null : await tx.salesOrder.findFirst({ orderBy: { docNum: 'desc' } })
      const docNum = isDraft ? null : (last?.docNum ?? 1000) + 1
      return tx.salesOrder.create({
        data: {
          docNum,
          isDraft,
          cardCode,
          cardName,
          docDate: new Date(docDate),
          docDueDate: new Date(docDueDate),
          remarks: remarks?.trim() || null,
          warehouseCode: warehouseCode?.trim() || null,
          ...b2b,
          totalBeforeDisc,
          discountAmt,
          headerDiscPct: headerPct,
          headerDiscAmt,
          vatAmt,
          grandTotal,
          createdBy,
          sapDatabaseId: orderDbId,
          lines: {
            create: calcLines.map((l, i) => ({
              lineNum: i + 1,
              itemCode: l.itemCode,
              itemName: l.itemName,
              uom: l.uom || 'kg',
              taxCode: l.taxCode?.trim() || null,
              warehouseCode: (l.warehouseCode || warehouseCode || '').trim() || null,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              lineTotal: l.lineTotal,
              discPct: l.discPct,
              discAmt: l.discAmt,
              vatPct: l.vatPct,
              vatAmt: l.vatAmt,
              grandTotal: l.grandTotal,
              isBomChild: l.isBomChild ?? false,
              bomGroupKey: (l.bomGroupKey as string | null | undefined) ?? null,
              bomEditable: l.bomEditable ?? true,
              bomQtyPerParent: l.bomQtyPerParent ?? null,
            })),
          },
        },
        include: { lines: true },
        })
      })
    }

    // ---- Đẩy đơn sang SAP B1 (POST /Orders). Luôn lưu local trước,
    // thất bại thì đánh dấu 'pending' để đẩy lại từ danh sách đơn ----
    // Khóa theo đơn: tránh 2 lượt đẩy đồng thời tạo trùng chứng từ SAP.
    // Phase 2: bản nháp KHÔNG đẩy SAP.
    let push: SapPushResult
    if (isDraft) {
      push = { status: 'none' as const }
    } else if (acquireOrderPushLock(created.id)) {
      try {
        push = await pushOrderToSap({
          cardCode,
          docDate: created.docDate.toISOString(),
          docDueDate: created.docDueDate.toISOString(),
          comments: created.remarks,
          headerDiscPct: headerPct,
          localId: created.id,
          databaseId: orderDbId,
          lines: created.lines.map((l) => ({
            itemCode: l.itemCode,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discPct: l.discPct,
            uom: l.uom,
            taxCode: l.taxCode,
            warehouseCode: l.warehouseCode,
          })),
        })
      } finally {
        releaseOrderPushLock(created.id)
      }
    } else {
      push = { status: 'pending', error: 'Đơn đang được đẩy sang SAP ở một phiên khác — hãy bấm "Đẩy lại" sau.' }
    }
    // Chỉ công nhận 'synced' khi SAP trả về DocEntry hợp lệ — thiếu DocEntry
    // thì giữ 'pending' để lần đẩy lại sau không bỏ qua SAP (tránh lệch lặng lẽ).
    const syncedOk = push.status === 'synced' && typeof push.docEntry === 'number'
    const finalStatus = !syncedOk && push.status === 'synced' ? 'pending' : push.status
    const finalError = !syncedOk && push.status === 'synced' ? 'SAP không trả về DocEntry — sẽ thử đẩy lại' : (push.error ?? null)
    // Lưu LineNum do SAP cấp cho từng dòng — cần khi SỬA đơn (PATCH /Orders)
    if (syncedOk && push.lineNums?.length) {
      const dbLines = [...created.lines].sort((a, b) => a.lineNum - b.lineNum)
      await prisma.$transaction(
        dbLines.map((l, i) =>
          prisma.salesOrderLine.update({ where: { id: l.id }, data: { sapLineNum: push.lineNums?.[i] ?? null } }),
        ),
      )
    }
    const order = await prisma.salesOrder.update({
      where: { id: created.id },
      data: {
        sapSyncStatus: finalStatus,
        sapSyncError: finalError,
        ...(syncedOk
          ? { sapDocEntry: push.docEntry ?? null, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() }
          : {}),
      },
      include: { lines: true },
    })

    clearSapOrdersCache() // đơn mới (local + có thể đã lên SAP) → danh sách phải tải lại
    return NextResponse.json({ ok: true, order, sap: { ...push, status: finalStatus, error: finalError ?? push.error } }, { status: 201 })
  } catch (e) {
    console.error('POST /api/orders', e)
    return NextResponse.json({ error: 'Không thể tạo đơn hàng' }, { status: 500 })
  }
}
