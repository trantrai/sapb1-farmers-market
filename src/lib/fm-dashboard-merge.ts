/**
 * Gộp đơn SAP B1 live + đơn local cho dashboard.
 *
 * Toàn bộ logic ở đây là hàm thuần (không Prisma, không fetch) để dễ unit test.
 * Quy ước khử trùng: đơn local đã synced và có sapDocEntry trùng với đơn SAP
 * → bỏ bản local, giữ bản SAP (giống trang Đơn hàng: src/app/api/orders/route.ts).
 */
import type { SapOrderRow } from './sap-orders'

/** Dạng chuẩn hoá của 1 đơn sau khi gộp 2 nguồn */
export interface MergedOrder {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  /** YYYY-MM-DD */
  docDate: string
  /** YYYY-MM-DD | null */
  docDueDate: string | null
  /** 'Open' | 'Closed' (giữ nguyên giá trị khác nếu có) */
  status: string
  grandTotal: number
  source: 'sap' | 'local'
  sapDocEntry: number | null
}

/** Đơn local ở dạng tối giản mà dashboard cần (tương thích output Prisma select) */
export interface LocalOrderInput {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: Date | string
  docDueDate: Date | string | null
  status: string
  /** Prisma Decimal serialize vẫn qua được Number() */
  grandTotal: unknown
  sapSyncStatus: string | null
  sapDocEntry: number | null
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function toISODate(d: Date | string | null | undefined): string | null {
  if (d == null || d === '') return null
  const s = d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10)
  return ISO_DATE_RE.test(s) ? s : null
}

function toNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Gộp 2 nguồn thành 1 danh sách chuẩn hoá.
 * - SAP luôn được giữ; local trùng DocEntry đã synced thì bỏ (tránh đếm trùng).
 * - Đơn local chưa đẩy (hoặc SAP không còn) được giữ lại.
 */
export function mergeOrders(sapRows: SapOrderRow[], locals: LocalOrderInput[]): MergedOrder[] {
  const sapEntries = new Set<number>()
  const out: MergedOrder[] = []
  for (const r of sapRows) {
    if (r.sapDocEntry != null) sapEntries.add(r.sapDocEntry)
    out.push({
      id: r.id,
      docNum: r.docNum,
      cardCode: r.cardCode,
      cardName: r.cardName,
      docDate: r.docDate,
      docDueDate: r.docDueDate || null,
      status: r.status,
      grandTotal: toNumber(r.grandTotal),
      source: 'sap',
      sapDocEntry: r.sapDocEntry,
    })
  }
  for (const o of locals) {
    if (o.sapSyncStatus === 'synced' && o.sapDocEntry != null && sapEntries.has(o.sapDocEntry)) continue
    out.push({
      id: o.id,
      docNum: o.docNum,
      cardCode: o.cardCode,
      cardName: o.cardName,
      docDate: toISODate(o.docDate) ?? '',
      docDueDate: toISODate(o.docDueDate),
      status: o.status,
      grandTotal: toNumber(o.grandTotal),
      source: 'local',
      sapDocEntry: o.sapDocEntry,
    })
  }
  return out
}

export interface DashboardStats {
  totalOrders: number
  openOrders: number
  closedOrders: number
  /** Open và đã quá DocDueDate (đơn không có hạn giao không tính) */
  overdueOrders: number
  revenueClosed: number
  recent: MergedOrder[]
  attention: MergedOrder[]
}

const byDocNumDesc = (a: MergedOrder, b: MergedOrder) => b.docNum - a.docNum

/** Số liệu thẻ tổng quan — ngữ nghĩa khớp /api/stats cũ (local-only) */
export function computeStats(orders: MergedOrder[], now: Date = new Date()): DashboardStats {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const soonEnd = new Date(today)
  soonEnd.setDate(soonEnd.getDate() + 3)
  soonEnd.setHours(23, 59, 59, 999)

  let openOrders = 0
  let closedOrders = 0
  let overdueOrders = 0
  let revenueClosed = 0
  for (const o of orders) {
    if (o.status === 'Closed') {
      closedOrders++
      revenueClosed += o.grandTotal
    } else if (o.status === 'Open') {
      openOrders++
    }
    if (o.status === 'Open' && o.docDueDate && new Date(o.docDueDate) < today) overdueOrders++
  }

  const recent = [...orders].sort(byDocNumDesc).slice(0, 5)
  const attention = orders
    .filter((o) => o.status === 'Open' && o.docDueDate && new Date(o.docDueDate) <= soonEnd)
    .sort((a, b) => (a.docDueDate as string).localeCompare(b.docDueDate as string))
    .slice(0, 5)

  return {
    totalOrders: orders.length,
    openOrders,
    closedOrders,
    overdueOrders,
    revenueClosed: Math.round(revenueClosed),
    recent,
    attention,
  }
}

export interface RevenueDay {
  day: string
  total: number
}

const dayKey = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`

/** Doanh số theo ngày trong khoảng [start, start+range-1] — khớp logic /api/dashboard/stats cũ */
export function computeRevenueByDay(orders: MergedOrder[], start: Date, range: number): RevenueDay[] {
  const byDay = new Map<string, number>()
  for (let i = 0; i < range; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    byDay.set(dayKey(d), 0)
  }
  for (const o of orders) {
    if (!o.docDate) continue
    const key = dayKey(new Date(`${o.docDate}T00:00:00`))
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + o.grandTotal)
  }
  return [...byDay.entries()].map(([day, total]) => ({ day, total: Math.round(total) }))
}

export interface TopCustomer {
  cardCode: string
  cardName: string
  total: number
  orderCount: number
}

/** Top khách hàng theo doanh số */
export function computeTopCustomers(orders: MergedOrder[], take = 5): TopCustomer[] {
  const m = new Map<string, { cardCode: string; cardName: string; total: number; orderCount: number }>()
  for (const o of orders) {
    const key = o.cardCode || o.cardName
    const cur = m.get(key) ?? { cardCode: o.cardCode, cardName: o.cardName, total: 0, orderCount: 0 }
    cur.total += o.grandTotal
    cur.orderCount++
    m.set(key, cur)
  }
  return [...m.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, take)
    .map((c) => ({ ...c, total: Math.round(c.total) }))
}

/** 1 dòng hàng đã chuẩn hoá để cộng dồn top mặt hàng */
export interface ItemLineInput {
  itemCode: string
  itemName: string
  quantity: unknown
  total: unknown
}

export interface TopItem {
  itemCode: string
  itemName: string
  quantity: number
  total: number
}

/** Top mặt hàng theo số lượng (gộp theo itemCode) */
export function aggregateTopItems(lines: ItemLineInput[], take = 5): TopItem[] {
  const m = new Map<string, { itemCode: string; itemName: string; quantity: number; total: number }>()
  for (const l of lines) {
    if (!l.itemCode) continue
    const cur = m.get(l.itemCode) ?? { itemCode: l.itemCode, itemName: l.itemName, quantity: 0, total: 0 }
    cur.quantity += toNumber(l.quantity)
    cur.total += toNumber(l.total)
    m.set(l.itemCode, cur)
  }
  return [...m.values()]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, take)
    .map((it) => ({
      ...it,
      quantity: Math.round(it.quantity * 100) / 100,
      total: Math.round(it.total),
    }))
}
