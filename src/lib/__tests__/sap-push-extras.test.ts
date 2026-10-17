// ============================================================
// Test header mở rộng Đợt 2+3 khi đẩy sang SAP B1:
// - buildSapLines: BatchNumbers chỉ gửi khi dòng có batchNumber
// - buildSapDocPayload / sapDocHeaderExtras: SalesPersonCode,
//   PaymentGroupCode, ShipToCode, BillToCode, NumAtCard, TaxDate,
//   DocCurrency+DocRate (chỉ khi ≠ VND), ProjectCode, ReqDate —
//   chỉ gửi khi CÓ GIÁ TRỊ; trống → giữ nguyên hành vi cũ.
// ============================================================
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

import {
  buildSapLines,
  buildSapDocPayload,
  sapDocHeaderExtras,
} from '@/lib/sap-push-document'

const baseInput = {
  cardCode: 'C20001',
  docDate: '2026-10-17',
  docDueDate: '2026-11-17',
  lines: [
    {
      itemCode: 'FG001',
      quantity: 10,
      unitPrice: 50000,
      discPct: 0,
      taxCode: 'S8',
      warehouseCode: 'WH01',
      uom: 'kg',
    },
  ],
}

describe('buildSapLines — BatchNumbers', () => {
  it('gửi BatchNumbers=[{BatchNumber}] khi dòng có batchNumber', () => {
    const [line] = buildSapLines([{ ...baseInput.lines[0], batchNumber: 'LOT-001' }])
    expect(line).toMatchObject({ BatchNumbers: [{ BatchNumber: 'LOT-001' }] })
  })

  it('không gửi BatchNumbers khi batchNumber trống/rỗng (giữ hành vi cũ)', () => {
    const [l1] = buildSapLines([{ ...baseInput.lines[0] }])
    const [l2] = buildSapLines([{ ...baseInput.lines[0], batchNumber: '   ' }])
    expect(l1).not.toHaveProperty('BatchNumbers')
    expect(l2).not.toHaveProperty('BatchNumbers')
  })
})

describe('sapDocHeaderExtras', () => {
  it('gửi đủ trường khi có giá trị', () => {
    const ex = sapDocHeaderExtras({
      salesPersonCode: 5,
      paymentGroupCode: 3,
      shipToCode: 'SHIP-01',
      billToCode: 'BILL-01',
      numAtCard: 'PO-2026-001',
      taxDate: '2026-10-17T00:00:00Z',
      docCurrency: 'USD',
      docRate: 25500,
      projectCode: 'PRJ-A',
      reqDate: new Date(Date.UTC(2026, 9, 20)),
    })
    expect(ex).toMatchObject({
      SalesPersonCode: 5,
      PaymentGroupCode: 3,
      ShipToCode: 'SHIP-01',
      BillToCode: 'BILL-01',
      NumAtCard: 'PO-2026-001',
      TaxDate: '2026-10-17',
      DocCurrency: 'USD',
      DocRate: 25500,
      ProjectCode: 'PRJ-A',
      ReqDate: '2026-10-20',
    })
  })

  it('không gửi DocCurrency/DocRate khi là VND (kể cả chữ thường)', () => {
    const ex = sapDocHeaderExtras({ docCurrency: 'vnd', docRate: 1 })
    expect(ex).not.toHaveProperty('DocCurrency')
    expect(ex).not.toHaveProperty('DocRate')
  })

  it('trả {} khi mọi trường trống — giữ nguyên hành vi cũ', () => {
    expect(sapDocHeaderExtras({})).toEqual({})
    expect(
      sapDocHeaderExtras({
        salesPersonCode: null,
        shipToCode: '  ',
        taxDate: null,
        docCurrency: '',
        reqDate: undefined,
      }),
    ).toEqual({})
  })

  it('không gửi DocRate khi docRate không hợp lệ', () => {
    const ex = sapDocHeaderExtras({ docCurrency: 'USD', docRate: 0 })
    expect(ex).toMatchObject({ DocCurrency: 'USD' })
    expect(ex).not.toHaveProperty('DocRate')
  })
})

describe('buildSapDocPayload — header mở rộng', () => {
  it('gộp header extras vào payload POST', () => {
    const p: any = buildSapDocPayload({
      ...baseInput,
      salesPersonCode: 7,
      paymentGroupCode: 2,
      shipToCode: 'S1',
      billToCode: 'B1',
      numAtCard: 'PO-1',
      taxDate: '2026-10-17',
      docCurrency: 'EUR',
      docRate: 27000,
      projectCode: 'P1',
      reqDate: '2026-10-25',
    })
    expect(p).toMatchObject({
      CardCode: 'C20001',
      SalesPersonCode: 7,
      PaymentGroupCode: 2,
      ShipToCode: 'S1',
      BillToCode: 'B1',
      NumAtCard: 'PO-1',
      TaxDate: '2026-10-17',
      DocCurrency: 'EUR',
      DocRate: 27000,
      ProjectCode: 'P1',
      ReqDate: '2026-10-25',
      // hành vi cũ giữ nguyên: CK đầu chứng từ luôn gửi
      DiscountPercent: 0,
    })
    expect(p.DocumentLines).toHaveLength(1)
  })

  it('không thêm key mới khi input không có header extras', () => {
    const p: any = buildSapDocPayload({ ...baseInput })
    for (const k of [
      'SalesPersonCode', 'PaymentGroupCode', 'ShipToCode', 'BillToCode',
      'NumAtCard', 'TaxDate', 'DocCurrency', 'DocRate', 'ProjectCode', 'ReqDate',
    ]) {
      expect(p).not.toHaveProperty(k)
    }
  })
})
