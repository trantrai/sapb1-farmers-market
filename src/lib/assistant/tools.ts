// ============================================================
// CÔNG CỤ CỦA TRỢ LÝ — CHỈ ĐỌC DB nội bộ (mirror đồng bộ từ SAP + chứng từ
// trên hệ thống), theo đúng quyền RBAC và database đăng nhập của người hỏi.
// Không gọi SAP, không ghi dữ liệu. "prepare_order_draft" chỉ soạn nháp để
// UI đổ vào form tạo đơn — người dùng tự kiểm tra và bấm Lưu.
// LLM ở cloud (redactPii): không đưa SĐT, địa chỉ, ghi chú đơn vào kết quả.
// ============================================================

import { db as prisma } from '@/lib/db'
import type { PermMap } from '@/lib/fm-shared'
import { norm } from '@/lib/fm-items'
import { resolveKey, type ResolvedItem } from '@/lib/item-resolve'
import { aggregateBasket } from '@/lib/order-basket'
import { deliveryPattern, suggestDueDate, WEEKDAY_VN } from '@/lib/delivery-pattern'
import { BALANCE_EPS, computeDueDate, daysOverdueOf, round2, startOfUtcDay } from '@/lib/ar-aging'
import type { LlmToolSpec } from './llm'
import type { OrderDraft, ToolOutcome, ToolRegistry } from './agent'

export interface ToolContext {
  permissions: PermMap
  /** Database SAP đăng nhập (null = DB mặc định / chưa cấu hình) */
  dbId: string | null
  /** yyyy-mm-dd hôm nay (giờ VN) */
  today: string
  /** LLM bên ngoài mạng nội bộ → bỏ dữ liệu cá nhân (SĐT, địa chỉ, ghi chú tự do) khỏi kết quả */
  redactPii?: boolean
}

/** Bỏ trường cá nhân khỏi bản ghi khách hàng khi gửi ra LLM cloud */
function redactCustomer<T extends { phone?: string | null; address?: string | null }>(c: T, on: boolean | undefined) {
  if (!on) return c
  const { phone: _p, address: _a, ...rest } = c
  return rest
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): LlmToolSpec => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
})

const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const int = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

export const TOOL_SPECS: LlmToolSpec[] = [
  fn('find_customers', 'Tìm khách hàng theo mã (CardCode), tên hoặc số điện thoại. Dùng trước khi hỏi về 1 khách khi chưa biết mã.', {
    query: { type: 'string', description: 'Mã, tên hoặc SĐT khách hàng' },
  }, ['query']),
  fn('customer_summary', 'Tổng quan 1 khách hàng: đơn gần đây, mặt hàng hay mua (SL lần trước, SL trung bình), thói quen giao hàng, công nợ và nợ quá hạn.', {
    cardCode: { type: 'string', description: 'Mã khách hàng (CardCode)' },
  }, ['cardCode']),
  fn('find_items', 'Tìm mặt hàng theo mã, barcode hoặc tên: trả giá bảng giá, tồn kho (theo lần đồng bộ gần nhất), ĐVT.', {
    query: { type: 'string', description: 'Mã hàng, barcode hoặc tên mặt hàng' },
  }, ['query']),
  fn('list_orders', 'Liệt kê đơn hàng bán (mới nhất trước), lọc theo khách, trạng thái, khoảng ngày chứng từ.', {
    cardCode: { type: 'string', description: 'Mã khách hàng (tuỳ chọn)' },
    status: { type: 'string', enum: ['Open', 'Closed', 'Cancelled'], description: 'Trạng thái (tuỳ chọn)' },
    fromDate: { type: 'string', description: 'Từ ngày yyyy-mm-dd (tuỳ chọn)' },
    toDate: { type: 'string', description: 'Đến ngày yyyy-mm-dd (tuỳ chọn)' },
    limit: { type: 'integer', description: 'Số đơn tối đa (1–20, mặc định 10)' },
  }),
  fn('order_detail', 'Chi tiết 1 đơn hàng bán theo số chứng từ (DocNum): dòng hàng, tổng tiền, trạng thái đồng bộ SAP.', {
    docNum: { type: 'integer', description: 'Số đơn hàng (DocNum)' },
  }, ['docNum']),
  fn('prepare_order_draft', 'Soạn NHÁP đơn hàng bán để người dùng mở trong form tạo đơn, kiểm tra và tự bấm Lưu. KHÔNG lưu, KHÔNG đẩy SAP. Mỗi dòng: mặt hàng (mã/barcode/tên) + số lượng.', {
    cardCode: { type: 'string', description: 'Mã khách hàng (CardCode)' },
    lines: {
      type: 'array',
      description: 'Danh sách dòng hàng',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Mã hàng, barcode hoặc tên' },
          quantity: { type: 'number', description: 'Số lượng > 0' },
        },
        required: ['item', 'quantity'],
        additionalProperties: false,
      },
    },
  }, ['cardCode', 'lines']),
]

/** Công cụ người dùng được phép dùng theo RBAC (không có quyền → không đưa cho model) */
export function allowedTools(p: PermMap): LlmToolSpec[] {
  const canOrders = Boolean(p.orders?.view)
  const canCreate = Boolean(p.ordersNew?.create)
  const allow: Record<string, boolean> = {
    find_customers: canOrders || canCreate,
    customer_summary: canOrders || canCreate,
    find_items: canOrders || canCreate,
    list_orders: canOrders,
    order_detail: canOrders,
    prepare_order_draft: canCreate,
  }
  return TOOL_SPECS.filter((t) => allow[t.function.name])
}

/** Đơn trên DB đăng nhập (kèm đơn cũ chưa gán DB) */
const orderScope = (dbId: string | null) =>
  dbId ? { OR: [{ sapDatabaseId: dbId }, { sapDatabaseId: '' }, { sapDatabaseId: null }] } : {}
const mirrorScope = (dbId: string | null) => (dbId ? { sapDatabaseId: dbId } : {})

async function loadCatalog(dbId: string | null): Promise<(ResolvedItem & { stock: number })[]> {
  const where = mirrorScope(dbId)
  const [rows, vg] = await Promise.all([
    prisma.item.findMany({ where, select: { itemCode: true, itemName: true, uom: true, price: true, taxCode: true, barcode: true, stock: true } }),
    prisma.vatGroup.findMany({ where, select: { code: true, rate: true, category: true } }),
  ])
  const rate = new Map<string, number>()
  for (const g of vg) if (g.rate != null && (g.category === 'S' || !rate.has(g.code))) rate.set(g.code, g.rate)
  return rows.map((r) => ({
    itemCode: r.itemCode, itemName: r.itemName, uom: r.uom, price: r.price, stock: r.stock,
    taxCode: r.taxCode ?? '', vatRate: r.taxCode ? rate.get(r.taxCode) : undefined, barcode: r.barcode ?? '',
  }))
}

async function findCustomer(dbId: string | null, cardCode: string) {
  return prisma.businessPartner.findFirst({
    where: { ...mirrorScope(dbId), cardCode },
    select: { cardCode: true, cardName: true, phone: true, address: true, groupNum: true },
  })
}

async function customerDebt(dbId: string | null, cardCode: string) {
  const where = { ...orderScope(dbId), cardCode, status: { not: 'Cancelled' }, isDraft: { not: true } }
  const select = { docDate: true, docDueDate: true, paymentGroupCode: true, grandTotal: true, paidAmount: true } as const
  const [inv, cm, terms] = await Promise.all([
    prisma.arInvoice.findMany({ where, select }),
    prisma.arCreditMemo.findMany({ where, select }),
    prisma.paymentTerm.findMany({ select: { code: true, days: true } }),
  ])
  const termDays = new Map(terms.map((t) => [t.code, t.days ?? 0]))
  let total = 0, overdue = 0, maxDays = 0, openInvoices = 0
  const add = (d: (typeof inv)[number], sign: 1 | -1) => {
    const bal = round2((d.grandTotal ?? 0) - (d.paidAmount ?? 0))
    if (bal <= BALANCE_EPS) return
    total = round2(total + sign * bal)
    if (sign < 0) return
    openInvoices += 1
    const days = d.paymentGroupCode != null ? termDays.get(d.paymentGroupCode) ?? null : null
    const due = computeDueDate(d.docDate, days) ?? startOfUtcDay(new Date(d.docDueDate))
    const od = daysOverdueOf(due)
    if (od > 0) { overdue = round2(overdue + bal); maxDays = Math.max(maxDays, od) }
  }
  inv.forEach((d) => add(d, 1))
  cm.forEach((d) => add(d, -1))
  return { outstanding: total, overdueAmount: overdue, maxDaysOverdue: maxDays, openInvoices, currency: 'VND' }
}

export function createToolRegistry(ctx: ToolContext): ToolRegistry {
  const specs = allowedTools(ctx.permissions)
  const allowed = new Set(specs.map((s) => s.function.name))
  let catalog: Awaited<ReturnType<typeof loadCatalog>> | null = null
  const getCatalog = async () => (catalog ??= await loadCatalog(ctx.dbId))

  const handlers: Record<string, (a: Record<string, unknown>) => Promise<ToolOutcome>> = {
    async find_customers(a) {
      const q = norm(str(a.query))
      if (!q) return { result: { error: 'Thiếu từ khoá tìm' } }
      const rows = await prisma.businessPartner.findMany({
        where: { ...mirrorScope(ctx.dbId), groupType: { not: 'Nhà cung cấp' } },
        select: { cardCode: true, cardName: true, phone: true, address: true },
      })
      const words = q.split(/\s+/).filter(Boolean)
      const hits = rows.filter((r) => {
        const hay = norm(`${r.cardCode} ${r.cardName} ${r.phone ?? ''}`)
        return words.every((w) => hay.includes(w))
      })
      return { result: { total: hits.length, customers: hits.slice(0, 8).map((h) => redactCustomer(h, ctx.redactPii)) } }
    },

    async customer_summary(a) {
      const cardCode = str(a.cardCode, 50)
      const c = cardCode ? await findCustomer(ctx.dbId, cardCode) : null
      if (!c) return { result: { error: `Không tìm thấy khách hàng ${cardCode}` } }
      const from = new Date(`${ctx.today}T00:00:00Z`)
      from.setUTCDate(from.getUTCDate() - 180)
      const orders = await prisma.salesOrder.findMany({
        where: { ...orderScope(ctx.dbId), cardCode, isDraft: false, status: { not: 'Cancelled' }, docDate: { gte: from } },
        orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
        take: 30,
        select: {
          docNum: true, docDate: true, docDueDate: true, status: true, grandTotal: true, warehouseCode: true,
          lines: { where: { isBomChild: false }, select: { itemCode: true, itemName: true, quantity: true, unitPrice: true, uom: true } },
        },
      })
      const pattern = deliveryPattern(orders)
      const result: Record<string, unknown> = {
        customer: redactCustomer(c, ctx.redactPii),
        recentOrders: orders.slice(0, 5).map((o) => ({
          docNum: o.docNum, docDate: ymd(o.docDate), docDueDate: ymd(o.docDueDate), status: o.status, grandTotal: o.grandTotal,
          items: o.lines.length,
        })),
        usualItems: aggregateBasket(orders, 10).map((b) => ({
          itemCode: b.itemCode, itemName: b.itemName, orders: b.orderCount, lastQty: b.lastQty, avgQty: b.avgQty, uom: b.uom, lastDate: b.lastDate.slice(0, 10),
        })),
        delivery: pattern && {
          usualWeekdays: pattern.weekdays.map((d) => WEEKDAY_VN[d]),
          leadDays: pattern.leadDays,
          warehouseCode: pattern.warehouseCode,
          suggestedDueDateIfOrderToday: suggestDueDate(ctx.today, pattern),
        },
      }
      if (ctx.permissions.arAgingReport?.view) result.debt = await customerDebt(ctx.dbId, cardCode)
      else result.debt = 'Không có quyền xem công nợ'
      return { result }
    },

    async find_items(a) {
      const q = str(a.query)
      if (!q) return { result: { error: 'Thiếu từ khoá tìm' } }
      const cat = await getCatalog()
      if (cat.length === 0) return { result: { error: 'Danh mục mặt hàng chưa đồng bộ về hệ thống' } }
      const r = resolveKey(q, cat)
      const list = r.status === 'matched' ? [r.item] : r.status === 'ambiguous' ? r.candidates : []
      const byCode = new Map(cat.map((it) => [it.itemCode, it]))
      return {
        result: {
          items: list.map((it) => {
            const full = byCode.get(it.itemCode)
            return { itemCode: it.itemCode, itemName: it.itemName, uom: it.uom, price: it.price, stock: full?.stock ?? null, barcode: it.barcode || null }
          }),
          note: 'Tồn kho theo lần đồng bộ gần nhất, chưa trừ đơn đang mở',
        },
      }
    },

    async list_orders(a) {
      const cardCode = str(a.cardCode, 50)
      const status = ['Open', 'Closed', 'Cancelled'].includes(str(a.status)) ? str(a.status) : undefined
      const from = /^\d{4}-\d{2}-\d{2}$/.test(str(a.fromDate)) ? new Date(`${str(a.fromDate)}T00:00:00Z`) : undefined
      const to = /^\d{4}-\d{2}-\d{2}$/.test(str(a.toDate)) ? new Date(`${str(a.toDate)}T23:59:59Z`) : undefined
      const rows = await prisma.salesOrder.findMany({
        where: {
          ...orderScope(ctx.dbId),
          isDraft: false,
          ...(cardCode ? { cardCode } : {}),
          ...(status ? { status } : {}),
          ...(from || to ? { docDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        },
        orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }],
        take: int(a.limit, 10, 1, 20),
        select: { docNum: true, cardCode: true, cardName: true, docDate: true, docDueDate: true, status: true, grandTotal: true, sapSyncStatus: true, sapDocNum: true },
      })
      return {
        result: {
          orders: rows.map((o) => ({ ...o, docDate: ymd(o.docDate), docDueDate: ymd(o.docDueDate) })),
        },
      }
    },

    async order_detail(a) {
      const docNum = int(a.docNum, 0, 0, 2_000_000_000)
      const o = docNum ? await prisma.salesOrder.findFirst({
        where: { ...orderScope(ctx.dbId), docNum },
        select: {
          docNum: true, cardCode: true, cardName: true, docDate: true, docDueDate: true, status: true, remarks: true,
          grandTotal: true, vatAmt: true, discountAmt: true, sapSyncStatus: true, sapDocNum: true, sapSyncError: true,
          lines: { orderBy: { lineNum: 'asc' }, select: { itemCode: true, itemName: true, quantity: true, uom: true, unitPrice: true, lineTotal: true, isBomChild: true } },
        },
      }) : null
      if (!o) return { result: { error: `Không tìm thấy đơn hàng #${docNum}` } }
      const { remarks, ...rest } = o
      return { result: { ...rest, ...(ctx.redactPii ? {} : { remarks }), docDate: ymd(o.docDate), docDueDate: ymd(o.docDueDate) } }
    },

    async prepare_order_draft(a) {
      const cardCode = str(a.cardCode, 50)
      const c = cardCode ? await findCustomer(ctx.dbId, cardCode) : null
      if (!c) return { result: { error: `Không tìm thấy khách hàng ${cardCode} — hãy dùng find_customers trước` } }
      const raw = Array.isArray(a.lines) ? a.lines.slice(0, 100) : []
      if (raw.length === 0) return { result: { error: 'Nháp đơn cần ít nhất 1 dòng hàng' } }
      const cat = await getCatalog()
      if (cat.length === 0) return { result: { error: 'Danh mục mặt hàng chưa đồng bộ về hệ thống' } }
      const problems: string[] = []
      const lines: OrderDraft['lines'] = []
      for (const l of raw) {
        const key = str((l as Record<string, unknown>)?.item)
        const qty = Number((l as Record<string, unknown>)?.quantity)
        if (!key) { problems.push('Có dòng thiếu mặt hàng'); continue }
        if (!(qty > 0) || qty > 1e7) { problems.push(`"${key}": số lượng không hợp lệ`); continue }
        const r = resolveKey(key, cat)
        if (r.status === 'notfound') { problems.push(`"${key}": không tìm thấy mặt hàng`); continue }
        if (r.status === 'ambiguous') {
          problems.push(`"${key}": khớp nhiều mặt hàng (${r.candidates.map((x) => x.itemCode).join(', ')}) — cần hỏi người dùng chọn mã`)
          continue
        }
        const it = r.item
        lines.push({ itemCode: it.itemCode, itemName: it.itemName, quantity: qty, uom: it.uom, price: it.price, taxCode: it.taxCode || null, vatRate: it.vatRate ?? null, barcode: it.barcode || null })
      }
      if (problems.length > 0) {
        return { result: { ok: false, problems, note: 'Chưa tạo nháp. Hỏi lại người dùng các dòng có vấn đề rồi gọi lại công cụ.' } }
      }
      const draft: OrderDraft = { cardCode: c.cardCode, cardName: c.cardName, lines }
      return {
        draft,
        result: {
          ok: true,
          note: 'Đã soạn nháp. Người dùng bấm "Mở trong form tạo đơn" để kiểm tra giá/tồn rồi tự bấm Lưu. Đơn CHƯA được lưu.',
          customer: `${c.cardCode} — ${c.cardName}`,
          lines: lines.map((l) => ({ itemCode: l.itemCode, itemName: l.itemName, quantity: l.quantity, uom: l.uom, listPrice: l.price })),
        },
      }
    },
  }

  return {
    specs,
    async run(name, args) {
      if (!allowed.has(name) || !handlers[name]) return { result: { error: `Công cụ "${name}" không có hoặc bạn không có quyền dùng` } }
      return handlers[name](args)
    },
  }
}
