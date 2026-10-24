// ============================================================
// Dựng lại nhóm BOM Template cho chứng từ ĐỌC TRỰC TIẾP từ SAP (chỉ xem):
// dòng có U_BOMID = mã cha → dòng con của dòng cha gần nhất phía trên cùng mã.
// Dòng con nằm cuối chứng từ (thành phần hoán đổi/thêm khi đẩy 2 bước) được
// xếp lại ngay dưới dòng cha để hiển thị đúng nhóm.
// Chứng từ tạo trên SAP (SAP tự bung BOM): dòng TreeType=iIngredient là con của
// dòng cha BOM (iSalesTree/iTemplateTree/iAssemblyTree/iProductionTree) liền trên.
// ============================================================

export interface BomViewLine {
  lineNum: number
  itemCode: string
  bomId?: string | null
  treeType?: string | null
}

export type SapBomKind = 'template' | 'production' | 'assembly'
export type WithBom<T> = T & { isBomChild: boolean; bomGroupKey: string | null; bomEditable: boolean; bomType?: SapBomKind }

const PARENT_TREES: Record<string, SapBomKind | undefined> = {
  iSalesTree: undefined,
  iTemplateTree: 'template',
  iAssemblyTree: 'assembly',
  iProductionTree: 'production',
}
const isTreeParent = (l: BomViewLine) => !!l.treeType && l.treeType in PARENT_TREES

export function attachSapBomGroups<T extends BomViewLine>(lines: T[]): WithBom<T>[] {
  const sorted = [...lines].sort((a, b) => a.lineNum - b.lineNum)
  const parentOf = new Map<T, T>() // con → cha
  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i]
    if (l.bomId) {
      for (let j = i - 1; j >= 0; j--) {
        const p = sorted[j]
        if (!p.bomId && p.itemCode === l.bomId) { parentOf.set(l, p); break }
      }
      if (parentOf.has(l)) continue
    }
    if (l.treeType === 'iIngredient') {
      // Bỏ qua các thành phần liền trên → dòng đầu tiên khác thành phần phải là cha BOM
      let j = i - 1
      while (j >= 0 && sorted[j].treeType === 'iIngredient') j--
      if (j >= 0 && isTreeParent(sorted[j])) parentOf.set(l, sorted[j])
    }
  }
  const parents = new Set(parentOf.values())
  const kidsOf = new Map<T, T[]>()
  for (const [kid, p] of parentOf) kidsOf.set(p, [...(kidsOf.get(p) ?? []), kid])

  const out: WithBom<T>[] = []
  for (const l of sorted) {
    if (parentOf.has(l)) continue // con được chèn ngay sau cha
    const key = parents.has(l) ? `bom-${l.lineNum}` : null
    const bomType = key && l.treeType ? PARENT_TREES[l.treeType] : undefined
    out.push({ ...l, isBomChild: false, bomGroupKey: key, bomEditable: true, ...(bomType ? { bomType } : {}) })
    // Con do SAP bung theo BOM Production/Assembly: SL theo công thức (khóa)
    const locked = bomType === 'production' || bomType === 'assembly'
    for (const k of kidsOf.get(l) ?? []) out.push({ ...k, isBomChild: true, bomGroupKey: key, bomEditable: !locked })
  }
  return out
}
