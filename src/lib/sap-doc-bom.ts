// ============================================================
// Dựng lại nhóm BOM Template cho chứng từ ĐỌC TRỰC TIẾP từ SAP (chỉ xem):
// dòng có U_BOMID = mã cha → dòng con của dòng cha gần nhất phía trên cùng mã.
// Dòng con nằm cuối chứng từ (thành phần hoán đổi/thêm khi đẩy 2 bước) được
// xếp lại ngay dưới dòng cha để hiển thị đúng nhóm.
// ============================================================

export interface BomViewLine {
  lineNum: number
  itemCode: string
  bomId?: string | null
}

export type WithBom<T> = T & { isBomChild: boolean; bomGroupKey: string | null; bomEditable: boolean }

export function attachSapBomGroups<T extends BomViewLine>(lines: T[]): WithBom<T>[] {
  const sorted = [...lines].sort((a, b) => a.lineNum - b.lineNum)
  const parentOf = new Map<T, T>() // con → cha
  for (let i = 0; i < sorted.length; i++) {
    const l = sorted[i]
    if (!l.bomId) continue
    for (let j = i - 1; j >= 0; j--) {
      const p = sorted[j]
      if (!p.bomId && p.itemCode === l.bomId) { parentOf.set(l, p); break }
    }
  }
  const parents = new Set(parentOf.values())
  const kidsOf = new Map<T, T[]>()
  for (const [kid, p] of parentOf) kidsOf.set(p, [...(kidsOf.get(p) ?? []), kid])

  const out: WithBom<T>[] = []
  for (const l of sorted) {
    if (parentOf.has(l)) continue // con được chèn ngay sau cha
    const key = parents.has(l) ? `bom-${l.lineNum}` : null
    out.push({ ...l, isBomChild: false, bomGroupKey: key, bomEditable: true })
    for (const k of kidsOf.get(l) ?? []) out.push({ ...k, isBomChild: true, bomGroupKey: key, bomEditable: true })
  }
  return out
}
