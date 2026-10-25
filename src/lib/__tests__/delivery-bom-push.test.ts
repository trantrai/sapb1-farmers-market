// ============================================================
// Phiếu giao hàng có BOM → SAP: POST chỉ dòng cha + hàng thường; nhóm
// Template áp dòng con người dùng ở bước 2 (PATCH) giống đơn hàng.
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ sapPost: vi.fn(), sapGet: vi.fn(), sapPatch: vi.fn() }))

vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/sap-service-layer', async (orig) => ({
  ...(await orig<typeof import('@/lib/sap-service-layer')>()),
  loadSapSettings: async () => ({ serviceLayerUrl: 'https://sl', companyDb: 'DB', sapUser: 'u', sapPassword: 'p' }),
  isSapConfigured: () => true,
  sapPost: (...a: unknown[]) => m.sapPost(...a),
  sapGet: (...a: unknown[]) => m.sapGet(...a),
  sapPatch: (...a: unknown[]) => m.sapPatch(...a),
}))

import { pushDeliveryToSap } from '@/lib/sap-push-delivery'

const base = { cardCode: 'C1', docDate: '2026-10-24' }
const line = (itemCode: string, quantity: number, extra: Record<string, unknown> = {}) => ({ itemCode, quantity, unitPrice: 0, ...extra })

beforeEach(() => {
  m.sapPost.mockReset().mockResolvedValue({ ok: true, status: 201, data: { DocEntry: 77, DocNum: 7 } })
  m.sapPatch.mockReset().mockResolvedValue({ ok: true, status: 204 })
  m.sapGet.mockReset()
})

describe('pushDeliveryToSap — BOM', () => {
  it('Template: POST gửi cả cha + con người dùng (giá 0, U_BOMID), PATCH chỉ xoá khối SAP bung', async () => {
    let read = 0
    m.sapGet.mockImplementation(async (_s: unknown, path: string) => {
      if (path.startsWith('/ProductTrees')) return { ok: true, data: { ProductTreeLines: [{ ItemCode: 'A' }, { ItemCode: 'B' }] } }
      read++
      // Sau bước 1: RAU, GIO, A, B (SAP bung), A, B (người dùng) · sau bước 2: RAU, GIO, A, B (người dùng)
      const user = [{ LineNum: 4, ItemCode: 'A', U_BOMID: 'GIO' }, { LineNum: 5, ItemCode: 'B', U_BOMID: 'GIO' }]
      return { ok: true, data: { DocumentLines: [
        { LineNum: 0, ItemCode: 'RAU' }, { LineNum: 1, ItemCode: 'GIO' },
        ...(read > 1 ? [] : [{ LineNum: 2, ItemCode: 'A' }, { LineNum: 3, ItemCode: 'B' }]),
        ...user,
      ] } }
    })
    const r = await pushDeliveryToSap({
      ...base,
      lines: [
        line('RAU', 1, { unitPrice: 1000 }),
        line('GIO', 2, { unitPrice: 5000, bomGroupKey: 'g1' }),
        line('A', 6, { isBomChild: true, bomGroupKey: 'g1', bomEditable: true }),
        line('B', 3, { isBomChild: true, bomGroupKey: 'g1', bomEditable: true }),
      ],
    })
    expect(r).toMatchObject({ status: 'synced', docEntry: 77, docNum: 7 })
    const posted = m.sapPost.mock.calls[0][2].DocumentLines
    expect(posted.map((l: { ItemCode: string }) => l.ItemCode)).toEqual(['RAU', 'GIO', 'A', 'B'])
    expect(posted[1]).toMatchObject({ UnitPrice: 5000 })
    expect(posted[1].U_BOMID).toBeUndefined()
    expect(posted[2]).toMatchObject({ Quantity: 6, UnitPrice: 0, DiscountPercent: 0, U_BOMID: 'GIO' })
    expect(posted[3]).toMatchObject({ Quantity: 3, UnitPrice: 0, DiscountPercent: 0, U_BOMID: 'GIO' })
    const [, path, patch] = m.sapPatch.mock.calls[0]
    expect(path).toBe('/DeliveryNotes(77)')
    expect(patch.DocumentLines).toEqual([{ LineNum: 0 }, { LineNum: 1 }, { LineNum: 4 }, { LineNum: 5 }])
  })

  it('Production/Assembly: chỉ POST dòng cha, không PATCH', async () => {
    const r = await pushDeliveryToSap({
      ...base,
      lines: [
        line('KIT', 1, { bomGroupKey: 'g2' }),
        line('K1', 2, { isBomChild: true, bomGroupKey: 'g2', bomEditable: false }),
      ],
    })
    expect(r.status).toBe('synced')
    expect(m.sapPost.mock.calls[0][2].DocumentLines.map((l: { ItemCode: string }) => l.ItemCode)).toEqual(['KIT'])
    expect(m.sapPatch).not.toHaveBeenCalled()
    expect(m.sapGet).not.toHaveBeenCalled()
  })

  const tpl = [line('GIO', 1, { bomGroupKey: 'g1' }), line('A', 3, { isBomChild: true, bomGroupKey: 'g1' })]
  const failTrees = (udf: boolean) => m.sapGet.mockImplementation(async (_s: unknown, path: string) =>
    path === '/DeliveryNotes' ? (udf ? { ok: true, data: { value: [] } } : { ok: false, error: 'Invalid UDF' }) : { ok: false, status: 404, error: 'not found' })

  it('bước 2 lỗi, có UDF marker → pending (đẩy lại nhận chứng từ cũ, áp tiếp)', async () => {
    failTrees(true)
    const r = await pushDeliveryToSap({ ...base, localId: 'dl1', lines: tpl })
    expect(r.status).toBe('pending')
    expect(r.error).toMatch(/GIO/)
  })

  it('bước 2 lỗi, không có UDF → synced + cảnh báo (tránh tạo trùng khi đẩy lại)', async () => {
    failTrees(false)
    const r = await pushDeliveryToSap({ ...base, localId: 'dl1', lines: tpl })
    expect(r).toMatchObject({ status: 'synced', docEntry: 77 })
    expect(r.error).toMatch(/sửa trực tiếp trên SAP/)
  })

  it('đã có trên SAP (UDF) → không POST lại, áp tiếp bước 2', async () => {
    m.sapGet.mockImplementation(async (_s: unknown, path: string) => {
      if (path === '/DeliveryNotes') return { ok: true, data: { value: [{ DocEntry: 55, DocNum: 5 }] } }
      if (path.startsWith('/ProductTrees')) return { ok: true, data: { ProductTreeLines: [{ ItemCode: 'A' }] } }
      return { ok: true, data: { DocumentLines: [{ LineNum: 0, ItemCode: 'GIO' }, { LineNum: 1, ItemCode: 'A' }, { LineNum: 2, ItemCode: 'A', U_BOMID: 'GIO' }] } }
    })
    const r = await pushDeliveryToSap({ ...base, localId: 'dl1', lines: tpl })
    expect(r).toMatchObject({ status: 'synced', docEntry: 55 })
    expect(m.sapPost).not.toHaveBeenCalled()
    expect(m.sapPatch.mock.calls[0][1]).toBe('/DeliveryNotes(55)')
    expect(m.sapPatch.mock.calls[0][2]).toEqual({ DocumentLines: [{ LineNum: 0 }, { LineNum: 2 }] })
  })
})
