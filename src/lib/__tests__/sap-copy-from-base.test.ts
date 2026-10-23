// ============================================================
// Test copy-from → BaseType/BaseEntry/BaseLine khi đẩy sang SAP B1:
// - buildSapLines / buildSapDocPayload: gắn Base* đúng dòng, tương thích
//   ngược khi không có base (không gắn gì thêm)
// - resolveCopyFromBases / resolveSourceLineBase: tra DB (mock) → base
//   đúng ma trận BaseType; nguồn chưa synced → ok:false + lỗi rõ ràng
// ============================================================
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock DB trước khi import module cần test (vi.hoisted chạy trước imports)
const mocks = vi.hoisted(() => {
  const findUniqueMocks: Record<string, ReturnType<typeof vi.fn>> = {}
  return { findUniqueMocks }
})

vi.mock('@/lib/db', () => {
  const delegates = [
    'quotationLine',
    'salesOrderLine',
    'deliveryLine',
    'arInvoiceLine',
    'salesReturnLine',
    'quotation',
    'salesOrder',
    'delivery',
    'arInvoice',
    'salesReturn',
  ]
  const db: Record<string, unknown> = {}
  for (const d of delegates) {
    const fn = vi.fn()
    mocks.findUniqueMocks[d] = fn
    db[d] = { findUnique: fn }
  }
  return { db }
})

import {
  buildSapLines,
  buildSapDocPayload,
  resolveCopyFromBases,
  resolveSourceLineBase,
  getSourceLineSpec,
} from '@/lib/sap-push-document'

const fu = () => mocks.findUniqueMocks

beforeEach(() => {
  for (const m of Object.values(fu())) m.mockReset()
})

describe('buildSapLines — BaseType/BaseEntry/BaseLine', () => {
  const line = { itemCode: 'FM-RAU-001', quantity: 10, unitPrice: 20000 }

  it('không có bases → không gắn Base* (tương thích ngược)', () => {
    const [l] = buildSapLines([line]) as any[]
    expect(l).not.toHaveProperty('BaseType')
    expect(l).not.toHaveProperty('BaseEntry')
    expect(l).not.toHaveProperty('BaseLine')
    expect(l).toMatchObject({ ItemCode: 'FM-RAU-001', Quantity: 10, UnitPrice: 20000 })
  })

  it('có bases → gắn Base* đúng từng dòng, dòng độc lập giữ nguyên', () => {
    const [a, b] = buildSapLines([line, { ...line, itemCode: 'FM-THIT-002' }], undefined, [
      { baseType: 17, baseEntry: 101, baseLine: 0 },
      null,
    ]) as any[]
    expect(a).toMatchObject({ BaseType: 17, BaseEntry: 101, BaseLine: 0 })
    expect(b).not.toHaveProperty('BaseType')
    expect(b).not.toHaveProperty('BaseEntry')
    expect(b).not.toHaveProperty('BaseLine')
  })

  it('PATCH: giữ LineNum cũ và gắn thêm Base*', () => {
    const [l] = buildSapLines([line], [5], [{ baseType: 23, baseEntry: 7, baseLine: 2 }]) as any[]
    expect(l).toMatchObject({ LineNum: 5, BaseType: 23, BaseEntry: 7, BaseLine: 2 })
  })
})

describe('buildSapDocPayload — lineBases', () => {
  const baseInput = {
    cardCode: 'C20001',
    docDate: '2026-10-17',
    docDueDate: '2026-10-24',
    lines: [{ itemCode: 'FM-RAU-001', quantity: 1, unitPrice: 1000 }],
  }

  it('không truyền lineBases → DocumentLines không có Base* (tương thích ngược)', () => {
    const p = buildSapDocPayload(baseInput) as any
    expect(p.DocumentLines[0]).not.toHaveProperty('BaseType')
  })

  it('truyền lineBases → DocumentLines mang Base*', () => {
    const p = buildSapDocPayload(baseInput, false, [{ baseType: 15, baseEntry: 55, baseLine: 1 }]) as any
    expect(p.DocumentLines[0]).toMatchObject({ BaseType: 15, BaseEntry: 55, BaseLine: 1 })
  })
})

describe('resolveCopyFromBases', () => {
  it('dòng không có sourceLineId → base null, không query DB', async () => {
    const r = await resolveCopyFromBases('Invoices', [{ sourceLineId: null }, {}])
    expect(r).toEqual({ ok: true, bases: [null, null] })
    for (const m of Object.values(fu())) expect(m).not.toHaveBeenCalled()
  })

  it('invoice ← đơn hàng đã synced: BaseType 17, BaseLine = sapLineNum', async () => {
    fu().salesOrderLine.mockResolvedValue({ id: 'sol1', orderId: 'so1', lineNum: 3, sapLineNum: 2 })
    fu().salesOrder.mockResolvedValue({ sapDocEntry: 101, docNum: 42 })
    const r = await resolveCopyFromBases('Invoices', [{ sourceLineId: 'sol1' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 17, baseEntry: 101, baseLine: 2 }] })
  })

  it('invoice ← giao hàng: DeliveryLine không có sapLineNum → BaseLine = lineNum − 1 (SAP đếm từ 0)', async () => {
    fu().deliveryLine.mockResolvedValue({ id: 'dl1', deliveryId: 'd1', lineNum: 1 })
    fu().delivery.mockResolvedValue({ sapDocEntry: 77, docNum: 9 })
    const r = await resolveCopyFromBases('Invoices', [{ sourceLineId: 'dl1' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 15, baseEntry: 77, baseLine: 0 }] })
  })

  it('return ← giao hàng dòng 3 → BaseLine 2', async () => {
    fu().deliveryLine.mockResolvedValue({ id: 'dl3', deliveryId: 'd1', lineNum: 3 })
    fu().delivery.mockResolvedValue({ sapDocEntry: 78, docNum: 10 })
    const r = await resolveCopyFromBases('Returns', [{ sourceLineId: 'dl3' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 15, baseEntry: 78, baseLine: 2 }] })
  })

  it('nguồn chưa synced (thiếu sapDocEntry) → ok:false + lỗi rõ ràng, không lặng lẽ bỏ qua', async () => {
    fu().salesOrderLine.mockResolvedValue({ id: 'sol1', orderId: 'so1', lineNum: 1, sapLineNum: 0 })
    fu().salesOrder.mockResolvedValue({ sapDocEntry: null, docNum: 42 })
    const r = await resolveCopyFromBases('Invoices', [{ sourceLineId: 'sol1' }])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/đơn hàng bán nguồn #42/)
      expect(r.error).toMatch(/chưa được đẩy lên SAP B1/)
    }
  })

  it('không tìm thấy dòng nguồn ở bảng nào → ok:false', async () => {
    const r = await resolveCopyFromBases('Invoices', [{ sourceLineId: 'khong-co' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Không tìm thấy dòng chứng từ nguồn/)
  })

  it('quotation là đầu luồng: dòng có sourceLineId → ok:false', async () => {
    const r = await resolveCopyFromBases('Quotations', [{ sourceLineId: 'x' }])
    expect(r.ok).toBe(false)
  })

  it('creditMemo ← trả hàng: BaseType 16', async () => {
    fu().salesReturnLine.mockResolvedValue({ id: 'rl1', returnId: 'r1', lineNum: 2, sapLineNum: 1 })
    fu().salesReturn.mockResolvedValue({ sapDocEntry: 303, docNum: 11 })
    const r = await resolveCopyFromBases('CreditNotes', [{ sourceLineId: 'rl1' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 16, baseEntry: 303, baseLine: 1 }] })
  })

  it('return ← hóa đơn: BaseType 13', async () => {
    fu().arInvoiceLine.mockResolvedValue({ id: 'il1', invoiceId: 'i1', lineNum: 1, sapLineNum: 0 })
    fu().arInvoice.mockResolvedValue({ sapDocEntry: 404, docNum: 12 })
    const r = await resolveCopyFromBases('Returns', [{ sourceLineId: 'il1' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 13, baseEntry: 404, baseLine: 0 }] })
  })

  it('downPayment ← báo giá: BaseType 23', async () => {
    fu().quotationLine.mockResolvedValue({ id: 'ql1', quotationId: 'q1', lineNum: 5, sapLineNum: 4 })
    fu().quotation.mockResolvedValue({ sapDocEntry: 505, docNum: 3 })
    const r = await resolveCopyFromBases('DownPayments', [{ sourceLineId: 'ql1' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 23, baseEntry: 505, baseLine: 4 }] })
  })

  it('sapLineNum null trên nguồn đã synced → fallback lineNum − 1', async () => {
    fu().quotationLine.mockResolvedValue({ id: 'ql2', quotationId: 'q2', lineNum: 2, sapLineNum: null })
    fu().quotation.mockResolvedValue({ sapDocEntry: 606, docNum: 4 })
    const r = await resolveCopyFromBases('DownPayments', [{ sourceLineId: 'ql2' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 23, baseEntry: 606, baseLine: 1 }] })
  })

  // Ma trận copy-from đủ 7 loại chứng từ (Delivery: xem describe resolveSourceLineBase + copy-from-fixes)
  it.each([
    ['Invoices', 'quotationLine', 'quotation', 23],
    ['CreditNotes', 'arInvoiceLine', 'arInvoice', 13],
    ['DownPayments', 'salesOrderLine', 'salesOrder', 17],
  ] as const)('%s ← %s: BaseType %i', async (entity, lineDelegate, headerDelegate, baseType) => {
    const fk = { quotation: 'quotationId', arInvoice: 'invoiceId', salesOrder: 'orderId' }[headerDelegate]
    fu()[lineDelegate].mockResolvedValue({ id: 'x1', [fk]: 'h1', lineNum: 4, sapLineNum: 3 })
    fu()[headerDelegate].mockResolvedValue({ sapDocEntry: 808, docNum: 1 })
    const r = await resolveCopyFromBases(entity, [{ sourceLineId: 'x1' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType, baseEntry: 808, baseLine: 3 }] })
  })

  it('orders ← báo giá đã synced: BaseType 23, BaseLine = sapLineNum', async () => {
    fu().quotationLine.mockResolvedValue({ id: 'ql3', quotationId: 'q3', lineNum: 1, sapLineNum: 0 })
    fu().quotation.mockResolvedValue({ sapDocEntry: 707, docNum: 8 })
    const r = await resolveCopyFromBases('Orders', [{ sourceLineId: 'ql3' }])
    expect(r).toEqual({ ok: true, bases: [{ baseType: 23, baseEntry: 707, baseLine: 0 }] })
  })

  it('orders ← báo giá chưa synced → ok:false + lỗi 400 đúng pattern', async () => {
    fu().quotationLine.mockResolvedValue({ id: 'ql4', quotationId: 'q4', lineNum: 1, sapLineNum: 0 })
    fu().quotation.mockResolvedValue({ sapDocEntry: null, docNum: 8 })
    const r = await resolveCopyFromBases('Orders', [{ sourceLineId: 'ql4' }])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/báo giá bán hàng nguồn #8/)
      expect(r.error).toMatch(/chưa được đẩy lên SAP B1/)
      expect(r.error).toMatch(/Hãy đẩy báo giá bán hàng nguồn lên SAP trước, rồi đẩy lại/)
    }
  })

  it('orders: dòng không có sourceLineId → base null (đơn độc lập, tương thích ngược)', async () => {
    const r = await resolveCopyFromBases('Orders', [{ sourceLineId: null }])
    expect(r).toEqual({ ok: true, bases: [null] })
    expect(fu().quotationLine).not.toHaveBeenCalled()
  })
})

describe('resolveSourceLineBase (dùng cho delivery)', () => {
  it('delivery ← đơn hàng đã synced: BaseType 17', async () => {
    fu().salesOrderLine.mockResolvedValue({ id: 'sol9', orderId: 'so9', lineNum: 1, sapLineNum: 0 })
    fu().salesOrder.mockResolvedValue({ sapDocEntry: 606, docNum: 21 })
    const r = await resolveSourceLineBase(getSourceLineSpec('salesOrderLine')!, 'sol9', 'phiếu giao hàng')
    expect(r).toEqual({ ok: true, base: { baseType: 17, baseEntry: 606, baseLine: 0 } })
  })

  it('delivery ← báo giá: BaseType 23', async () => {
    fu().quotationLine.mockResolvedValue({ id: 'ql9', quotationId: 'q9', lineNum: 1, sapLineNum: 0 })
    fu().quotation.mockResolvedValue({ sapDocEntry: 707, docNum: 8 })
    const r = await resolveSourceLineBase(getSourceLineSpec('quotationLine')!, 'ql9', 'phiếu giao hàng')
    expect(r).toEqual({ ok: true, base: { baseType: 23, baseEntry: 707, baseLine: 0 } })
  })

  it('nguồn chưa synced → ok:false + lỗi nêu rõ tên/loại nguồn', async () => {
    fu().quotationLine.mockResolvedValue({ id: 'ql9', quotationId: 'q9', lineNum: 1, sapLineNum: 0 })
    fu().quotation.mockResolvedValue({ sapDocEntry: null, docNum: 8 })
    const r = await resolveSourceLineBase(getSourceLineSpec('quotationLine')!, 'ql9', 'phiếu giao hàng')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/báo giá bán hàng nguồn #8/)
      expect(r.error).toMatch(/chưa được đẩy lên SAP B1/)
    }
  })

  it('không tìm thấy dòng nguồn → ok:false', async () => {
    const r = await resolveSourceLineBase(getSourceLineSpec('salesOrderLine')!, 'khong-co', 'phiếu giao hàng')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Không tìm thấy dòng đơn hàng bán nguồn/)
  })
})

describe('buildSapLines — hóa đơn dịch vụ (AccountCode thay ItemCode)', () => {
  const line = { itemCode: 'DV-VANCHUYEN', accountCode: '5113', quantity: 1, unitPrice: 500000 }

  it('không truyền invoiceDocType → gửi ItemCode (tương thích ngược)', () => {
    const [l] = buildSapLines([line]) as any[]
    expect(l).toMatchObject({ ItemCode: 'DV-VANCHUYEN' })
    expect(l).not.toHaveProperty('AccountCode')
  })

  it("invoiceDocType='Service' → gửi AccountCode, KHÔNG gửi ItemCode", () => {
    const [l] = buildSapLines([line], undefined, undefined, 'Service') as any[]
    expect(l).toMatchObject({ AccountCode: '5113' })
    expect(l).not.toHaveProperty('ItemCode')
  })

  it("invoiceDocType='Reserve' → vẫn gửi ItemCode (hóa đơn dự trữ là chứng từ hàng)", () => {
    const [l] = buildSapLines([line], undefined, undefined, 'Reserve') as any[]
    expect(l).toMatchObject({ ItemCode: 'DV-VANCHUYEN' })
    expect(l).not.toHaveProperty('AccountCode')
  })

  it('Service + base → giữ Base* và dùng AccountCode', () => {
    const [l] = buildSapLines([line], [0], [{ baseType: 15, baseEntry: 44, baseLine: 1 }], 'Service') as any[]
    expect(l).toMatchObject({ AccountCode: '5113', BaseType: 15, BaseEntry: 44, BaseLine: 1 })
    expect(l).not.toHaveProperty('ItemCode')
  })
})

describe('buildSapDocPayload — hóa đơn dịch vụ', () => {
  it("invoiceDocType='Service' → DocType=dDocument_Service và dòng dùng AccountCode", () => {
    const p = buildSapDocPayload({
      cardCode: 'C20001',
      docDate: '2026-10-17',
      docDueDate: '2026-10-24',
      invoiceDocType: 'Service',
      lines: [{ itemCode: 'DV-VANCHUYEN', accountCode: '5113', quantity: 1, unitPrice: 500000 }],
    }) as any
    expect(p).toMatchObject({ DocType: 'dDocument_Service' })
    expect(p.DocumentLines[0]).toMatchObject({ AccountCode: '5113' })
    expect(p.DocumentLines[0]).not.toHaveProperty('ItemCode')
  })

  it("không có invoiceDocType → không có DocType và dòng dùng ItemCode", () => {
    const p = buildSapDocPayload({
      cardCode: 'C20001',
      docDate: '2026-10-17',
      docDueDate: '2026-10-24',
      lines: [{ itemCode: 'FM-RAU-001', quantity: 1, unitPrice: 1000 }],
    }) as any
    expect(p).not.toHaveProperty('DocType')
    expect(p.DocumentLines[0]).toMatchObject({ ItemCode: 'FM-RAU-001' })
    expect(p.DocumentLines[0]).not.toHaveProperty('AccountCode')
  })
})
