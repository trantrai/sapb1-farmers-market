// ============================================================
// Test địa chỉ giao/ghi hóa đơn + người liên hệ:
// - Payload POST / PATCH gửi ShipToCode, BillToCode, ContactPersonCode
// - headerExtrasFromRecord không bỏ sót trường nào
// - bp-b2b: parse + chọn mặc định theo khách hàng
// ============================================================
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))

const sapPatch = vi.fn()
vi.mock('@/lib/sap-service-layer', async (orig) => ({
  ...(await orig<typeof import('@/lib/sap-service-layer')>()),
  sapPatch: (...args: unknown[]) => sapPatch(...args),
}))

import {
  buildSapDocPayload,
  headerExtrasFromRecord,
  patchDocumentToSap,
  sapDocHeaderExtras,
} from '@/lib/sap-push-document'
import {
  applyB2BPartyDefaults,
  billAddresses,
  defaultB2BParty,
  parseB2BAddresses,
  parseB2BContacts,
  shipAddresses,
  type BpB2BInfo,
} from '@/lib/bp-b2b'

const line = { itemCode: 'FG001', quantity: 1, unitPrice: 1000, discPct: 0 }

describe('ContactPersonCode trong payload', () => {
  it('sapDocHeaderExtras gửi ContactPersonCode khi là số (kể cả 0)', () => {
    expect(sapDocHeaderExtras({ contactPersonCode: 12 })).toEqual({ ContactPersonCode: 12 })
    expect(sapDocHeaderExtras({ contactPersonCode: 0 })).toEqual({ ContactPersonCode: 0 })
    expect(sapDocHeaderExtras({ contactPersonCode: null })).toEqual({})
  })

  it('POST gửi đủ ShipToCode / BillToCode / ContactPersonCode', () => {
    const p = buildSapDocPayload({
      cardCode: 'C1', docDate: '2026-10-23', docDueDate: '2026-10-30', lines: [line],
      shipToCode: 'Kho HCM', billToCode: 'Trụ sở', contactPersonCode: 7,
    })
    expect(p).toMatchObject({ ShipToCode: 'Kho HCM', BillToCode: 'Trụ sở', ContactPersonCode: 7 })
  })

  it('PATCH (sửa chứng từ đã đẩy) gửi địa chỉ + người liên hệ', async () => {
    sapPatch.mockResolvedValueOnce({ ok: true, status: 204 })
    const res = await patchDocumentToSap({} as never, {
      entitySet: 'Orders', docEntry: 99, lines: [line],
      shipToCode: 'Kho HN', billToCode: 'Trụ sở', contactPersonCode: 3,
    })
    expect(res.status).toBe('synced')
    const [, path, payload] = sapPatch.mock.calls[0]
    expect(path).toBe('/Orders(99)')
    expect(payload).toMatchObject({ ShipToCode: 'Kho HN', BillToCode: 'Trụ sở', ContactPersonCode: 3 })
  })

  it('PATCH không có giá trị → không thêm key (giữ nguyên trên SAP)', async () => {
    sapPatch.mockResolvedValueOnce({ ok: true, status: 204 })
    await patchDocumentToSap({} as never, { entitySet: 'Quotations', docEntry: 1, lines: [line] })
    const payload = sapPatch.mock.calls.at(-1)![2] as Record<string, unknown>
    expect(payload).not.toHaveProperty('ShipToCode')
    expect(payload).not.toHaveProperty('BillToCode')
    expect(payload).not.toHaveProperty('ContactPersonCode')
  })

  it('headerExtrasFromRecord lấy đủ trường từ bản ghi DB', () => {
    const ex = headerExtrasFromRecord({
      salesPersonCode: 1, paymentGroupCode: 2, shipToCode: 'S', billToCode: 'B', contactPersonCode: 5,
      numAtCard: 'PO', taxDate: null, docCurrency: 'VND', docRate: 1, projectCode: null, reqDate: null,
    })
    expect(sapDocHeaderExtras(ex)).toMatchObject({
      SalesPersonCode: 1, PaymentGroupCode: 2, ShipToCode: 'S', BillToCode: 'B', ContactPersonCode: 5, NumAtCard: 'PO',
    })
  })
})

describe('bp-b2b — địa chỉ + người liên hệ theo khách hàng', () => {
  const info: BpB2BInfo = {
    addresses: parseB2BAddresses(JSON.stringify([
      { code: 'Trụ sở', name: 'Trụ sở', detail: '1 Lê Lợi, Q1', type: 'BS' },
      { code: 'Kho HN', name: 'Kho HN', type: 'S' },
      { code: 'VP HN', name: 'VP HN', type: 'B' },
    ])),
    contacts: parseB2BContacts(JSON.stringify([
      { code: 1, name: 'Anh A', phone: '090' },
      { code: 2, name: 'Chị B', isDefault: true },
    ])),
    shipToDefault: 'Kho HN',
    billToDefault: 'Trụ sở',
  }

  it("địa chỉ loại 'BS' có trong cả danh sách giao hàng và ghi hóa đơn", () => {
    expect(shipAddresses(info.addresses).map((a) => a.code)).toEqual(['Trụ sở', 'Kho HN'])
    expect(billAddresses(info.addresses).map((a) => a.code)).toEqual(['Trụ sở', 'VP HN'])
  })

  it('mặc định theo SAP: ShipToDefault / BilltoDefault / người liên hệ mặc định', () => {
    expect(defaultB2BParty(info)).toEqual({ shipToCode: 'Kho HN', billToCode: 'Trụ sở', contactPersonCode: '2' })
  })

  it('không có mặc định: chỉ 1 lựa chọn → chọn luôn; nhiều lựa chọn → để trống', () => {
    const d = defaultB2BParty({ ...info, shipToDefault: '', billToDefault: '', contacts: [info.contacts[0]] })
    expect(d).toEqual({ shipToCode: '', billToCode: '', contactPersonCode: '1' })
  })

  it('chọn KH mới (force) → ghi đè bằng mặc định', () => {
    const r = applyB2BPartyDefaults(info, { shipToCode: 'Trụ sở', billToCode: 'VP HN', contactPersonCode: '1' }, true)
    expect(r).toEqual({ shipToCode: 'Kho HN', billToCode: 'Trụ sở', contactPersonCode: '2' })
  })

  it('mở chứng từ đã lưu → giữ giá trị hợp lệ, điền mặc định cho ô trống/không hợp lệ', () => {
    const r = applyB2BPartyDefaults(info, { shipToCode: 'Trụ sở', billToCode: 'XYZ', contactPersonCode: '' }, false)
    expect(r).toEqual({ shipToCode: 'Trụ sở', billToCode: 'Trụ sở', contactPersonCode: '2' })
  })

  it('KH chưa đồng bộ địa chỉ/người liên hệ → giữ giá trị đã lưu; chọn KH mới → xóa', () => {
    const empty: BpB2BInfo = { addresses: [], contacts: [], shipToDefault: '', billToDefault: '' }
    const saved = { shipToCode: 'A', billToCode: 'B', contactPersonCode: '9' }
    expect(applyB2BPartyDefaults(empty, saved, false)).toEqual(saved)
    expect(applyB2BPartyDefaults(empty, saved, true)).toEqual({ shipToCode: '', billToCode: '', contactPersonCode: '' })
  })

  it('parseB2BContacts bỏ dòng không có mã hợp lệ, JSON lỗi → []', () => {
    expect(parseB2BContacts('[{"code":null,"name":"x"},{"code":"abc"},{"code":4,"name":""}]')).toEqual([
      { code: 4, name: '4', phone: undefined, email: undefined, isDefault: false },
    ])
    expect(parseB2BContacts('not json')).toEqual([])
  })
})
