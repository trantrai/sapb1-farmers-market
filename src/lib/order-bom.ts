// ============================================================
// VALIDATE DÒNG BOM CHO ĐƠN HÀNG (dùng chung POST tạo mới + PUT sửa đơn)
// - Dòng con: giá = 0 (đã ép ở validateOrderLines), phải thuộc nhóm có dòng cha
// - BOM Production: số lượng con PHẢI đúng công thức (SL cha × định mức),
//   client gửi sai → 400 (chống giả mạo / công thức cũ)
// - BOM Template: số lượng con được chỉnh tự do, chỉ kiểm tra mã con
//   có thuộc công thức của cha không
// ============================================================

import { getBomDefinitions, recalcChildQty } from './fm-bom'
import type { OrderLineInput } from './order-calc'

export interface BomLineInput extends OrderLineInput {
  isBomChild?: boolean
  bomGroupKey?: string | null
  bomEditable?: boolean
}

/**
 * Chuẩn hóa + kiểm tra các nhóm BOM trong đơn.
 * Trả { error } khi vi phạm; ngược lại trả lines đã chuẩn hóa
 * (bomEditable ép theo loại BOM thật trong mirror).
 */
export async function normalizeBomLines<T extends BomLineInput>(
  dbId: string | null,
  lines: T[],
): Promise<{ lines: T[]; error?: string }> {
  const groups = new Map<string, { parent: T; children: T[] }>()
  for (const l of lines) {
    const gk = typeof l.bomGroupKey === 'string' ? l.bomGroupKey : ''
    if (!gk) continue
    let g = groups.get(gk)
    if (!g) {
      g = { parent: null as unknown as T, children: [] }
      groups.set(gk, g)
    }
    if (l.isBomChild) g.children.push(l)
    else g.parent = l
  }

  // Gộp: đọc công thức BOM của TẤT CẢ các cha trong 1 lần (2 query),
  // thay vì mỗi nhóm BOM 1 cặp query nối tiếp (đơn có g cha = 2g query)
  const parentCodes = [...new Set(
    [...groups.values()]
      .filter((g) => g.parent && g.children.length > 0)
      .map((g) => g.parent.itemCode),
  )]
  const defs = await getBomDefinitions(dbId, parentCodes)

  for (const [gk, g] of groups) {
    if (!g.parent || g.children.length === 0) continue
    const def = defs.get(g.parent.itemCode)
    if (!def) continue // công thức đã bị xóa khỏi mirror → giữ nguyên như client gửi

    const compMap = new Map(def.components.map((c) => [c.childItemCode, c]))
    for (const child of g.children) {
      const comp = compMap.get(child.itemCode)
      if (!comp) {
        return {
          lines: [],
          error: `Thành phần ${child.itemCode} không thuộc công thức BOM của ${g.parent.itemCode}`,
        }
      }
      if (def.bomType === 'production' || def.bomType === 'assembly') {
        // Production/Assembly: số lượng con khóa theo công thức — không cho sửa
        const expected = recalcChildQty(g.parent.quantity, comp.qtyPerParent)
        if (Math.abs(Number(child.quantity) - expected) > 0.001) {
          return {
            lines: [],
            error: `Số lượng ${child.itemCode} phải theo công thức BOM ${def.bomType === 'assembly' ? 'Assembly' : 'Production'} (${expected}) — không được sửa tay`,
          }
        }
        child.bomEditable = false
      } else {
        child.bomEditable = true
      }
    }
  }
  return { lines }
}
