// ============================================================
// BOM — ĐỊNH MỨC NGUYÊN VẬT LIỆU (SAP B1 ProductTrees / OITT)
// - loadProductTrees: tải BOM Template + Production + Assembly từ Service Layer
// - normalizeTree: chuẩn hóa số lượng con cho 1 ĐƠN VỊ cha
// - getBomDefinition: đọc công thức BOM từ mirror local (theo database)
// - recalcChildQty: quy đổi số lượng con theo công thức khi đổi SL cha
// ============================================================

import { sapGetAll, type SapConfig } from './sap-service-layer'
import { db as prisma } from './db'
import { numv } from './fm-items'

/** Loại BOM mà app hỗ trợ (ánh xạ từ ProductTrees.TreeType của SAP B1) */
export type BomType = 'none' | 'template' | 'production' | 'assembly'
export const BOM_TYPES: BomType[] = ['template', 'production', 'assembly']

/** Nhãn tiếng Việt cho từng loại BOM */
export const BOM_LABEL: Record<BomType, string> = {
  none: 'Hàng thường',
  template: 'BOM Template',
  production: 'BOM Production',
  assembly: 'BOM Assembly',
}

interface B1ProductTreeLine {
  ItemCode?: string
  ItemName?: string
  Quantity?: number | string
  UnitOfMeasure?: string
  SortOrder?: number | string
}

interface B1ProductTree {
  TreeCode?: string
  TreeType?: string
  /** Số lượng cha mà các dòng con đang định mức theo */
  Quantity?: number | string
  ProductTreeLines?: B1ProductTreeLine[] | { results?: B1ProductTreeLine[] }
}

/** Ánh xạ TreeType SAP → BomType của app (Template + Production + Assembly) */
export function mapTreeType(t: unknown): BomType {
  const v = String(t ?? '').trim()
  if (v === 'iTemplateTree') return 'template'
  if (v === 'iProductionTree') return 'production'
  if (v === 'iAssemblyTree') return 'assembly'
  return 'none'
}

export interface BomComponentRow {
  childItemCode: string
  childItemName: string
  /** Số lượng con cho 1 ĐƠN VỊ cha (đã chuẩn hóa) */
  qtyPerParent: number
  uom: string
  sortOrder: number
}

export interface BomDefinition {
  parentItemCode: string
  bomType: BomType
  components: BomComponentRow[]
}

/**
 * Tải toàn bộ BOM Template + Production + Assembly từ Service Layer.
 * Lấy nguyên văn /ProductTrees (bảng OITT thường nhỏ) rồi lọc TreeType tại chỗ
 * — tránh $filter phức tạp mà nhiều bản SL từ chối.
 */
export async function loadProductTrees(
  s: SapConfig,
  onProgress?: (fetched: number) => void,
): Promise<{ trees: B1ProductTree[]; error?: string }> {
  const r = await sapGetAll<B1ProductTree>(s, '/ProductTrees', {
    $select: 'TreeCode,TreeType,Quantity,ProductTreeLines',
    $orderby: 'TreeCode',
  })
  if (!r.ok || !r.data) {
    // Dự phòng: thử không $select (bản SL cũ)
    const r2 = await sapGetAll<B1ProductTree>(s, '/ProductTrees', { $orderby: 'TreeCode' })
    if (!r2.ok || !r2.data) return { trees: [], error: r.error ?? r2.error ?? 'Lỗi Service Layer' }
    onProgress?.(r2.data.length)
    return { trees: r2.data }
  }
  onProgress?.(r.data.length)
  return { trees: r.data }
}

const asLineArray = (v: B1ProductTree['ProductTreeLines']): B1ProductTreeLine[] => {
  if (Array.isArray(v)) return v
  if (v && Array.isArray(v.results)) return v.results
  return []
}

/**
 * Chuẩn hóa 1 cây BOM → định mức cho 1 đơn vị cha.
 * Trả null khi không phải Template/Production/Assembly hoặc không có thành phần hợp lệ.
 */
export function normalizeTree(t: B1ProductTree): BomDefinition | null {
  const bomType = mapTreeType(t.TreeType)
  const parentItemCode = String(t.TreeCode ?? '').trim()
  if (bomType === 'none' || !parentItemCode) return null
  const treeQty = numv(t.Quantity) || 1 // SL cha mà định mức đang tính theo
  const components: BomComponentRow[] = []
  for (const ln of asLineArray(t.ProductTreeLines)) {
    const childItemCode = String(ln.ItemCode ?? '').trim()
    if (!childItemCode) continue
    const qtyPerParent = numv(ln.Quantity) / treeQty
    if (!(qtyPerParent > 0)) continue
    components.push({
      childItemCode,
      childItemName: String(ln.ItemName ?? ''),
      qtyPerParent,
      uom: String(ln.UnitOfMeasure ?? ''),
      sortOrder: Math.trunc(numv(ln.SortOrder)),
    })
  }
  if (components.length === 0) return null
  components.sort((a, b) => a.sortOrder - b.sortOrder || a.childItemCode.localeCompare(b.childItemCode))
  return { parentItemCode, bomType, components }
}

/** Quy đổi số lượng con = SL cha × định mức (làm tròn 3 chữ số thập phân) */
export const recalcChildQty = (parentQty: number, qtyPerParent: number): number =>
  Math.round(numv(parentQty) * numv(qtyPerParent) * 1000) / 1000

/** Đọc công thức BOM của 1 mặt hàng cha từ mirror local (đúng database của phiên) */
export async function getBomDefinition(
  dbId: string | null,
  parentItemCode: string,
): Promise<BomDefinition | null> {
  const dbScope = dbId ? { sapDatabaseId: dbId } : {}
  const item = await prisma.item.findFirst({
    where: { ...dbScope, itemCode: parentItemCode },
    select: { bomType: true },
  })
  const bomType = (item?.bomType === 'template' || item?.bomType === 'production' || item?.bomType === 'assembly' ? item.bomType : 'none') as BomType
  if (bomType === 'none') return null
  const rows = await prisma.bomComponent.findMany({
    where: { ...dbScope, parentItemCode },
    orderBy: [{ sortOrder: 'asc' }, { childItemCode: 'asc' }],
  })
  if (rows.length === 0) return null
  return {
    parentItemCode,
    bomType,
    components: rows.map((r) => ({
      childItemCode: r.childItemCode,
      childItemName: r.childItemName,
      qtyPerParent: r.quantity,
      uom: r.uom,
      sortOrder: r.sortOrder,
    })),
  }
}

/** Danh sách mã mặt hàng cha có BOM (để gắn bomType cho mirror Item khi sync) */
export function indexTrees(trees: B1ProductTree[]): Map<string, BomDefinition> {
  const map = new Map<string, BomDefinition>()
  for (const t of trees) {
    const def = normalizeTree(t)
    if (def && !map.has(def.parentItemCode)) map.set(def.parentItemCode, def)
  }
  return map
}
