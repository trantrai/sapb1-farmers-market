// ============================================================
// VALIDATE DÒNG BOM CHO ĐƠN HÀNG (dùng chung POST tạo mới + PUT sửa đơn)
// - Dòng con: giá = 0 (đã ép ở validateOrderLines), phải thuộc nhóm có dòng cha
// - BOM Production: số lượng con PHẢI đúng công thức (SL cha × định mức),
//   client gửi sai → 400 (chống giả mạo / công thức cũ)
// - BOM Template: số lượng con được chỉnh tự do; được HOÁN ĐỔI thành phần
//   sang mặt hàng khác (không thuộc công thức) — mặt hàng thay thế phải có
//   trong danh mục mặt hàng đã đồng bộ và không được là chính mặt hàng cha
// ============================================================

import { getBomDefinitions, recalcChildQty } from './fm-bom'
import { db as prisma } from './db'
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

  // BOM Template: thành phần hoán đổi (ngoài công thức) → kiểm tra có trong danh mục mặt hàng
  const swapCodes = new Set<string>()
  for (const g of groups.values()) {
    const def = g.parent ? defs.get(g.parent.itemCode) : undefined
    if (!def || def.bomType !== 'template') continue
    const inDef = new Set(def.components.map((c) => c.childItemCode))
    for (const child of g.children) if (!inDef.has(child.itemCode)) swapCodes.add(child.itemCode)
  }
  const knownItems = new Set<string>()
  if (swapCodes.size > 0) {
    const rows = await prisma.item.findMany({
      where: { ...(dbId ? { sapDatabaseId: dbId } : {}), itemCode: { in: [...swapCodes] } },
      select: { itemCode: true },
    })
    for (const r of rows) knownItems.add(r.itemCode)
  }
  // Danh mục mặt hàng chưa đồng bộ (form đang tìm trực tiếp trên SAP) → không đối chiếu được, bỏ qua kiểm tra
  const catalogEmpty = swapCodes.size > 0 && knownItems.size === 0
    && (await prisma.item.count({ where: dbId ? { sapDatabaseId: dbId } : {} })) === 0

  for (const [gk, g] of groups) {
    if (!g.parent || g.children.length === 0) continue
    const def = defs.get(g.parent.itemCode)
    if (!def) continue // công thức đã bị xóa khỏi mirror → giữ nguyên như client gửi

    const compMap = new Map(def.components.map((c) => [c.childItemCode, c]))
    for (const child of g.children) {
      const comp = compMap.get(child.itemCode)
      if (!comp && def.bomType === 'template') {
        // Thành phần đã được người dùng hoán đổi sang mặt hàng khác
        if (child.itemCode === g.parent.itemCode) {
          return { lines: [], error: `Không thể dùng chính mặt hàng ${g.parent.itemCode} làm thành phần BOM của nó` }
        }
        if (!catalogEmpty && !knownItems.has(child.itemCode)) {
          return { lines: [], error: `Mặt hàng thay thế ${child.itemCode} không có trong danh mục mặt hàng đã đồng bộ` }
        }
        child.bomEditable = true
        continue
      }
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
