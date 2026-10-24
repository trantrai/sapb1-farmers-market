import { describe, expect, it } from 'vitest'
import { bomFieldsOf, childQtyFor, isSapDeliveryLine, normalizeDeliveryBom, pickWithBomChildren } from '../delivery-bom'

describe('delivery-bom', () => {
  it('childQtyFor rounds to 3 decimals', () => {
    expect(childQtyFor(3, 0.3333)).toBe(1)
    expect(childQtyFor(2, 1.5)).toBe(3)
    expect(childQtyFor(Number.NaN, 2)).toBe(0)
  })

  it('bomFieldsOf coerces body values', () => {
    expect(bomFieldsOf({ isBomChild: true, bomGroupKey: '  ' })).toEqual({
      isBomChild: false, bomGroupKey: null, bomEditable: true, bomQtyPerParent: null,
    })
    expect(bomFieldsOf({ isBomChild: true, bomGroupKey: 'g1', bomEditable: false, bomQtyPerParent: 2 })).toEqual({
      isBomChild: true, bomGroupKey: 'g1', bomEditable: false, bomQtyPerParent: 2,
    })
    expect(bomFieldsOf({ bomQtyPerParent: -1 }).bomQtyPerParent).toBeNull()
    expect(bomFieldsOf(null).isBomChild).toBe(false)
  })

  it('normalizeDeliveryBom recomputes child qty and drops orphans', () => {
    const out = normalizeDeliveryBom([
      { code: 'P', quantity: 4, bomGroupKey: 'g1' },
      { code: 'C1', quantity: 999, isBomChild: true, bomGroupKey: 'g1', bomQtyPerParent: 0.5 },
      { code: 'ORPHAN', quantity: 2, isBomChild: true, bomGroupKey: 'gX', bomQtyPerParent: 1 },
      { code: 'LONE', quantity: 1, bomGroupKey: 'g2' },
    ])
    expect(out.map((l) => [l.code, l.quantity, l.isBomChild, l.bomGroupKey])).toEqual([
      ['P', 4, false, 'g1'],
      ['C1', 2, true, 'g1'],
      ['ORPHAN', 2, false, null],
      ['LONE', 1, false, null],
    ])
  })

  it('isSapDeliveryLine excludes BOM children', () => {
    expect(isSapDeliveryLine({ isBomChild: true })).toBe(false)
    expect(isSapDeliveryLine({ bomGroupKey: 'g1' })).toBe(true)
  })

  it('pickWithBomChildren attaches children of picked parents in source order', () => {
    const all = [
      { id: 'p', quantity: 10, bomGroupKey: 'g1' },
      { id: 'c1', quantity: 25, isBomChild: true, bomGroupKey: 'g1', bomQtyPerParent: 2 }, // Template đã sửa SL
      { id: 'c2', quantity: 5, isBomChild: true, bomGroupKey: 'g1' },
      { id: 'n', quantity: 3 },
      { id: 'q', quantity: 1, bomGroupKey: 'g2' },
      { id: 'c3', quantity: 1, isBomChild: true, bomGroupKey: 'g2', bomQtyPerParent: 1 },
    ]
    const out = pickWithBomChildren(all, [
      { line: all[3], qty: 3 },
      { line: all[0], qty: 4 },
      { line: all[1], qty: 99 }, // con chọn trực tiếp → bỏ qua
    ])
    expect(out.map((x) => [x.line.id, x.qty, x.bomQtyPerParent])).toEqual([
      ['p', 4, null],
      ['c1', 10, 2.5],
      ['c2', 2, 0.5],
      ['n', 3, null],
    ])
  })
})
