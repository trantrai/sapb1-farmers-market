// ============================================================
// Hoán đổi thành phần BOM Template (normalizeBomLines):
// - Template: thành phần ngoài công thức được chấp nhận nếu có trong danh mục
//   mặt hàng, không phải chính mặt hàng cha
// - Danh mục chưa đồng bộ → không đối chiếu được, cho qua
// - Production/Assembly: vẫn chặn thành phần ngoài công thức
// - Hoán đổi MỚI cần quyền bomSwap; dòng thay thế đã lưu thì giữ nguyên
// - Cha không có công thức BOM → chặn gắn dòng con mới (chống hàng giá 0)
// - Payload SAP: thành phần đã đổi đi với mã mới, U_BOMID = mã cha
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const findMany = vi.fn()
const count = vi.fn()
vi.mock('@/lib/db', () => ({ db: { item: { findMany: (...a: unknown[]) => findMany(...a), count: (...a: unknown[]) => count(...a) } } }))
vi.mock('@/lib/fm-bom', () => ({
  recalcChildQty: (pq: number, per: number) => Math.round(pq * per * 1000) / 1000,
  getBomDefinitions: async (_db: string | null, codes: string[]) => {
    const m = new Map()
    if (codes.includes('GIO')) m.set('GIO', { parentItemCode: 'GIO', bomType: 'template', components: [{ childItemCode: 'TAO', qtyPerParent: 3 }] })
    if (codes.includes('PROD')) m.set('PROD', { parentItemCode: 'PROD', bomType: 'production', components: [{ childItemCode: 'TAO', qtyPerParent: 1 }] })
    return m
  },
}))

import { normalizeBomLines, bomChildKey } from '@/lib/order-bom'
import { buildSapLines } from '@/lib/sap-push-document'

const SWAP = { allowSwap: true }
const line = (itemCode: string, extra: Record<string, unknown> = {}) => ({ itemCode, itemName: itemCode, uom: 'kg', quantity: 2, unitPrice: 0, ...extra })

beforeEach(() => {
  findMany.mockReset()
  count.mockReset()
})

describe('normalizeBomLines — hoán đổi thành phần BOM Template', () => {
  it('chấp nhận mặt hàng thay thế có trong danh mục', async () => {
    findMany.mockResolvedValue([{ itemCode: 'LE' }])
    const r = await normalizeBomLines('db1', [
      line('GIO', { quantity: 1, unitPrice: 500, bomGroupKey: 'g' }),
      line('LE', { isBomChild: true, bomGroupKey: 'g', bomEditable: true, quantity: 5 }),
    ], SWAP)
    expect(r.error).toBeUndefined()
    expect(r.lines[1]).toMatchObject({ itemCode: 'LE', quantity: 5, bomEditable: true })
  })

  it('chặn mặt hàng không có trong danh mục (khi danh mục đã đồng bộ)', async () => {
    findMany.mockResolvedValue([])
    count.mockResolvedValue(120)
    const r = await normalizeBomLines('db1', [
      line('GIO', { bomGroupKey: 'g' }),
      line('XYZ', { isBomChild: true, bomGroupKey: 'g', bomEditable: true }),
    ], SWAP)
    expect(r.error).toMatch(/XYZ không có trong danh mục/)
  })

  it('danh mục chưa đồng bộ → cho qua', async () => {
    findMany.mockResolvedValue([])
    count.mockResolvedValue(0)
    const r = await normalizeBomLines('db1', [
      line('GIO', { bomGroupKey: 'g' }),
      line('XYZ', { isBomChild: true, bomGroupKey: 'g', bomEditable: true }),
    ], SWAP)
    expect(r.error).toBeUndefined()
  })

  it('không cho dùng chính mặt hàng cha làm thành phần', async () => {
    findMany.mockResolvedValue([{ itemCode: 'GIO' }])
    const r = await normalizeBomLines('db1', [
      line('GIO', { bomGroupKey: 'g' }),
      line('GIO', { isBomChild: true, bomGroupKey: 'g', bomEditable: true }),
    ], SWAP)
    expect(r.error).toMatch(/chính mặt hàng GIO/)
  })

  it('Production vẫn chặn thành phần ngoài công thức', async () => {
    findMany.mockResolvedValue([{ itemCode: 'LE' }])
    const r = await normalizeBomLines('db1', [
      line('PROD', { quantity: 1, bomGroupKey: 'p' }),
      line('LE', { isBomChild: true, bomGroupKey: 'p', bomEditable: false, quantity: 1 }),
    ])
    expect(r.error).toMatch(/LE không thuộc công thức BOM của PROD/)
  })

  it('không có quyền bomSwap → chặn hoán đổi mới', async () => {
    findMany.mockResolvedValue([{ itemCode: 'LE' }])
    const r = await normalizeBomLines('db1', [
      line('GIO', { bomGroupKey: 'g' }),
      line('LE', { isBomChild: true, bomGroupKey: 'g', bomEditable: true }),
    ])
    expect(r.error).toMatch(/không có quyền hoán đổi/)
  })

  it('không có quyền nhưng dòng thay thế đã lưu từ trước → giữ nguyên khi sửa', async () => {
    findMany.mockResolvedValue([{ itemCode: 'LE' }])
    const r = await normalizeBomLines('db1', [
      line('GIO', { bomGroupKey: 'g' }),
      line('LE', { isBomChild: true, bomGroupKey: 'g', bomEditable: true }),
    ], { existingChildren: new Set([bomChildKey('g', 'LE')]) })
    expect(r.error).toBeUndefined()
  })

  it('thành phần đúng công thức không cần quyền hoán đổi', async () => {
    const r = await normalizeBomLines('db1', [
      line('GIO', { bomGroupKey: 'g' }),
      line('TAO', { isBomChild: true, bomGroupKey: 'g', bomEditable: true, quantity: 9 }),
    ])
    expect(r.error).toBeUndefined()
  })

  it('payload SAP: thành phần đã đổi đi với mã mới, SL người dùng, U_BOMID = mã cha', () => {
    const out = buildSapLines([
      { itemCode: 'GIO', quantity: 1, unitPrice: 500, isBomChild: false, bomGroupKey: 'g' },
      { itemCode: 'LE', quantity: 5, unitPrice: 0, isBomChild: true, bomGroupKey: 'g', bomEditable: true },
    ]) as Record<string, unknown>[]
    expect(out[0]).toMatchObject({ ItemCode: 'GIO', TreeType: 'iNotATree' })
    expect(out[1]).toMatchObject({ ItemCode: 'LE', Quantity: 5, UnitPrice: 0, U_BOMID: 'GIO' })
  })
})

describe('normalizeBomLines — cha không có công thức BOM (chống gắn hàng giá 0)', () => {
  it('mặt hàng thường + dòng con mới → chặn', async () => {
    const r = await normalizeBomLines('db1', [
      line('THUONG', { quantity: 1, unitPrice: 1000, bomGroupKey: 'x' }),
      line('DAT-TIEN', { isBomChild: true, bomGroupKey: 'x', bomEditable: true }),
    ], SWAP)
    expect(r.error).toMatch(/THUONG không phải BOM/)
  })

  it('BOM bị xóa khỏi mirror sau khi lập chứng từ → dòng con đã lưu vẫn sửa được', async () => {
    const r = await normalizeBomLines('db1', [
      line('THUONG', { quantity: 1, bomGroupKey: 'x' }),
      line('TAO', { isBomChild: true, bomGroupKey: 'x', bomEditable: true }),
    ], { existingChildren: new Set([bomChildKey('x', 'TAO')]) })
    expect(r.error).toBeUndefined()
  })

  it('… nhưng không được gắn thêm dòng con mới vào nhóm đó', async () => {
    const r = await normalizeBomLines('db1', [
      line('THUONG', { quantity: 1, bomGroupKey: 'x' }),
      line('TAO', { isBomChild: true, bomGroupKey: 'x', bomEditable: true }),
      line('CAM', { isBomChild: true, bomGroupKey: 'x', bomEditable: true }),
    ], { existingChildren: new Set([bomChildKey('x', 'TAO')]) })
    expect(r.error).toMatch(/không thể gắn thành phần CAM/)
  })
})
