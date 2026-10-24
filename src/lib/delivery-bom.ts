// ============================================================
// BOM TRÊN PHIẾU GIAO HÀNG
// Phiếu giao hàng lưu nhóm BOM (dòng cha + dòng con cùng bomGroupKey) giống
// đơn hàng để hiển thị / soạn hàng. Khi đẩy SAP chỉ gửi dòng cha + hàng
// thường (payload không đổi so với trước) — SAP tự bung BOM theo công thức.
// SL dòng con luôn = SL cha × định mức; giá/CK dòng con = 0.
// ============================================================

export interface DeliveryBomFields {
  isBomChild: boolean
  bomGroupKey: string | null
  bomEditable: boolean
  bomQtyPerParent: number | null
}

interface BomLike {
  isBomChild?: boolean | null
  bomGroupKey?: string | null
  bomEditable?: boolean | null
  bomQtyPerParent?: number | null
}

/** Quy đổi SL con = SL cha × định mức (làm tròn 3 chữ số — khớp fm-bom.recalcChildQty) */
export const childQtyFor = (parentQty: number, qtyPerParent: number): number =>
  Math.round((Number(parentQty) || 0) * (Number(qtyPerParent) || 0) * 1000) / 1000

/** Ép kiểu các trường BOM từ body/DB (chuỗi rỗng → null) */
export function bomFieldsOf(l: BomLike | null | undefined): DeliveryBomFields {
  const gk = typeof l?.bomGroupKey === 'string' ? l.bomGroupKey.trim().slice(0, 64) : ''
  const per = Number(l?.bomQtyPerParent)
  return {
    isBomChild: Boolean(gk) && l?.isBomChild === true,
    bomGroupKey: gk || null,
    bomEditable: l?.bomEditable !== false,
    bomQtyPerParent: Number.isFinite(per) && per > 0 ? per : null,
  }
}

/**
 * Chuẩn hóa nhóm BOM của danh sách dòng (giữ thứ tự):
 * - Dòng con không có dòng cha cùng nhóm → thành dòng thường (bỏ cờ BOM).
 * - Dòng cha không còn dòng con → bỏ bomGroupKey.
 * - Dòng con có định mức → SL = SL cha × định mức (không tin SL client gửi).
 */
export function normalizeDeliveryBom<T extends BomLike & { quantity: number }>(lines: T[]): (T & DeliveryBomFields)[] {
  const rows = lines.map((l) => ({ ...l, ...bomFieldsOf(l) }))
  const parentQty = new Map<string, number>()
  const childCount = new Map<string, number>()
  for (const r of rows) {
    if (!r.bomGroupKey) continue
    if (r.isBomChild) childCount.set(r.bomGroupKey, (childCount.get(r.bomGroupKey) ?? 0) + 1)
    else if (!parentQty.has(r.bomGroupKey)) parentQty.set(r.bomGroupKey, r.quantity)
  }
  return rows.map((r) => {
    if (!r.bomGroupKey) return r
    if (r.isBomChild) {
      const pq = parentQty.get(r.bomGroupKey)
      if (pq === undefined) return { ...r, isBomChild: false, bomGroupKey: null, bomEditable: true, bomQtyPerParent: null }
      return r.bomQtyPerParent != null ? { ...r, quantity: childQtyFor(pq, r.bomQtyPerParent) } : r
    }
    return childCount.get(r.bomGroupKey) ? r : { ...r, bomGroupKey: null }
  })
}

/** Dòng được gửi lên SAP: bỏ dòng con BOM (SAP tự bung theo công thức của dòng cha) */
export const isSapDeliveryLine = (l: BomLike) => !l.isBomChild

/**
 * Copy-from (đơn hàng/báo giá → giao hàng): từ các dòng cha/hàng thường đã chọn,
 * gắn kèm dòng con BOM của chứng từ nguồn ngay sau dòng cha, SL con = SL giao
 * của cha × (SL con / SL cha trên nguồn). Dòng con không có cha được chọn → bỏ. Giữ thứ tự nguồn.
 */
export function pickWithBomChildren<L extends BomLike & { id: string; quantity: number }>(
  all: L[],
  picked: { line: L; qty: number }[],
): { line: L; qty: number; bomQtyPerParent: number | null }[] {
  const pickedById = new Map(picked.filter((p) => !p.line.isBomChild).map((p) => [p.line.id, p]))
  const groups = new Map<string, { qty: number; parent: L }>()
  for (const p of pickedById.values()) if (p.line.bomGroupKey) groups.set(p.line.bomGroupKey, { qty: p.qty, parent: p.line })
  const out: { line: L; qty: number; bomQtyPerParent: number | null }[] = []
  for (const l of all) {
    if (l.isBomChild) {
      const g = l.bomGroupKey ? groups.get(l.bomGroupKey) : undefined
      if (!g) continue
      // Tỉ lệ thực tế trên chứng từ nguồn (BOM Template có thể đã sửa SL con) → fallback định mức
      const per = g.parent.quantity > 0 ? l.quantity / g.parent.quantity : (l.bomQtyPerParent ?? 0)
      const qty = childQtyFor(g.qty, per)
      if (qty > 0) out.push({ line: l, qty, bomQtyPerParent: per })
      continue
    }
    const p = pickedById.get(l.id)
    if (p) out.push({ ...p, bomQtyPerParent: null })
  }
  return out
}
