import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGet } from '@/lib/sap-service-layer'
import { acquireOrderPushLock, releaseOrderPushLock } from '@/lib/order-push-lock'
import { rankSapCandidates, type SapMatchOrder } from '@/lib/sap-sync-retry'

type Ctx = { params: Promise<{ id: string }> }

// ============================================================
// ĐỐI CHIẾU ĐƠN CHƯA RÕ ĐÃ LÊN SAP HAY CHƯA (khi DB SAP chưa có UDF marker)
// GET  → CHỈ ĐỌC: liệt kê đơn trên SAP cùng khách, cùng ngày chứng từ
// POST { docEntry } → gắn đơn local với chứng từ SAP đã có. KHÔNG ghi gì lên
//       SAP: chỉ đọc lại chứng từ để xác nhận khách + lấy DocNum/LineNum.
// ============================================================

async function loadOrder(id: string) {
  return prisma.salesOrder.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' }, select: { id: true, lineNum: true } } },
  })
}

const odataStr = (s: string) => s.replace(/'/g, "''")

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền đối chiếu đơn với SAP B1' }, { status: 403 })
  }
  const { id } = await ctx.params
  const order = await loadOrder(id)
  if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
  if (order.sapSyncStatus === 'synced') {
    return NextResponse.json({ error: `Đơn đã gắn với SAP (DocNum ${order.sapDocNum ?? '?'})` }, { status: 400 })
  }
  const s = await loadSapSettings(order.sapDatabaseId ?? user.databaseId)
  if (!isSapConfigured(s)) return NextResponse.json({ error: 'Chưa cấu hình kết nối SAP B1' }, { status: 400 })

  const docDate = order.docDate.toISOString().slice(0, 10)
  const res = await sapGet<{ value?: (SapMatchOrder & { NumAtCard?: string; Comments?: string; DocumentStatus?: string; Cancelled?: string })[] }>(
    s,
    '/Orders',
    {
      $filter: `CardCode eq '${odataStr(order.cardCode)}' and DocDate eq '${docDate}'`,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,DocTotal,NumAtCard,Comments,DocumentStatus,Cancelled',
      $orderby: 'DocEntry desc',
      $top: '20',
    },
  )
  if (!res.ok) return NextResponse.json({ error: res.error ?? 'Không tra được đơn trên SAP B1' }, { status: 502 })
  const rows = (res.data?.value ?? []).filter((r) => typeof r.DocEntry === 'number')

  // Chứng từ SAP đã gắn với đơn local khác → không cho chọn
  const linked = await prisma.salesOrder.findMany({
    where: { id: { not: order.id }, sapDocEntry: { in: rows.map((r) => r.DocEntry) }, sapDatabaseId: order.sapDatabaseId },
    select: { sapDocEntry: true, docNum: true },
  })
  const linkedMap = new Map(linked.map((l) => [l.sapDocEntry, l.docNum]))
  const ranked = rankSapCandidates({ grandTotal: order.grandTotal, docDueDate: order.docDueDate.toISOString() }, rows)
  return NextResponse.json({
    ok: true,
    // DB đích hiển thị trong xác nhận "đẩy lại" (CLAUDE.md: xác nhận DB trước khi ghi SAP)
    sapDb: { label: s.dbLabel, companyDb: s.companyDb },
    order: { id: order.id, docNum: order.docNum, cardCode: order.cardCode, cardName: order.cardName, docDate, docDueDate: order.docDueDate.toISOString().slice(0, 10), grandTotal: order.grandTotal, lineCount: order.lines.length },
    candidates: ranked.map((r) => {
      const raw = rows.find((x) => x.DocEntry === r.DocEntry)
      return {
        ...r,
        numAtCard: raw?.NumAtCard ?? '',
        comments: (raw?.Comments ?? '').slice(0, 120),
        cancelled: raw?.Cancelled === 'tYES',
        linkedToDocNum: linkedMap.get(r.DocEntry) ?? null,
      }
    }),
  })
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền đối chiếu đơn với SAP B1' }, { status: 403 })
  }
  const { id } = await ctx.params
  const body = await req.json().catch(() => null)
  const docEntry = Number(body?.docEntry)
  if (!Number.isInteger(docEntry) || docEntry <= 0) return NextResponse.json({ error: 'DocEntry không hợp lệ' }, { status: 400 })

  // Cùng khoá với "Đẩy lại" / job nền: không gắn khi đơn đang được đẩy
  if (!acquireOrderPushLock(id)) {
    return NextResponse.json({ error: 'Đơn đang được đẩy sang SAP B1 — vui lòng đợi rồi thử lại.' }, { status: 409 })
  }
  try {
    const order = await loadOrder(id)
    if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })
    if (order.sapSyncStatus === 'synced') {
      return NextResponse.json({ error: `Đơn đã gắn với SAP (DocNum ${order.sapDocNum ?? '?'})` }, { status: 400 })
    }
    const other = await prisma.salesOrder.findFirst({
      where: { id: { not: order.id }, sapDocEntry: docEntry, sapDatabaseId: order.sapDatabaseId },
      select: { docNum: true },
    })
    if (other) return NextResponse.json({ error: `Chứng từ SAP này đã gắn với đơn #${other.docNum ?? '?'}` }, { status: 409 })

    const s = await loadSapSettings(order.sapDatabaseId ?? user.databaseId)
    if (!isSapConfigured(s)) return NextResponse.json({ error: 'Chưa cấu hình kết nối SAP B1' }, { status: 400 })
    const doc = await sapGet<{ DocEntry?: number; DocNum?: number; CardCode?: string; DocumentLines?: { LineNum?: number }[] }>(
      s,
      `/Orders(${docEntry})`,
      { $select: 'DocEntry,DocNum,CardCode,DocumentLines' },
    )
    if (!doc.ok || typeof doc.data?.DocEntry !== 'number') {
      return NextResponse.json({ error: doc.error ?? 'Không đọc được chứng từ trên SAP B1' }, { status: 502 })
    }
    if (doc.data.CardCode !== order.cardCode) {
      return NextResponse.json({ error: `Chứng từ SAP thuộc khách ${doc.data.CardCode ?? '?'}, không phải ${order.cardCode}` }, { status: 400 })
    }
    // LineNum chỉ gán khi số dòng khớp (thứ tự đẩy = thứ tự dòng local)
    const sapLines = (doc.data.DocumentLines ?? []).map((l) => l.LineNum).filter((n): n is number => typeof n === 'number')
    const lineNumsOk = sapLines.length === order.lines.length
    const updated = await prisma.$transaction(async (tx) => {
      if (lineNumsOk) {
        for (const [i, l] of order.lines.entries()) {
          await tx.salesOrderLine.update({ where: { id: l.id }, data: { sapLineNum: sapLines[i] } })
        }
      }
      return tx.salesOrder.update({
        where: { id: order.id },
        data: {
          sapSyncStatus: 'synced',
          sapSyncError: lineNumsOk ? null : 'Đã gắn thủ công — số dòng trên SAP khác đơn này, cần kiểm tra trước khi sửa đơn',
          sapDocEntry: doc.data!.DocEntry,
          sapDocNum: doc.data!.DocNum ?? null,
          sapSyncedAt: new Date(),
          sapSyncErrorKind: null,
          sapSyncAttempts: 0,
          sapNextRetryAt: null,
          sapSyncLastAt: new Date(),
        },
      })
    })
    return NextResponse.json({ ok: true, order: updated, lineNumsOk })
  } finally {
    releaseOrderPushLock(id)
  }
}
