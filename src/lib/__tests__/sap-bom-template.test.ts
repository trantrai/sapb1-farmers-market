// ============================================================
// Test BOM Template:
// - Payload SAP: cha gửi như hàng thường (SAP luôn tự bung Template — đẩy 2
//   bước ở sap-bom-reconcile), con mang SL người dùng đã chỉnh, giá 0, U_BOMID = mã cha
// - Production/Assembly giữ nguyên hành vi cũ
// - Logic dòng trên form: bung con, nhân định mức, xóa cha xóa con, thu gọn
// ============================================================
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/fm-client', () => ({ api: vi.fn() }))

import { buildSapDocPayload, buildSapLines, bomLineFields } from '@/lib/sap-push-document'
import {
  applyParentQty,
  explodeBom,
  inferBomTypes,
  removeWithBom,
  visibleBomLines,
  bomParentTypes,
  isLockedBomChild,
  type BomLineFields,
} from '@/components/fm/bom-lines'

const tplLines = [
  { itemCode: 'GIO-QUA', quantity: 2, unitPrice: 500000, discPct: 5, isBomChild: false, bomGroupKey: 'g1' },
  // Định mức 3/cha → mặc định 6, người dùng sửa thành 7
  { itemCode: 'TAO', quantity: 7, unitPrice: 12345, discPct: 10, isBomChild: true, bomGroupKey: 'g1', bomEditable: true },
  { itemCode: 'CAM', quantity: 4, unitPrice: 0, isBomChild: true, bomGroupKey: 'g1', bomEditable: true },
  { itemCode: 'RAU', quantity: 1, unitPrice: 20000 },
]

describe('buildSapLines — BOM Template', () => {
  const out = buildSapLines(tplLines) as Record<string, unknown>[]

  it('dòng cha giữ giá/CK của cha, không gửi TreeType (SAP bỏ qua iNotATree)', () => {
    expect(out[0]).toMatchObject({ ItemCode: 'GIO-QUA', UnitPrice: 500000, DiscountPercent: 5 })
    expect(out[0]).not.toHaveProperty('TreeType')
    expect(out[0]).not.toHaveProperty('U_BOMID')
  })

  it('dòng con gửi SL người dùng đã chỉnh, giá 0, không CK, U_BOMID = mã cha', () => {
    expect(out[1]).toMatchObject({ ItemCode: 'TAO', Quantity: 7, UnitPrice: 0, DiscountPercent: 0, U_BOMID: 'GIO-QUA' })
    expect(out[2]).toMatchObject({ ItemCode: 'CAM', Quantity: 4, U_BOMID: 'GIO-QUA' })
    expect(out[1]).not.toHaveProperty('TreeType')
  })

  it('hàng thường không bị ảnh hưởng', () => {
    expect(out[3]).not.toHaveProperty('TreeType')
    expect(out[3]).not.toHaveProperty('U_BOMID')
    expect(out[3]).toMatchObject({ UnitPrice: 20000 })
  })

  it('BOM Production/Assembly (con khóa SL) giữ hành vi cũ', () => {
    const prod = buildSapLines([
      { itemCode: 'P', quantity: 1, unitPrice: 100, isBomChild: false, bomGroupKey: 'g2' },
      { itemCode: 'C', quantity: 2, unitPrice: 0, isBomChild: true, bomGroupKey: 'g2', bomEditable: false },
    ]) as Record<string, unknown>[]
    expect(prod[0]).not.toHaveProperty('TreeType')
    expect(prod[1]).not.toHaveProperty('U_BOMID')
  })

  it('PATCH giữ LineNum và vẫn áp quy tắc BOM', () => {
    const p = buildSapLines(tplLines, [0, 1, null, 3]) as Record<string, unknown>[]
    expect(p[1]).toMatchObject({ LineNum: 1, Quantity: 7, U_BOMID: 'GIO-QUA' })
    expect(p[2]).not.toHaveProperty('LineNum')
    // Cha đã có trên SAP: không gửi lại ItemCode (tránh SAP bung công thức lần nữa)
    expect(p[0]).toMatchObject({ LineNum: 0, Quantity: 2 })
    expect(p[0]).not.toHaveProperty('ItemCode')
  })

  it('buildSapDocPayload (POST) áp dụng cho DocumentLines', () => {
    const doc = buildSapDocPayload({ cardCode: 'C1', docDate: '2026-10-23', docDueDate: '2026-10-30', lines: tplLines })
    expect(doc.DocumentLines[1]).toMatchObject({ U_BOMID: 'GIO-QUA', Quantity: 7 })
  })

  it('bomLineFields lấy đúng trường từ bản ghi DB', () => {
    expect(bomLineFields({ isBomChild: true, bomGroupKey: 'g', bomEditable: true })).toEqual({ isBomChild: true, bomGroupKey: 'g', bomEditable: true })
    expect(bomLineFields({})).toEqual({ isBomChild: false, bomGroupKey: null, bomEditable: null })
  })
})

describe('bom-lines — thao tác dòng trên form', () => {
  type L = BomLineFields & { code: string }
  const def = {
    bomType: 'template' as const,
    components: [
      { childItemCode: 'TAO', childItemName: 'Táo', qtyPerParent: 3, uom: 'kg' },
      { childItemCode: 'CAM', childItemName: 'Cam', qtyPerParent: 0.5, uom: 'kg' },
    ],
  }
  const make = (c: { childItemCode: string; qtyPerParent: number }, p: L, gk: string): L => ({
    key: Math.random(), code: c.childItemCode, quantity: p.quantity * c.qtyPerParent,
    isBomChild: true, bomGroupKey: gk, bomEditable: true, bomQtyPerParent: c.qtyPerParent,
  })
  const base: L[] = [{ key: 1, code: 'GIO', quantity: 2 }, { key: 2, code: 'RAU', quantity: 1 }]

  it('bung thành phần con ngay dưới dòng cha, SL = SL cha × định mức', () => {
    const { lines } = explodeBom(base, 1, def, make)
    expect(lines.map((l) => l.code)).toEqual(['GIO', 'TAO', 'CAM', 'RAU'])
    expect(lines[0].bomType).toBe('template')
    expect(lines.slice(1, 3).map((l) => l.quantity)).toEqual([6, 1])
  })

  it('đổi SL cha → nhân lại định mức cho mọi dòng con', () => {
    const { lines } = explodeBom(base, 1, def, make)
    const edited = lines.map((l) => (l.code === 'TAO' ? { ...l, quantity: 9 } : l))
    const r = applyParentQty(edited, 1, 4)
    expect(r.find((l) => l.code === 'TAO')!.quantity).toBe(12)
    expect(r.find((l) => l.code === 'CAM')!.quantity).toBe(2)
    expect(r.find((l) => l.code === 'RAU')!.quantity).toBe(1)
  })

  it('xóa dòng cha → xóa cả nhóm con; xóa hàng thường chỉ xóa dòng đó', () => {
    const { lines } = explodeBom(base, 1, def, make)
    expect(removeWithBom(lines, 1).map((l) => l.code)).toEqual(['RAU'])
    expect(removeWithBom(lines, 2).map((l) => l.code)).toEqual(['GIO', 'TAO', 'CAM'])
  })

  it('đổi sang hàng thường (def = null) → gỡ nhóm con cũ', () => {
    const { lines } = explodeBom(base, 1, def, make)
    const r = explodeBom(lines, 1, null, make).lines
    expect(r.map((l) => l.code)).toEqual(['GIO', 'RAU'])
    expect(r[0].bomGroupKey).toBeUndefined()
  })

  it('thu gọn nhóm → ẩn dòng con; con Production luôn ẩn', () => {
    const { lines } = explodeBom(base, 1, def, make)
    const gk = lines[0].bomGroupKey!
    expect(visibleBomLines(lines, new Set()).length).toBe(4)
    expect(visibleBomLines(lines, new Set([gk])).map((l) => l.code)).toEqual(['GIO', 'RAU'])
    const prod = lines.map((l) => (l.key === 1 ? { ...l, bomType: 'production' as const } : l))
    expect(visibleBomLines(prod, new Set()).map((l) => l.code)).toEqual(['GIO', 'RAU'])
  })

  it('thiết lập hiện con Production → hiện nhưng luôn khóa SL; thu gọn vẫn ẩn', () => {
    const { lines } = explodeBom(base, 1, def, make)
    const gk = lines[0].bomGroupKey!
    for (const t of ['production', 'assembly'] as const) {
      const prod = lines.map((l) => (l.key === 1 ? { ...l, bomType: t } : l))
      expect(visibleBomLines(prod, new Set(), true).length).toBe(4)
      expect(visibleBomLines(prod, new Set([gk]), true).map((l) => l.code)).toEqual(['GIO', 'RAU'])
      const pt = bomParentTypes(prod)
      // Khóa theo loại BOM của cha, kể cả khi dòng con lưu bomEditable=true (dữ liệu cũ)
      expect(prod.filter((l) => l.isBomChild).every((l) => isLockedBomChild({ ...l, bomEditable: true }, pt))).toBe(true)
      expect(isLockedBomChild(prod[0], pt)).toBe(false)
    }
    // Template: không khóa
    expect(lines.filter((l) => l.isBomChild).some((l) => isLockedBomChild(l, bomParentTypes(lines)))).toBe(false)
  })

  it('nạp chứng từ đã lưu → suy lại loại BOM của dòng cha', () => {
    const saved: L[] = [
      { key: 1, code: 'GIO', quantity: 1, bomGroupKey: 'g' },
      { key: 2, code: 'TAO', quantity: 3, isBomChild: true, bomGroupKey: 'g', bomEditable: true },
    ]
    expect(inferBomTypes(saved)[0].bomType).toBe('template')
  })
})
