// Test applier Sprint 3 (F6/F13) với IO giả — không chạm Service Layer thật
import { describe, expect, it } from 'vitest'
import {
  applyParents,
  rollbackCreated,
  buildItemBody,
  buildTreeBody,
  odataKey,
  type BomB1IO,
  type ApplyParentInput,
} from '../applier'
import type { CanonicalParent } from '../canonical'
import type { SapCallResult } from '../../sap-service-layer'

function parent(partial: Partial<CanonicalParent> = {}): CanonicalParent {
  return {
    rowNo: 7,
    itemCode: null,
    itemName: 'PHẦN QUÀ TEST',
    itemNameEn: 'TEST GIFT',
    itemTypeLetter: 'M',
    bomKind: 'BOM_PRODUCT',
    bomKindRaw: 'BOM',
    barcode: { trade: null, internal8: null, internalI: null },
    primaryBarcode: '8931234567890',
    categoryLevel7: null,
    uom: { purchase: 'Phần', sales: 'Phần', inventory: 'Phần' },
    warehouse: 'KHO01',
    taxIn: 'P2',
    taxOut: 'S2',
    priceIncVat: 1100,
    priceExVat: 1000,
    priceCheckQ: null,
    priceCheckS: null,
    supplier: { name: 'NCC A', code: 'V001' },
    batchQty: 1,
    components: [
      {
        rowNo: 8,
        sortOrder: 0,
        childCode: 'NVL001',
        childName: 'Nguyên liệu 1',
        uom: 'Cái',
        qtyRaw: 2,
        qtyPerParent: 2,
        note: null,
      },
    ],
    mdChecks: {
      costTotal: null,
      marginPct: null,
      systemCost: null,
      costDelta: null,
      uomMismatch: [],
      duplicateNameHit: false,
    },
    ...partial,
  }
}

function input(partial: Partial<ApplyParentInput> = {}): ApplyParentInput {
  return { rowNo: 7, code: 'BOM-001', parent: parent(), ...partial }
}

/** Fake IO: bảng items/trees tồn tại + ghi nhận calls */
function fakeIO(opts: { items?: Set<string>; trees?: Set<string>; failPost?: RegExp } = {}): {
  io: BomB1IO
  calls: { method: string; path: string; body?: unknown }[]
} {
  const items = opts.items ?? new Set<string>()
  const trees = opts.trees ?? new Set<string>()
  const calls: { method: string; path: string; body?: unknown }[] = []
  const ok = (data?: unknown): SapCallResult => ({ ok: true, status: 200, data })
  const notFound = (): SapCallResult => ({ ok: false, status: 404, error: 'Not found' })
  const io: BomB1IO = {
    get: async (path) => {
      calls.push({ method: 'GET', path })
      const m = /\('(.*)'\)/.exec(path)
      const code = m?.[1] ?? ''
      if (path.startsWith('/Items')) return items.has(code) ? ok({ ItemCode: code }) : notFound()
      if (path.startsWith('/ProductTrees')) return trees.has(code) ? ok({ TreeCode: code }) : notFound()
      return notFound()
    },
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      if (opts.failPost?.test(path)) return { ok: false, status: 500, error: 'B1 lỗi giả lập' }
      const b = body as { ItemCode?: string; TreeCode?: string }
      if (path === '/Items' && b.ItemCode) items.add(b.ItemCode)
      if (path === '/ProductTrees' && b.TreeCode) trees.add(b.TreeCode)
      return ok({})
    },
    del: async (path) => {
      calls.push({ method: 'DELETE', path })
      const m = /\('(.*)'\)/.exec(path)
      const code = m?.[1] ?? ''
      if (path.startsWith('/Items')) {
        if (!items.delete(code)) return notFound()
        return { ok: true, status: 204 }
      }
      if (path.startsWith('/ProductTrees')) {
        if (!trees.delete(code)) return notFound()
        return { ok: true, status: 204 }
      }
      return notFound()
    },
  }
  return { io, calls }
}

describe('odataKey', () => {
  it("escape dấu nháy đơn cho OData key", () => {
    expect(odataKey("A'B")).toBe("A''B")
  })
})

describe('buildItemBody', () => {
  it('map đúng các trường theo quyết định đã chốt', () => {
    const b = buildItemBody('BOM-001', parent())
    expect(b).toMatchObject({
      ItemCode: 'BOM-001',
      ItemName: 'PHẦN QUÀ TEST',
      ForeignName: 'TEST GIFT',
      BarCode: '8931234567890', // Q2b: chỉ barcode chính
      SalesUnit: 'Phần',
      Mainsupplier: 'V001', // Q8
    })
    // Q5: giá trước VAT vào Price List 1
    expect(b.ItemPrices).toEqual([{ PriceList: 1, Price: 1000 }])
    expect(b).not.toHaveProperty('ItemsGroupCode') // Q4: Sprint 4
  })
})

describe('buildTreeBody', () => {
  it('BOM_PRODUCT → iProductionTree, Quantity=1', () => {
    const b = buildTreeBody('BOM-001', parent({ bomKind: 'BOM_PRODUCT' }))
    expect(b).toMatchObject({ TreeCode: 'BOM-001', TreeType: 'iProductionTree', Quantity: 1 })
    const lines = b.ProductTreeLines as { ItemCode: string; Quantity: number; Warehouse: string }[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ ItemCode: 'NVL001', Quantity: 2, Warehouse: 'KHO01' })
  })

  it('BOM_ASSEMBLY (COMBO) → iAssemblyTree (Q6)', () => {
    const b = buildTreeBody('CB-001', parent({ bomKind: 'BOM_ASSEMBLY' }))
    expect(b.TreeType).toBe('iAssemblyTree')
  })

  it('bomKind null → lỗi rõ ràng', () => {
    expect(() => buildTreeBody('X', parent({ bomKind: null }))).toThrow(/bomKind/)
  })
})

describe('applyParents', () => {
  it('tạo mới item + tree khi chưa tồn tại', async () => {
    const { io, calls } = fakeIO({ items: new Set(['NVL001']) })
    const r = await applyParents(io, 'run1', [input()])
    expect(r.failed).toBe(0)
    expect(r.results[0]).toMatchObject({ item: 'created', tree: 'created' })
    expect(r.createdKeys).toEqual([
      { type: 'tree', code: 'BOM-001' },
      { type: 'item', code: 'BOM-001' },
    ])
    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path)
    expect(posts).toEqual(['/Items', '/ProductTrees'])
  })

  it('idempotent: chạy lại không POST trùng', async () => {
    const { io, calls } = fakeIO({ items: new Set(['NVL001', 'BOM-001']), trees: new Set(['BOM-001']) })
    const r = await applyParents(io, 'run1', [input()])
    expect(r.results[0]).toMatchObject({ item: 'exists', tree: 'exists' })
    expect(r.createdKeys).toEqual([])
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('V4 fail-fast: mã con thiếu → dừng cả đợt, không tạo tree', async () => {
    const { io } = fakeIO({ items: new Set() }) // NVL001 không tồn tại
    const r = await applyParents(io, 'run1', [
      input(),
      input({ rowNo: 18, code: 'BOM-002', parent: parent({ rowNo: 18 }) }),
    ])
    expect(r.failed).toBe(1)
    expect(r.results).toHaveLength(1) // dừng ở cha đầu
    expect(r.results[0].tree).toBe('skipped')
    expect(r.results[0].error).toMatch(/NVL001/)
    // Item cha đã tạo trước khi V4 fail → nằm trong createdKeys để rollback
    expect(r.createdKeys).toEqual([{ type: 'item', code: 'BOM-001' }])
  })

  it('lỗi POST item → failed, không tạo tree', async () => {
    const { io } = fakeIO({ failPost: /^\/Items$/ })
    const r = await applyParents(io, 'run1', [input()])
    expect(r.results[0]).toMatchObject({ item: 'failed', tree: 'skipped' })
    expect(r.createdKeys).toEqual([])
  })
})

describe('rollbackCreated', () => {
  it('xóa tree trước item, 404 coi như đã sạch', async () => {
    const { io, calls } = fakeIO({ items: new Set(['BOM-001']), trees: new Set(['BOM-001']) })
    const r = await rollbackCreated(io, 'run1', [
      { type: 'tree', code: 'BOM-001' },
      { type: 'item', code: 'BOM-001' },
    ])
    expect(r.failed).toHaveLength(0)
    expect(r.deleted).toHaveLength(2)
    const dels = calls.filter((c) => c.method === 'DELETE').map((c) => c.path)
    expect(dels[0]).toContain('/ProductTrees')
    expect(dels[1]).toContain('/Items')
  })

  it('key đã xóa tay (404) vẫn tính là xong', async () => {
    const { io } = fakeIO()
    const r = await rollbackCreated(io, 'run1', [{ type: 'item', code: 'GONE' }])
    expect(r.deleted).toHaveLength(1)
    expect(r.failed).toHaveLength(0)
  })
})

