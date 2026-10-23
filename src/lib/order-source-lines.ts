import { db as prisma } from './db'

/**
 * Copy-from Báo giá → Đơn hàng (nút "Sao chép từ…" trên form): mỗi dòng có thể
 * mang sourceLineId = id dòng báo giá nguồn — lúc đẩy SAP sẽ thành BaseType 23 /
 * BaseEntry / BaseLine. Không tin client: id phải là dòng báo giá có thật, cùng
 * khách hàng, đúng mã hàng. Trả map dòng → sourceLineId đã chuẩn hóa hoặc lỗi.
 */
export async function checkOrderSourceLines(
  lines: Array<{ itemCode: string; sourceLineId?: unknown }>,
  cardCode: string,
): Promise<{ ids: (string | null)[]; error?: string }> {
  const ids = lines.map((l) => {
    const v = typeof l.sourceLineId === 'string' ? l.sourceLineId.trim() : ''
    return v && v.length <= 64 ? v : null
  })
  const uniq = [...new Set(ids.filter((x): x is string => !!x))]
  if (uniq.length === 0) return { ids }
  const rows = await prisma.quotationLine.findMany({
    where: { id: { in: uniq } },
    select: { id: true, itemCode: true, quotation: { select: { cardCode: true, docNum: true } } },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (let i = 0; i < lines.length; i++) {
    const id = ids[i]
    if (!id) continue
    const src = byId.get(id)
    if (!src) return { ids, error: `Dòng ${lines[i].itemCode}: không tìm thấy dòng báo giá nguồn (sao chép từ)` }
    if (src.quotation.cardCode !== cardCode) {
      return { ids, error: `Dòng ${lines[i].itemCode}: báo giá nguồn #${src.quotation.docNum ?? ''} thuộc khách hàng khác` }
    }
    if (src.itemCode !== lines[i].itemCode) {
      return { ids, error: `Dòng ${lines[i].itemCode}: khác mã hàng với dòng báo giá nguồn (${src.itemCode})` }
    }
  }
  return { ids }
}
