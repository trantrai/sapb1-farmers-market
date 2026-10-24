// ============================================================
// Báo cáo đọc chứng từ từ SAP B1 (chỉ đọc):
// - mapSapArDocs bỏ chứng từ hủy / chứng từ hủy-ngược, bỏ dòng iIngredient
// - fetchSapArDocs: $filter/$select hẹp, thử lại không CancelStatus, khử trùng, cache, lỗi → ok:false
// - isOnSap: chứng từ local đã lên SAP bị loại khi gộp (không đếm trùng)
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sapGetAll = vi.fn()
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/sap-service-layer', () => ({
  sapGetAll: (...a: unknown[]) => sapGetAll(...a),
}))

import { clearSapArCache, fetchSapArDocs, isOnSap, mapSapArDocs } from '@/lib/sap-ar-report'

const cfg = { dbId: 'db1' } as never
const inv = (n: number, extra: Record<string, unknown> = {}) => ({
  DocEntry: n, DocNum: 1000 + n, CardCode: 'C1', CardName: 'KH A', DocDate: '2026-10-01T00:00:00Z',
  DocDueDate: '2026-10-31', DocTotal: 100, PaidToDate: 30, SalesPersonCode: 2, Cancelled: 'tNO', ...extra,
})

describe('mapSapArDocs', () => {
  it('map trường SAP, bỏ chứng từ hủy và chứng từ hủy-ngược', () => {
    const out = mapSapArDocs([
      inv(1),
      inv(2, { Cancelled: 'tYES' }),
      inv(3, { CancelStatus: 'csCancellation' }),
      inv(4, { SalesPersonCode: -1, DocDueDate: undefined }),
    ])
    expect(out.map((d) => d.docEntry)).toEqual([1, 4])
    expect(out[0]).toMatchObject({ docNum: 1001, docDate: '2026-10-01', docDueDate: '2026-10-31', docTotal: 100, paidToDate: 30, salesPersonCode: 2 })
    // NVBH -1 = "không có"; thiếu DocDueDate → dùng DocDate
    expect(out[1]).toMatchObject({ salesPersonCode: null, docDueDate: '2026-10-01' })
    expect(out[0].lines).toBeUndefined()
  })

  it('dòng hàng: bỏ thành phần iIngredient (đã tính trong dòng cha)', () => {
    const [d] = mapSapArDocs([inv(1, {
      DocumentLines: [
        { ItemCode: 'GIO', ItemDescription: 'Giỏ', Quantity: 2, LineTotal: 200, TreeType: 'iSalesTree' },
        { ItemCode: 'CAM', ItemDescription: 'Cam', Quantity: 4, LineTotal: 0, TreeType: 'iIngredient' },
        { ItemCode: 'TAO', ItemDescription: 'Táo', Quantity: 1, LineTotal: 50, TreeType: 'iNotATree' },
      ],
    })], true)
    expect(d.lines).toEqual([
      { itemCode: 'GIO', itemName: 'Giỏ', quantity: 2, lineTotal: 200 },
      { itemCode: 'TAO', itemName: 'Táo', quantity: 1, lineTotal: 50 },
    ])
  })
})

describe('fetchSapArDocs', () => {
  beforeEach(() => { sapGetAll.mockReset(); clearSapArCache() })

  it('lọc theo ngày + còn mở, $select hẹp, khử trùng DocEntry', async () => {
    sapGetAll.mockResolvedValue({ ok: true, data: [inv(1), inv(2), inv(1)] })
    const r = await fetchSapArDocs(cfg, 'Invoices', { from: '2026-10-01', to: '2026-10-31', openOnly: true })
    expect(r.ok && r.docs.map((d) => d.docEntry)).toEqual([1, 2])
    const [, path, q] = sapGetAll.mock.calls[0]
    expect(path).toBe('/Invoices')
    expect(q.$filter).toBe("Cancelled eq 'tNO' and DocDate ge '2026-10-01' and DocDate le '2026-10-31' and DocumentStatus eq 'bost_Open'")
    expect(q.$select).not.toContain('DocumentLines')
    expect(q.$select).toContain('PaidToDate')
  })

  it('bỏ qua ngày sai định dạng (không chèn chuỗi lạ vào $filter)', async () => {
    sapGetAll.mockResolvedValue({ ok: true, data: [] })
    await fetchSapArDocs(cfg, 'CreditNotes', { from: "2026-10-01' or 1 eq 1", withLines: true })
    const [, path, q] = sapGetAll.mock.calls[0]
    expect(path).toBe('/CreditNotes')
    expect(q.$filter).toBe("Cancelled eq 'tNO'")
    expect(q.$select).toContain('DocumentLines')
  })

  it('SL không nhận CancelStatus → thử lại không có field đó', async () => {
    sapGetAll
      .mockResolvedValueOnce({ ok: false, error: "Property 'CancelStatus' of 'Document' is invalid" })
      .mockResolvedValueOnce({ ok: true, data: [inv(5)] })
    const r = await fetchSapArDocs(cfg, 'Invoices')
    expect(r.ok).toBe(true)
    expect(sapGetAll).toHaveBeenCalledTimes(2)
    expect(sapGetAll.mock.calls[1][2].$select).not.toContain('CancelStatus')
  })

  it('lỗi kết nối → ok:false (route hiển thị số liệu local + cảnh báo), không cache', async () => {
    sapGetAll.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' })
    const r = await fetchSapArDocs(cfg, 'Invoices', { openOnly: true })
    expect(r).toEqual({ ok: false, error: 'ECONNREFUSED' })
    sapGetAll.mockResolvedValue({ ok: true, data: [inv(1)] })
    expect((await fetchSapArDocs(cfg, 'Invoices', { openOnly: true })).ok).toBe(true)
  })

  it('cache 60s theo DB + truy vấn', async () => {
    sapGetAll.mockResolvedValue({ ok: true, data: [inv(1)] })
    await fetchSapArDocs(cfg, 'Invoices', { openOnly: true })
    await fetchSapArDocs(cfg, 'Invoices', { openOnly: true })
    expect(sapGetAll).toHaveBeenCalledTimes(1)
    await fetchSapArDocs({ dbId: 'db2' } as never, 'Invoices', { openOnly: true })
    expect(sapGetAll).toHaveBeenCalledTimes(2)
  })
})

describe('isOnSap', () => {
  it('chỉ chứng từ đã đồng bộ và có DocEntry mới coi là đã có trên SAP', () => {
    expect(isOnSap({ sapSyncStatus: 'synced', sapDocEntry: 9 })).toBe(true)
    expect(isOnSap({ sapSyncStatus: 'pending', sapDocEntry: 9 })).toBe(false)
    expect(isOnSap({ sapSyncStatus: 'synced', sapDocEntry: null })).toBe(false)
    expect(isOnSap({ sapSyncStatus: 'none' })).toBe(false)
  })
})
