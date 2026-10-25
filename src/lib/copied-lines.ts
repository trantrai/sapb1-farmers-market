// ============================================================
// Dòng chứng từ ĐÃ SAO CHÉP sang chứng từ khác (tương đương BaseLine SAP).
// Khi sửa chứng từ nguồn: dòng đã được chứng từ đích (chưa hủy) liên kết
// - không được xóa, không đổi mã hàng (SAP từ chối sửa dòng đã có target);
// - SL không được nhỏ hơn SL đã sao chép (giao/hóa đơn/trả…).
// Áp dụng cho cả dòng cha và dòng con BOM Template (con cũng có id riêng).
// ============================================================
import { db as prisma } from '@/lib/db'

export interface CopiedInfo {
  /** SL đã dùng ở chứng từ đích (không tính hóa đơn đặt cọc — không trừ SL mở) */
  qty: number
  /** Nhãn chứng từ đích để báo lỗi, vd "phiếu giao hàng #12" */
  docs: string[]
}

type LineSpec = { model: string; rel: string; label: string; consumes: boolean }

/** Bảng dòng có sourceLineId (id dòng nguồn) + quan hệ tới header */
const SOURCE_LINE_TABLES: LineSpec[] = [
  { model: 'salesOrderLine', rel: 'order', label: 'đơn hàng bán', consumes: true },
  { model: 'arInvoiceLine', rel: 'invoice', label: 'hóa đơn bán hàng', consumes: true },
  { model: 'arCreditMemoLine', rel: 'creditMemo', label: 'phiếu ghi có', consumes: true },
  { model: 'salesReturnLine', rel: 'salesReturn', label: 'phiếu trả hàng', consumes: true },
  { model: 'arDownPaymentLine', rel: 'downPayment', label: 'hóa đơn đặt cọc', consumes: false },
]

const add = (m: Map<string, CopiedInfo>, id: string | null, qty: number, doc: string) => {
  if (!id) return
  const cur = m.get(id) ?? { qty: 0, docs: [] }
  cur.qty = Math.round((cur.qty + qty) * 1000) / 1000
  if (!cur.docs.includes(doc)) cur.docs.push(doc)
  m.set(id, cur)
}

/** id dòng nguồn → SL đã sao chép + danh sách chứng từ đích (bỏ chứng từ đã hủy) */
export async function copiedLinesOf(lineIds: string[]): Promise<Map<string, CopiedInfo>> {
  const out = new Map<string, CopiedInfo>()
  const ids = [...new Set(lineIds.filter(Boolean))]
  if (ids.length === 0) return out
  const notCancelled = { status: { not: 'Cancelled' } }
  const p = prisma as any
  const dls: any[] = await p.deliveryLine.findMany({
    where: { OR: [{ sourceOrderLineId: { in: ids } }, { sourceQuotationLineId: { in: ids } }], delivery: notCancelled },
    select: { sourceOrderLineId: true, sourceQuotationLineId: true, quantity: true, delivery: { select: { docNum: true } } },
  })
  for (const l of dls) {
    const doc = `phiếu giao hàng #${l.delivery?.docNum ?? '?'}`
    add(out, ids.includes(l.sourceOrderLineId) ? l.sourceOrderLineId : l.sourceQuotationLineId, Number(l.quantity) || 0, doc)
  }
  for (const t of SOURCE_LINE_TABLES) {
    const rows: any[] = await p[t.model].findMany({
      where: { sourceLineId: { in: ids }, [t.rel]: notCancelled },
      select: { sourceLineId: true, quantity: true, [t.rel]: { select: { docNum: true } } },
    })
    for (const l of rows) add(out, l.sourceLineId, t.consumes ? Number(l.quantity) || 0 : 0, `${t.label} #${l[t.rel]?.docNum ?? '?'}`)
  }
  return out
}

/**
 * Kiểm tra bản sửa so với dòng đã lưu. newLines mang dbId = id dòng cũ (dòng giữ lại).
 * Trả thông báo lỗi tiếng Việt hoặc null nếu hợp lệ.
 */
export function checkCopiedLineEdits(
  oldLines: { id: string; itemCode: string; quantity: number }[],
  newLines: { dbId?: string | null; itemCode: string; quantity: number }[],
  copied: Map<string, CopiedInfo>,
): string | null {
  const byDbId = new Map(newLines.filter((l) => l.dbId).map((l) => [l.dbId as string, l]))
  for (const o of oldLines) {
    const c = copied.get(o.id)
    if (!c) continue
    const where = c.docs.join(', ')
    const n = byDbId.get(o.id)
    if (!n) return `Dòng ${o.itemCode} đã được sao chép sang ${where} — không thể xóa dòng này.`
    if (n.itemCode !== o.itemCode) return `Dòng ${o.itemCode} đã được sao chép sang ${where} — không thể đổi mã hàng.`
    // Dữ liệu cũ có thể đã sao chép vượt SL dòng → không bắt tăng quá SL đang lưu
    const min = Math.min(c.qty, o.quantity)
    if (Math.round(n.quantity * 1000) < Math.round(min * 1000)) {
      return `Dòng ${o.itemCode}: số lượng không được nhỏ hơn số lượng đã sao chép (${min}) sang ${where}.`
    }
  }
  return null
}

/** id dòng đã lưu được giữ lại (dbId hợp lệ, không trùng) → tái dùng id khi ghi lại dòng */
export function keptLineIds(oldIds: string[], newLines: { dbId?: string | null }[]): (string | undefined)[] {
  const valid = new Set(oldIds)
  const used = new Set<string>()
  return newLines.map((l) => {
    const id = typeof l.dbId === 'string' ? l.dbId : ''
    if (!id || !valid.has(id) || used.has(id)) return undefined
    used.add(id)
    return id
  })
}
