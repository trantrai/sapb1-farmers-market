'use client'

// ============================================================
// BOM TRÊN DÒNG CHỨNG TỪ — dùng chung cho form Đơn hàng và form chứng từ
// bán hàng (báo giá, hóa đơn, ghi có, trả hàng, đặt cọc):
//  - Chọn mặt hàng BOM → bung thành phần con (giá 0, định mức theo công thức)
//  - Đổi SL dòng cha → SL con = SL cha × định mức
//  - Xóa dòng cha → xóa cả nhóm con
//  - Thu gọn / mở rộng nhóm con trên bảng
// Khi đẩy SAP, nhóm BOM Template gửi SL con NGƯỜI DÙNG đã chỉnh (xem
// buildSapLines: cha TreeType=iNotATree, con U_BOMID = mã cha).
// ============================================================

import { ArrowLeftRight, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { formatNum } from '@/lib/fm-shared'

export type BomKind = 'template' | 'production' | 'assembly'

export interface BomLineFields {
  key: number
  quantity: number
  /** Loại BOM của dòng cha (undefined = hàng thường) */
  bomType?: BomKind
  /** true = dòng thành phần con */
  isBomChild?: boolean
  /** Khóa nhóm: dòng cha + các dòng con cùng nhóm */
  bomGroupKey?: string
  /** Dòng con sửa được SL (Template) hay khóa theo công thức (Production/Assembly) */
  bomEditable?: boolean
  /** Định mức: SL con cho 1 đơn vị cha */
  bomQtyPerParent?: number
}

export interface BomComponentDef {
  childItemCode: string
  childItemName: string
  qtyPerParent: number
  uom: string
}

export interface BomDef {
  bomType: BomKind
  components: BomComponentDef[]
}

export const roundQty = (n: number) => Math.round(n * 1000) / 1000

/** Đọc công thức BOM của mặt hàng (null = hàng thường / lỗi tải) */
export async function fetchBomDef(itemCode: string): Promise<BomDef | null> {
  try {
    const res = await api(`/api/bom?parentItemCode=${encodeURIComponent(itemCode)}`)
    const j = await res.json()
    const t = j?.bomType
    if (t !== 'template' && t !== 'production' && t !== 'assembly') return null
    return { bomType: t, components: Array.isArray(j.components) ? j.components : [] }
  } catch {
    return null
  }
}

/**
 * Gắn nhóm BOM cho dòng `parentKey`: gỡ nhóm con cũ (nếu có), chèn các dòng
 * con mới ngay dưới dòng cha. def = null → dòng cha trở thành hàng thường.
 */
export function explodeBom<T extends BomLineFields>(
  lines: T[],
  parentKey: number,
  def: BomDef | null,
  makeChild: (c: BomComponentDef, parent: T, groupKey: string) => T,
): { lines: T[]; children: T[] } {
  const parent = lines.find((l) => l.key === parentKey)
  if (!parent) return { lines, children: [] }
  const withoutOld = parent.bomGroupKey
    ? lines.filter((l) => l.key === parentKey || l.bomGroupKey !== parent.bomGroupKey)
    : lines
  // Hậu tố thời gian: tránh trùng khóa nhóm đã lưu từ phiên trước (key dòng đếm lại từ 1)
  const groupKey = `bom_${parentKey}_${Date.now().toString(36)}`
  const children = def ? def.components.map((c) => makeChild(c, parent, groupKey)) : []
  const idx = withoutOld.findIndex((l) => l.key === parentKey)
  const next = [...withoutOld]
  next.splice(idx + 1, 0, ...children)
  next[idx] = { ...next[idx], bomType: def?.bomType, bomGroupKey: def ? groupKey : undefined }
  return { lines: next, children }
}

/** Đổi SL dòng cha BOM → SL mọi dòng con = SL cha × định mức */
export function applyParentQty<T extends BomLineFields>(lines: T[], parentKey: number, qty: number): T[] {
  const parent = lines.find((l) => l.key === parentKey)
  const next = lines.map((l) => (l.key === parentKey ? { ...l, quantity: qty } : l))
  if (!parent?.bomType || !parent.bomGroupKey) return next
  const pq = Number(qty) || 0
  return next.map((l) =>
    l.isBomChild && l.bomGroupKey === parent.bomGroupKey
      ? { ...l, quantity: roundQty(pq * (l.bomQtyPerParent ?? 0)) }
      : l,
  )
}

/** Xóa dòng: dòng cha BOM → xóa cả nhóm con; dòng thường/dòng con → chỉ dòng đó */
export function removeWithBom<T extends BomLineFields>(lines: T[], key: number): T[] {
  const target = lines.find((l) => l.key === key)
  if (target && !target.isBomChild && target.bomGroupKey) {
    return lines.filter((l) => l.bomGroupKey !== target.bomGroupKey)
  }
  return lines.filter((l) => l.key !== key)
}

/** Suy loại BOM của dòng cha từ dòng con khi nạp chứng từ đã lưu */
export function inferBomTypes<T extends BomLineFields>(lines: T[]): T[] {
  return lines.map((pl) => {
    if (pl.isBomChild || !pl.bomGroupKey) return pl
    const kids = lines.filter((k) => k.isBomChild && k.bomGroupKey === pl.bomGroupKey)
    if (kids.length === 0) return { ...pl, bomGroupKey: undefined }
    return { ...pl, bomType: kids.some((k) => k.bomEditable === false) ? 'production' : 'template' }
  })
}

/** Số dòng con theo nhóm */
export function bomChildCounts(lines: BomLineFields[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of lines) if (l.isBomChild && l.bomGroupKey) m.set(l.bomGroupKey, (m.get(l.bomGroupKey) ?? 0) + 1)
  return m
}

/**
 * Dòng hiển thị trên bảng: ẩn con của BOM Production/Assembly (khóa theo
 * công thức, vẫn giữ trong data để lưu) và con của nhóm đang thu gọn.
 */
export function visibleBomLines<T extends BomLineFields>(lines: T[], collapsed: ReadonlySet<string>): T[] {
  const pType = new Map(lines.filter((x) => !x.isBomChild && x.bomGroupKey).map((x) => [x.bomGroupKey as string, x.bomType]))
  return lines.filter((x) => {
    if (!x.isBomChild) return true
    const gk = x.bomGroupKey as string
    if (collapsed.has(gk)) return false
    const pt = pType.get(gk)
    if (pt === 'production' || pt === 'assembly') return false
    return pt === 'template' || x.bomEditable !== false
  })
}

/** Nút thu gọn / mở rộng nhóm thành phần con (đặt ở ô # của dòng cha) */
export function BomToggle({ collapsed, count, onToggle, parentLabel }: {
  collapsed: boolean
  count: number
  onToggle: () => void
  parentLabel: string
}) {
  return (
    <button
      type="button"
      className="fm-bom-toggle"
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? 'Mở rộng' : 'Thu gọn'} ${count} thành phần BOM của ${parentLabel}`}
      title={`${collapsed ? 'Mở rộng' : 'Thu gọn'} ${count} thành phần`}
      onClick={onToggle}
    >
      {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      <span className="fm-bom-toggle__count">{count}</span>
    </button>
  )
}

/** Ô mặt hàng của dòng con: mã, tên, định mức và mã BOM cha (U_BOMID) */
export function BomChildCell({ code, name, qtyPerParent, uom, parentCode, onSwap, disabled }: {
  code?: string
  name?: string
  qtyPerParent?: number
  uom?: string
  parentCode?: string
  /** BOM Template: mở popup hoán đổi thành phần với mặt hàng khác */
  onSwap?: () => void
  disabled?: boolean
}) {
  return (
    <div className="fm-bom-child-cell">
      <span className="fm-bom-child-cell__branch" aria-hidden>└─</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="fm-bom-child-cell__top">
          <b>{code}</b>
          {onSwap && (
            <button
              type="button"
              className="fm-bom-swap-btn"
              title="Hoán đổi thành phần với mặt hàng khác"
              aria-label={`Hoán đổi thành phần ${code ?? ''}`}
              onClick={onSwap}
              disabled={disabled}
            >
              <ArrowLeftRight size={13} aria-hidden /> Hoán đổi
            </button>
          )}
        </div>
        <div className="fm-bom-child-cell__name">{name}</div>
        <div className="fm-bom-child-cell__meta">
          Định mức: <span className="fm-num-inline">{formatNum(qtyPerParent ?? 0)}</span>{uom ? ` ${uom}` : ''} / 1 cha
          {parentCode ? <> · BOM: {parentCode}</> : null}
        </div>
      </div>
    </div>
  )
}
