// ============================================================
// Copy-from SAP B1 — các lỗi đã sửa:
// - Bug 3: phiếu giao lập từ đơn hàng CHỈ có trên SAP (dòng nguồn id `sap-<LineNum>`)
//   → BaseType 17 / BaseEntry = sapSourceDocEntry / BaseLine = LineNum, không tra DB
// - Bug 2: BaseLine suy từ lineNum local phải trừ 1 (SAP đếm LineNum từ 0)
// - Bug 1: đơn hàng sao chép từ báo giá — sourceLineId chỉ hợp lệ khi là dòng
//   báo giá thật, cùng khách hàng, cùng mã hàng
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  sapPost: vi.fn(),
  qlFindMany: vi.fn(),
  findUnique: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    quotationLine: { findMany: (...a: unknown[]) => m.qlFindMany(...a), findUnique: (...a: unknown[]) => m.findUnique(...a) },
    salesOrderLine: { findUnique: (...a: unknown[]) => m.findUnique(...a) },
    salesOrder: { findUnique: (...a: unknown[]) => m.findUnique(...a) },
    quotation: { findUnique: (...a: unknown[]) => m.findUnique(...a) },
  },
}))
vi.mock('@/lib/sap-service-layer', async (orig) => ({
  ...(await orig<typeof import('@/lib/sap-service-layer')>()),
  loadSapSettings: async () => ({ serviceLayerUrl: 'https://sl', companyDb: 'DB', sapUser: 'u', sapPassword: 'p' }),
  isSapConfigured: () => true,
  sapPost: (...a: unknown[]) => m.sapPost(...a),
}))

import { pushDeliveryToSap } from '@/lib/sap-push-delivery'
import { localLineToSapLineNum } from '@/lib/sap-push-document'
import { checkOrderSourceLines } from '@/app/api/orders/route'

beforeEach(() => {
  m.sapPost.mockReset().mockResolvedValue({ ok: true, status: 201, data: { DocEntry: 900, DocNum: 9 } })
  m.qlFindMany.mockReset()
  m.findUnique.mockReset()
})

const dlLine = (extra: Record<string, unknown>) => ({ itemCode: 'A', quantity: 1, unitPrice: 1000, ...extra })

describe('Bug 3 — phiếu giao từ đơn hàng chỉ có trên SAP', () => {
  it('dòng `sap-<LineNum>` → BaseType 17, BaseEntry = sapSourceDocEntry, BaseLine = LineNum (không tra DB)', async () => {
    const r = await pushDeliveryToSap({
      cardCode: 'C1', docDate: '2026-10-23', sapSourceDocEntry: 4321,
      lines: [dlLine({ sourceOrderLineId: 'sap-0' }), dlLine({ itemCode: 'B', sourceOrderLineId: 'sap-2' })],
    })
    expect(r.status).toBe('synced')
    expect(m.findUnique).not.toHaveBeenCalled()
    const [, path, payload] = m.sapPost.mock.calls[0]
    expect(path).toBe('/DeliveryNotes')
    expect(payload.DocumentLines[0]).toMatchObject({ ItemCode: 'A', BaseType: 17, BaseEntry: 4321, BaseLine: 0 })
    expect(payload.DocumentLines[1]).toMatchObject({ ItemCode: 'B', BaseType: 17, BaseEntry: 4321, BaseLine: 2 })
  })

  it('thiếu sapSourceDocEntry → chặn đẩy với lỗi rõ ràng', async () => {
    const r = await pushDeliveryToSap({ cardCode: 'C1', docDate: '2026-10-23', lines: [dlLine({ sourceOrderLineId: 'sap-1' })] })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/sapSourceDocEntry/)
    expect(m.sapPost).not.toHaveBeenCalled()
  })

  it('dòng đơn hàng local vẫn tra DB như cũ (BaseLine = sapLineNum)', async () => {
    m.findUnique
      .mockResolvedValueOnce({ id: 'sol1', orderId: 'so1', lineNum: 2, sapLineNum: 1 })
      .mockResolvedValueOnce({ sapDocEntry: 55, docNum: 7 })
    await pushDeliveryToSap({ cardCode: 'C1', docDate: '2026-10-23', lines: [dlLine({ sourceOrderLineId: 'sol1' })] })
    expect(m.sapPost.mock.calls[0][2].DocumentLines[0]).toMatchObject({ BaseType: 17, BaseEntry: 55, BaseLine: 1 })
  })
})

describe('Bug 2 — quy đổi lineNum local → LineNum SAP', () => {
  it('đếm từ 1 → đếm từ 0, không âm', () => {
    expect(localLineToSapLineNum(1)).toBe(0)
    expect(localLineToSapLineNum(5)).toBe(4)
    expect(localLineToSapLineNum(0)).toBe(0)
  })
})

describe('Bug 1 — checkOrderSourceLines (đơn hàng sao chép từ báo giá)', () => {
  const src = (id: string, itemCode: string, cardCode = 'C1') => ({ id, itemCode, quotation: { cardCode, docNum: 3001 } })

  it('dòng báo giá hợp lệ → giữ sourceLineId; dòng không có nguồn → null', async () => {
    m.qlFindMany.mockResolvedValue([src('ql1', 'A')])
    const r = await checkOrderSourceLines([{ itemCode: 'A', sourceLineId: 'ql1' }, { itemCode: 'B' }], 'C1')
    expect(r).toEqual({ ids: ['ql1', null] })
  })

  it('không có dòng nào mang nguồn → không query DB', async () => {
    const r = await checkOrderSourceLines([{ itemCode: 'A', sourceLineId: '' }], 'C1')
    expect(r).toEqual({ ids: [null] })
    expect(m.qlFindMany).not.toHaveBeenCalled()
  })

  it('id không tồn tại → lỗi', async () => {
    m.qlFindMany.mockResolvedValue([])
    const r = await checkOrderSourceLines([{ itemCode: 'A', sourceLineId: 'xx' }], 'C1')
    expect(r.error).toMatch(/không tìm thấy dòng báo giá nguồn/)
  })

  it('báo giá của khách hàng khác → lỗi', async () => {
    m.qlFindMany.mockResolvedValue([src('ql1', 'A', 'C9')])
    const r = await checkOrderSourceLines([{ itemCode: 'A', sourceLineId: 'ql1' }], 'C1')
    expect(r.error).toMatch(/thuộc khách hàng khác/)
  })

  it('khác mã hàng với dòng nguồn → lỗi', async () => {
    m.qlFindMany.mockResolvedValue([src('ql1', 'A')])
    const r = await checkOrderSourceLines([{ itemCode: 'B', sourceLineId: 'ql1' }], 'C1')
    expect(r.error).toMatch(/khác mã hàng/)
  })
})
