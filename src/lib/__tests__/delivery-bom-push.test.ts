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
  it('Template: POST bỏ dòng con, PATCH áp SL con người dùng (giá 0, U_BOMID)', async () => {
    let read = 0
    m.sapGet.mockImplementation(async (_s: unknown, path: string) => {
      if (path.startsWith('/ProductTrees')) return { ok: true, data: { ProductTreeLines: [{ ItemCode: 'A' }, { ItemCode: 'B' }] } }
      read++
      // Sau bước 1: RAU, GIO, A, B (SAP bung) · sau bước 2: RAU, GIO, A, B
      return { ok: true, data: { DocumentLines: [
        { LineNum: 0, ItemCode: 'RAU' }, { LineNum: 1, ItemCode: 'GIO' },
        { LineNum: 2, ItemCode: 'A', ...(read > 1 ? { U_BOMID: 'GIO' } : {}) },
        { LineNum: 3, ItemCode: 'B', ...(read > 1 ? { U_BOMID: 'GIO' } : {}) },
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
    expect(m.sapPost.mock.calls[0][2].DocumentLines.map((l: { ItemCode: string }) => l.ItemCode)).toEqual(['RAU', 'GIO'])
    const [, path, patch] = m.sapPatch.mock.calls[0]
    expect(path).toBe('/DeliveryNotes(77)')
    expect(patch.DocumentLines).toEqual([
      { LineNum: 0 },
      { LineNum: 1 },
      expect.objectContaining({ LineNum: 2, Quantity: 6, UnitPrice: 0, U_BOMID: 'GIO' }),
      expect.objectContaining({ LineNum: 3, Quantity: 3, UnitPrice: 0, U_BOMID: 'GIO' }),
    ])
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
      return { ok: true, data: { DocumentLines: [{ LineNum: 0, ItemCode: 'GIO' }, { LineNum: 1, ItemCode: 'A' }] } }
    })
    const r = await pushDeliveryToSap({ ...base, localId: 'dl1', lines: tpl })
    expect(r).toMatchObject({ status: 'synced', docEntry: 55 })
    expect(m.sapPost).not.toHaveBeenCalled()
    expect(m.sapPatch.mock.calls[0][1]).toBe('/DeliveryNotes(55)')
  })
})
