import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, type SapConfig } from '@/lib/sap-service-layer'
import { fetchSapOrders, fetchSapOrderDetail, type SapOrderRow } from '@/lib/sap-orders'
import {
  mergeOrders,
  computeRevenueByDay,
  computeTopCustomers,
  aggregateTopItems,
  type LocalOrderInput,
  type ItemLineInput,
} from '@/lib/fm-dashboard-merge'

// GET /api/dashboard/stats?range=7|30 — số liệu biểu đồ dashboard.
// Gộp đơn SAP B1 live + đơn local (khử trùng theo DocEntry — giống trang Đơn hàng).
// Top mặt hàng cần dòng hàng SAP: gọi chi tiết từng đơn, giới hạn 60 đơn mới nhất
// trong khoảng + chạy song song 5 + cache 5 phút (dashboard là số liệu ước lượng).
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  // B1: cách ly DB (giống trang Đơn hàng)
  const s = await loadSapSettings(user.databaseId)
  const dbScope = user.databaseId ? { OR: [{ sapDatabaseId: user.databaseId }, { sapDatabaseId: "" }] } : {}
  const sp = req.nextUrl.searchParams
  const range = sp.get('range') === '30' ? 30 : 7

  const end = new Date()
  end.setHours(23, 59, 59, 999)
  const start = new Date()
  start.setDate(start.getDate() - (range - 1))
  start.setHours(0, 0, 0, 0)
  const fromISO = toISODate(start)
  const toISO = toISODate(end)

  // Đơn local trong khoảng (kèm dòng hàng để tính top mặt hàng)
  const localOrders = await prisma.salesOrder.findMany({
    where: { ...dbScope, docDate: { gte: start, lte: end } },
    include: {
      lines: { select: { itemCode: true, itemName: true, quantity: true, grandTotal: true } },
    },
  })

  // Đơn SAP trong khoảng (headers; tận dụng cache theo filter của fetchSapOrders)
  let sapRows: SapOrderRow[] = []
  let sapUsed = false
  let warning: string | undefined
  if (isSapConfigured(s)) {
    const live = await fetchSapOrders(s, { from: fromISO, to: toISO })
    if (live.ok && live.data) {
      sapRows = live.data
      sapUsed = true
    } else {
      warning = `Không truy vấn được SAP B1 (${live.error ?? 'lỗi không rõ'}) — biểu đồ đang hiển thị số liệu local`
    }
  }

  const merged = mergeOrders(sapRows, localOrders as unknown as LocalOrderInput[])
  const revenueByDay = computeRevenueByDay(merged, start, range)
  const topCustomers = computeTopCustomers(merged)

  // Top mặt hàng: dòng local + dòng SAP (giới hạn số đơn gọi chi tiết)
  const lineInputs: ItemLineInput[] = []
  for (const o of localOrders) {
    for (const l of o.lines) {
      lineInputs.push({ itemCode: l.itemCode, itemName: l.itemName, quantity: l.quantity, total: l.grandTotal })
    }
  }
  if (sapUsed && s) {
    const sapLines = await fetchSapLinesCapped(s, sapRows, fromISO, toISO)
    lineInputs.push(...sapLines)
  }
  const topItems = aggregateTopItems(lineInputs)

  return NextResponse.json({
    range,
    revenueByDay,
    topCustomers,
    topItems,
    sources: { sap: sapUsed },
    ...(warning ? { warning } : {}),
  })
}

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- Dòng hàng SAP: giới hạn 60 đơn mới nhất + song song 5 + cache 5' ----------

const SAP_LINES_CAP = 60
const SAP_LINES_TTL_MS = 5 * 60_000
const sapLinesCache = new Map<string, { ts: number; lines: ItemLineInput[] }>()

/** Chạy fn trên items với tối đa `limit` tác vụ song song */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx] as T)
    }
  })
  await Promise.all(workers)
  return out
}

async function fetchSapLinesCapped(
  s: SapConfig,
  sapRows: SapOrderRow[],
  fromISO: string,
  toISO: string,
): Promise<ItemLineInput[]> {
  const key = `${s.dbId ?? ''}|${fromISO}|${toISO}|${rangeKey(sapRows)}`
  const cached = sapLinesCache.get(key)
  if (cached && Date.now() - cached.ts < SAP_LINES_TTL_MS) return cached.lines

  // fetchSapOrders đã sắp xếp docNum giảm dần → 60 đơn mới nhất
  const targets = sapRows.filter((r) => r.sapDocEntry != null).slice(0, SAP_LINES_CAP)
  const results = await mapLimit(targets, 5, async (r) => {
    try {
      const det = await fetchSapOrderDetail(s, r.sapDocEntry as number)
      if (!det.ok || !det.order) return []
      return det.order.lines.map((l) => ({
        itemCode: l.itemCode,
        itemName: l.itemName,
        quantity: l.quantity,
        total: l.lineTotal,
      }))
    } catch {
      return []
    }
  })
  const lines = results.flat()
  sapLinesCache.set(key, { ts: Date.now(), lines })
  return lines
}

/** Phân biệt cache khi tập đơn trong khoảng thay đổi (so sánh nhanh qua đầu/cuối + số lượng) */
function rangeKey(rows: SapOrderRow[]): string {
  if (rows.length === 0) return 'empty'
  const first = rows[0]?.sapDocEntry ?? 0
  const last = rows[rows.length - 1]?.sapDocEntry ?? 0
  return `${rows.length}:${first}:${last}`
}
