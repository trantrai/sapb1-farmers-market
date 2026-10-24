// ============================================================
// Xem chi tiết chứng từ bán hàng đọc trực tiếp từ SAP (hóa đơn, trả hàng…):
// - fetchSapDocDetail đọc đúng entity set (không cứng /Orders), map dòng + U_BOMID
// - attachSapBomGroups dựng lại nhóm BOM Template theo U_BOMID, xếp con dưới cha
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sapGet = vi.fn()
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/sap-service-layer', () => ({
  sapGet: (...a: unknown[]) => sapGet(...a),
  sapGetAll: vi.fn(async () => ({ ok: false, error: 'x' })),
}))
vi.mock('@/lib/fm-items', () => ({ vatRateMap: async () => ({ S8: 8 }) }))

import { fetchSapDocDetail } from '@/lib/sap-orders'
import { attachSapBomGroups } from '@/lib/sap-doc-bom'

const CB = 'CB-202610-0001'

describe('fetchSapDocDetail', () => {
  beforeEach(() => sapGet.mockReset())

  it('đọc /Invoices(N) và giữ U_BOMID của dòng', async () => {
    sapGet.mockResolvedValue({
      ok: true,
      data: {
        DocEntry: 55, DocNum: 9001, CardCode: 'C1', CardName: 'KH A', DocDate: '2026-10-20', DocDueDate: '2026-10-30',
        DocumentStatus: 'bost_Open', DocTotal: 648000, VatSum: 48000,
        DocumentLines: [
          { LineNum: 0, ItemCode: CB, ItemDescription: 'Giỏ', Quantity: 2, Price: 300000, VatGroup: 'S8' },
          { LineNum: 1, ItemCode: 'N0000148', Quantity: 2, Price: 0, VatGroup: 'S8', U_BOMID: CB },
        ],
      },
    })
    const r = await fetchSapDocDetail({} as never, 'Invoices', 55, 'hóa đơn')
    expect(sapGet.mock.calls[0][1]).toBe('/Invoices(55)')
    expect(r.ok).toBe(true)
    expect(r.order).toMatchObject({ id: 'sap-55', docNum: 9001, status: 'Open', source: 'sap' })
    expect(r.order?.lines.map((l) => [l.itemCode, l.bomId])).toEqual([[CB, null], ['N0000148', CB]])
  })

  it('lỗi cả 3 bước → thông báo theo tên chứng từ', async () => {
    sapGet.mockResolvedValue({ ok: false, error: 'HTTP 404' })
    const r = await fetchSapDocDetail({} as never, 'Returns', 7, 'phiếu trả hàng')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/chi tiết phiếu trả hàng từ SAP B1/)
  })
})

describe('attachSapBomGroups', () => {
  const l = (lineNum: number, itemCode: string, bomId: string | null = null) => ({ lineNum, itemCode, bomId })

  it('dòng con theo U_BOMID gắn vào cha gần nhất phía trên; con nằm cuối được xếp lại dưới cha', () => {
    const out = attachSapBomGroups([l(0, 'RAU'), l(1, CB), l(2, 'N0000148', CB), l(3, 'TAO'), l(4, 'X-999', CB)])
    expect(out.map((x) => `${x.itemCode}:${x.isBomChild ? 'c' : 'p'}:${x.bomGroupKey ?? '-'}`)).toEqual([
      'RAU:p:-', `${CB}:p:bom-1`, 'N0000148:c:bom-1', 'X-999:c:bom-1', 'TAO:p:-',
    ])
  })

  it('2 nhóm cùng mã cha → mỗi con theo cha gần nhất; U_BOMID không có cha → giữ dòng thường', () => {
    const out = attachSapBomGroups([l(0, CB), l(1, 'A', CB), l(2, CB), l(3, 'B', CB), l(4, 'Z', 'KHONG-CO')])
    expect(out.map((x) => `${x.itemCode}:${x.bomGroupKey ?? '-'}:${x.isBomChild}`)).toEqual([
      `${CB}:bom-0:false`, 'A:bom-0:true', `${CB}:bom-2:false`, 'B:bom-2:true', 'Z:-:false',
    ])
  })
})
