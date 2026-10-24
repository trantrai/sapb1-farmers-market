// ============================================================
// Kiểm tra bắt buộc ở SERVER khi lưu đơn hàng bán (POST/PUT /api/orders):
// - Ngày hợp lệ, ngày giao không trước ngày chứng từ
// - Mặt hàng có trong danh mục đã đồng bộ của DB đơn hàng (form chọn hàng
//   từ mirror; DB chưa đồng bộ bản ghi nào → bỏ qua để không chặn nhầm)
// Khách hàng KHÔNG kiểm ở đây: form chọn KH trực tiếp trên SAP (có thể
// chưa có trong mirror) — SAP tự từ chối khi đẩy nếu CardCode sai.
// Sửa đơn: mã đã có sẵn trong đơn được giữ (danh mục có thể đã gỡ mã đó).
// ============================================================
import { db as prisma } from '@/lib/db'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/

/** null = hợp lệ; ngược lại thông điệp lỗi tiếng Việt */
export function checkOrderDates(docDate: string, docDueDate: string): string | null {
  const doc = String(docDate).slice(0, 10)
  const due = String(docDueDate).slice(0, 10)
  if (!ISO_DATE.test(doc) || Number.isNaN(Date.parse(doc))) return 'Ngày chứng từ không hợp lệ'
  if (!ISO_DATE.test(due) || Number.isNaN(Date.parse(due))) return 'Ngày giao hàng không hợp lệ'
  if (due < doc) {
    const dmy = (s: string) => s.split('-').reverse().join('/')
    return `Ngày giao ${dmy(due)} trước ngày chứng từ ${dmy(doc)} — sửa lại ngày giao`
  }
  return null
}

/**
 * Mặt hàng phải tồn tại trong danh mục đồng bộ của DB (dbId null = không lọc DB).
 * keepItemCodes: mã đã có trong đơn (sửa đơn) — không bắt buộc còn trong danh mục.
 */
export async function checkOrderItems(
  dbId: string | null,
  itemCodes: string[],
  keepItemCodes: Iterable<string> = [],
): Promise<string | null> {
  const scope = dbId ? { sapDatabaseId: { in: [dbId, ''] } } : {}
  const keep = new Set(keepItemCodes)
  const codes = [...new Set(itemCodes)].filter((c) => !keep.has(c))
  if (codes.length === 0) return null
  const found = await prisma.item.findMany({ where: { ...scope, itemCode: { in: codes } }, select: { itemCode: true } })
  if (found.length === codes.length) return null
  const have = new Set(found.map((f) => f.itemCode))
  const missing = codes.filter((c) => !have.has(c))
  if (missing.length === 0) return null
  if ((await prisma.item.count({ where: scope })) === 0) return null
  const list = missing.slice(0, 3).join(', ') + (missing.length > 3 ? ` (+${missing.length - 3})` : '')
  return `Mặt hàng ${list} không có trong danh mục đã đồng bộ — xóa dòng đó hoặc đồng bộ Mặt hàng`
}
