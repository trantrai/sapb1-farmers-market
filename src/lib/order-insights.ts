// ============================================================
// Lịch sử khách hàng cho vùng "Kiểm tra đơn" (form đơn hàng bán):
// - Đơn trùng: đơn Open cùng khách, cùng ngày giao, tạo trong 7 ngày gần đây
// - Thống kê từng mặt hàng: trung vị SL mỗi đơn + giá lần bán gần nhất
// Phần tính toán tách hàm thuần (test được); loadOrderInsights chỉ đọc DB.
// Cách ly DB: đơn của DB đang làm việc + đơn cũ chưa gán DB.
// ============================================================
import { db as prisma } from '@/lib/db'
import type { DuplicateOrderHit, ItemHistoryStat, OrderInsights } from '@/lib/order-precheck'

export const INSIGHT_LIMITS = {
  /** Đơn trùng: chỉ xét đơn tạo trong N ngày gần đây */
  dupLookbackDays: 7,
  /** Tỷ lệ mặt hàng trùng tối thiểu (so với đơn nhiều mặt hàng hơn) */
  dupMinOverlap: 0.6,
  /** Lịch sử giá/SL: N ngày gần đây, tối đa M đơn */
  historyDays: 180,
  historyMaxOrders: 60,
  maxItemCodes: 200,
} as const

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

export interface HistoryOrder {
  docDate: Date
  lines: { itemCode: string; quantity: number; unitPrice: number; uom: string | null }[]
}

/** Thống kê theo mặt hàng — orders sắp xếp MỚI → CŨ */
export function computeItemStats(orders: HistoryOrder[], itemCodes: string[]): Record<string, ItemHistoryStat> {
  const want = new Set(itemCodes)
  const acc = new Map<string, { qtys: number[]; uom: string | null; lastPrice: number | null; lastDate: string | null }>()
  for (const o of orders) {
    const perOrder = new Map<string, number>()
    for (const l of o.lines) {
      if (!want.has(l.itemCode) || !(l.quantity > 0)) continue
      perOrder.set(l.itemCode, (perOrder.get(l.itemCode) ?? 0) + l.quantity)
      let a = acc.get(l.itemCode)
      if (!a) {
        a = { qtys: [], uom: l.uom, lastPrice: null, lastDate: null }
        acc.set(l.itemCode, a)
      }
      if (a.lastPrice === null && l.unitPrice > 0) {
        a.lastPrice = l.unitPrice
        a.lastDate = o.docDate.toISOString().slice(0, 10)
      }
    }
    for (const [code, q] of perOrder) acc.get(code)!.qtys.push(q)
  }
  const out: Record<string, ItemHistoryStat> = {}
  for (const [code, a] of acc) {
    out[code] = { samples: a.qtys.length, medianQty: median(a.qtys), uom: a.uom, lastPrice: a.lastPrice, lastDate: a.lastDate }
  }
  return out
}

export interface DupCandidate {
  id: string
  docNum: number | null
  isDraft: boolean
  lines: { itemCode: string }[]
}

/**
 * Đơn trùng: đơn đang nhập chưa có mặt hàng → mọi đơn cùng khách + ngày giao;
 * có mặt hàng → trùng ≥ dupMinOverlap so với đơn nhiều mặt hàng hơn.
 */
export function findDuplicateOrders(candidates: DupCandidate[], itemCodes: string[], minOverlap: number = INSIGHT_LIMITS.dupMinOverlap): DuplicateOrderHit[] {
  const mine = new Set(itemCodes)
  const hits: DuplicateOrderHit[] = []
  for (const c of candidates) {
    const theirs = new Set(c.lines.map((l) => l.itemCode))
    if (mine.size === 0) {
      hits.push({ id: c.id, docNum: c.docNum, isDraft: c.isDraft, overlap: 0, total: 0 })
      continue
    }
    let common = 0
    for (const code of mine) if (theirs.has(code)) common++
    const total = Math.max(mine.size, theirs.size)
    if (common > 0 && common / total >= minOverlap) {
      hits.push({ id: c.id, docNum: c.docNum, isDraft: c.isDraft, overlap: common, total })
    }
  }
  return hits.sort((a, b) => b.overlap / (b.total || 1) - a.overlap / (a.total || 1))
}

export interface InsightQuery {
  cardCode: string
  /** yyyy-mm-dd */
  docDueDate: string | null
  itemCodes: string[]
  excludeOrderId: string | null
}

/** needs: phần nào cần tải (theo thiết lập bật/tắt cảnh báo) — phần tắt trả rỗng, không truy vấn */
export async function loadOrderInsights(
  dbId: string | null,
  q: InsightQuery,
  now: Date = new Date(),
  needs: { duplicates: boolean; items: boolean } = { duplicates: true, items: true },
): Promise<OrderInsights> {
  const dbScope = dbId ? { OR: [{ sapDatabaseId: dbId }, { sapDatabaseId: '' }, { sapDatabaseId: null }] } : {}
  const notSelf = q.excludeOrderId ? { id: { not: q.excludeOrderId } } : {}
  const codes = [...new Set(q.itemCodes)].slice(0, INSIGHT_LIMITS.maxItemCodes)

  let duplicates: DuplicateOrderHit[] = []
  if (needs.duplicates && q.docDueDate) {
    const dayStart = new Date(`${q.docDueDate}T00:00:00.000Z`)
    const dayEnd = new Date(dayStart.getTime() + 86_400_000)
    const createdFrom = new Date(now.getTime() - INSIGHT_LIMITS.dupLookbackDays * 86_400_000)
    const candidates = await prisma.salesOrder.findMany({
      where: {
        ...dbScope, ...notSelf,
        cardCode: q.cardCode,
        status: 'Open',
        docDueDate: { gte: dayStart, lt: dayEnd },
        createdAt: { gte: createdFrom },
      },
      select: { id: true, docNum: true, isDraft: true, lines: { where: { isBomChild: false }, select: { itemCode: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    duplicates = findDuplicateOrders(candidates, codes).slice(0, 3)
  }

  let items: Record<string, ItemHistoryStat> = {}
  if (needs.items && codes.length > 0) {
    const from = new Date(now.getTime() - INSIGHT_LIMITS.historyDays * 86_400_000)
    const history = await prisma.salesOrder.findMany({
      where: {
        ...dbScope, ...notSelf,
        cardCode: q.cardCode,
        isDraft: false,
        status: { not: 'Cancelled' },
        docDate: { gte: from },
        lines: { some: { itemCode: { in: codes }, isBomChild: false } },
      },
      select: {
        docDate: true,
        lines: { where: { itemCode: { in: codes }, isBomChild: false }, select: { itemCode: true, quantity: true, unitPrice: true, uom: true } },
      },
      orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
      take: INSIGHT_LIMITS.historyMaxOrders,
    })
    items = computeItemStats(history, codes)
  }
  return { duplicates, items }
}
