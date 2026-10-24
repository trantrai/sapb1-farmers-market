// ============================================================
// BOM Template đẩy 2 bước (SAP luôn tự bung công thức khi nhận dòng cha —
// đã xác nhận trên SAP thật: cha TreeType T, dòng bung là N, U_BOMID trống,
// SL theo định mức 1 cha). Kịch bản lấy từ đơn bị trùng thực tế:
//   0 CB-202610-0001 ×2 (T) · 1 N0002669 0,5 · 2 N0000148 1 (SAP bung)
//   · 3 N0000148 2 · 4 N0002669 1 (app gửi, U_BOMID)
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sapGet = vi.fn()
const sapPost = vi.fn()
const sapPatch = vi.fn()
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/sap-service-layer', () => ({
  loadSapSettings: async () => ({ serviceLayerUrl: 'https://sap:50000/b1s/v2', companyDb: 'X', sapUser: 'u', sapPassword: 'p', dbId: 'db1' }),
  isSapConfigured: () => true,
  sapGet: (...a: unknown[]) => sapGet(...a),
  sapPost: (...a: unknown[]) => sapPost(...a),
  sapPatch: (...a: unknown[]) => sapPatch(...a),
  sapGetAll: vi.fn(),
}))

import { finalLineNums, mapReconciledLines, planReconcile, type ReconcileLine, type SapDocLine } from '@/lib/sap-bom-reconcile'
import { patchDocumentToSap, pushDocumentToSap } from '@/lib/sap-push-document'

const CB = 'CB-202610-0001'
const parent = (code = CB, extra: Partial<ReconcileLine> = {}): ReconcileLine => ({ itemCode: code, quantity: 2, isBomChild: false, bomGroupKey: 'g1', ...extra })
const child = (code: string, quantity: number, extra: Partial<ReconcileLine> = {}): ReconcileLine =>
  ({ itemCode: code, quantity, isBomChild: true, bomGroupKey: 'g1', bomEditable: true, ...extra })
const sl = (LineNum: number, ItemCode: string, U_BOMID: string | null = null): SapDocLine => ({ LineNum, ItemCode, U_BOMID })
const trees = new Map([[CB, ['N0002669', 'N0000148']]])

describe('planReconcile — bước 2+3', () => {
  it('kịch bản thực tế: dùng lại 2 dòng SAP bung, sửa SL người dùng, giá 0, gắn U_BOMID', () => {
    const local = [parent(), child('N0000148', 2), child('N0002669', 1)]
    const plan = planReconcile(local, [sl(0, CB), sl(1, 'N0002669'), sl(2, 'N0000148')], [0], trees)
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    expect(plan.patchLines).toEqual([
      { LineNum: 0 },
      { LineNum: 2, Quantity: 2, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB },
      { LineNum: 1, Quantity: 1, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB },
    ])
    expect(plan.patchLines[0]).not.toHaveProperty('ItemCode') // không gửi lại mã cha → SAP không bung lần nữa
    expect(plan.newIdx).toEqual([])
    expect(finalLineNums(3, plan.keep, plan.newIdx, [sl(0, CB), sl(1, 'N0002669', CB), sl(2, 'N0000148', CB)])).toEqual([0, 2, 1])
  })

  it('hoán đổi thành phần → dòng mới; thành phần bị bỏ → không có trong danh sách (SAP xoá)', () => {
    const local = [parent(), child('N0000148', 2), child('X-999', 5, { uom: 'kg', taxCode: 'S8', warehouseCode: 'WH1' })]
    const plan = planReconcile(local, [sl(0, CB), sl(1, 'N0002669'), sl(2, 'N0000148')], [0], trees)
    if (plan.kind !== 'ok') throw new Error(plan.kind)
    expect(plan.patchLines).toEqual([
      { LineNum: 0 },
      { LineNum: 2, Quantity: 2, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB },
      { ItemCode: 'X-999', MeasureUnit: 'kg', Quantity: 5, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB, VatGroup: 'S8', WarehouseCode: 'WH1' },
    ])
    expect(plan.patchLines.some((l) => l.LineNum === 1)).toBe(false)
    expect(finalLineNums(3, plan.keep, plan.newIdx, [sl(0, CB), sl(2, 'N0000148', CB), sl(3, 'X-999', CB)])).toEqual([0, 2, 3])
  })

  it('nhiều dòng thường + 2 nhóm cùng mã cha: khớp đúng khối bung của từng cha', () => {
    const local = [
      { itemCode: 'RAU', quantity: 1 },
      parent(CB, { bomGroupKey: 'a' }), child('N0000148', 4, { bomGroupKey: 'a' }),
      parent(CB, { bomGroupKey: 'b', quantity: 1 }), child('N0002669', 3, { bomGroupKey: 'b' }), child('N0000148', 1, { bomGroupKey: 'b' }),
      { itemCode: 'N0000148', quantity: 9 }, // hàng thường trùng mã thành phần
    ]
    const sap = [sl(0, 'RAU'), sl(1, CB), sl(2, 'N0002669'), sl(3, 'N0000148'), sl(4, CB), sl(5, 'N0002669'), sl(6, 'N0000148'), sl(7, 'N0000148')]
    const plan = planReconcile(local, sap, [0, 1, 3, 6], trees)
    if (plan.kind !== 'ok') throw new Error(plan.kind)
    expect(plan.patchLines.map((l) => l.LineNum ?? `new:${l.ItemCode}`)).toEqual([0, 1, 3, 4, 5, 6, 7])
    expect(plan.patchLines[6]).toEqual({ LineNum: 7 }) // hàng thường giữ nguyên
    expect(plan.patchLines.some((l) => l.LineNum === 2)).toBe(false) // N0002669 của nhóm a bị bỏ → xoá
  })

  it('đã đối chiếu ở lần trước (dòng con có U_BOMID) → không PATCH lại, ánh xạ LineNum theo U_BOMID', () => {
    const local = [parent(), child('N0000148', 2), child('N0002669', 1)]
    const sap = [sl(0, CB), sl(1, 'N0002669', CB), sl(2, 'N0000148', CB)]
    expect(planReconcile(local, sap, [0], trees)).toEqual({ kind: 'already' })
    expect(mapReconciledLines(local, sap)).toEqual([0, 2, 1])
  })

  it('định mức SAP khác dự kiến → báo lỗi, không PATCH bừa', () => {
    const local = [parent(), child('N0000148', 2)]
    const plan = planReconcile(local, [sl(0, CB), sl(1, 'N0002669'), sl(2, 'N0000148')], [0], new Map([[CB, ['N0002669', 'N0000148', 'Z']]]))
    expect(plan.kind).toBe('error')
  })

  it('luồng sửa: thêm nhóm Template mới sau các dòng cũ', () => {
    const local: ReconcileLine[] = [
      { itemCode: 'A', quantity: 1, lineNum: 0 },
      parent(CB, { quantity: 1 }),
      child('N0002669', 3),
      { itemCode: 'B', quantity: 2, lineNum: 1 },
    ]
    // Bước 1 PATCH: A(0), B(1) cũ + cha mới → SAP: 2 = cha, 3–4 = bung
    const sap = [sl(0, 'A'), sl(1, 'B'), sl(2, CB), sl(3, 'N0002669'), sl(4, 'N0000148')]
    const plan = planReconcile(local, sap, [0, 3, 1], trees)
    if (plan.kind !== 'ok') throw new Error(plan.kind)
    expect(plan.patchLines).toEqual([
      { LineNum: 0 },
      { LineNum: 2 },
      { LineNum: 3, Quantity: 3, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB },
      { LineNum: 1 },
    ])
  })
})

describe('pushDocumentToSap / patchDocumentToSap — gọi Service Layer', () => {
  beforeEach(() => { sapGet.mockReset(); sapPost.mockReset(); sapPatch.mockReset() })

  const docLines = { value: [] as unknown[] }
  const routeGet = (afterPatch: SapDocLine[]) => (_s: unknown, path: string) => {
    if (path === '/Orders') return { ok: true, data: docLines } // tra marker localId: chưa có
    if (path.startsWith('/ProductTrees(')) return { ok: true, data: { ProductTreeLines: [{ ItemCode: 'N0002669' }, { ItemCode: 'N0000148' }] } }
    return { ok: true, data: { DocumentLines: afterPatch } }
  }

  it('POST chỉ gửi dòng cha; PATCH áp dòng con người dùng; trả LineNum theo dòng local', async () => {
    sapGet.mockImplementation(routeGet([sl(0, CB), sl(1, 'N0002669', CB), sl(2, 'N0000148', CB)]))
    sapPost.mockResolvedValue({ ok: true, data: { DocEntry: 77, DocNum: 1001, DocumentLines: [sl(0, CB), sl(1, 'N0002669'), sl(2, 'N0000148')] } })
    sapPatch.mockResolvedValue({ ok: true, status: 204 })
    const r = await pushDocumentToSap({
      entitySet: 'Orders', cardCode: 'C1', docDate: '2026-10-24', docDueDate: '2026-10-25', localId: 'loc1',
      lines: [
        { itemCode: CB, quantity: 2, unitPrice: 300000, isBomChild: false, bomGroupKey: 'g1' },
        { itemCode: 'N0000148', quantity: 2, unitPrice: 0, isBomChild: true, bomGroupKey: 'g1', bomEditable: true },
        { itemCode: 'N0002669', quantity: 1, unitPrice: 0, isBomChild: true, bomGroupKey: 'g1', bomEditable: true },
      ],
    })
    const posted = sapPost.mock.calls[0][2] as { DocumentLines: Record<string, unknown>[] }
    expect(posted.DocumentLines).toHaveLength(1)
    expect(posted.DocumentLines[0]).toMatchObject({ ItemCode: CB, Quantity: 2, UnitPrice: 300000 })
    expect(sapPatch).toHaveBeenCalledWith(expect.anything(), '/Orders(77)', {
      DocumentLines: [
        { LineNum: 0 },
        { LineNum: 2, Quantity: 2, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB },
        { LineNum: 1, Quantity: 1, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB },
      ],
    })
    expect(r).toEqual({ status: 'synced', udf: true, docEntry: 77, docNum: 1001, lineNums: [0, 2, 1] })
  })

  it('bước 2 lỗi + có marker localId → pending (Đẩy lại sẽ nhận lại chứng từ và áp tiếp)', async () => {
    sapGet.mockImplementation(routeGet([]))
    sapPost.mockResolvedValue({ ok: true, data: { DocEntry: 78, DocumentLines: [sl(0, CB), sl(1, 'N0002669'), sl(2, 'N0000148')] } })
    sapPatch.mockResolvedValue({ ok: false, status: 400, error: 'boom' })
    const r = await pushDocumentToSap({
      entitySet: 'Orders', cardCode: 'C1', docDate: '2026-10-24', docDueDate: '2026-10-25', localId: 'loc2',
      lines: [
        { itemCode: CB, quantity: 2, unitPrice: 1, isBomChild: false, bomGroupKey: 'g1' },
        { itemCode: 'N0000148', quantity: 2, unitPrice: 0, isBomChild: true, bomGroupKey: 'g1', bomEditable: true },
      ],
    })
    expect(r.status).toBe('pending')
    expect(r.error).toMatch(/chưa áp được định mức/)
  })

  it('đơn không có BOM Template: giữ nguyên 1 lần POST, không PATCH', async () => {
    sapGet.mockImplementation(routeGet([]))
    sapPost.mockResolvedValue({ ok: true, data: { DocEntry: 79, DocNum: 5, DocumentLines: [sl(0, 'RAU')] } })
    const r = await pushDocumentToSap({ entitySet: 'Orders', cardCode: 'C1', docDate: '2026-10-24', docDueDate: '2026-10-25', localId: 'loc3', lines: [{ itemCode: 'RAU', quantity: 1, unitPrice: 5 }] })
    expect(sapPatch).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'synced', docEntry: 79, lineNums: [0] })
  })

  it('sửa đơn thêm nhóm Template: PATCH 1 không gửi dòng con, PATCH 2 áp dòng con', async () => {
    sapGet.mockImplementation((_s: unknown, path: string) => {
      if (path.startsWith('/ProductTrees(')) return { ok: true, data: { ProductTreeLines: [{ ItemCode: 'N0002669' }, { ItemCode: 'N0000148' }] } }
      return { ok: true, data: { DocumentLines: sapPatch.mock.calls.length < 2
        ? [sl(0, 'A'), sl(1, CB), sl(2, 'N0002669'), sl(3, 'N0000148')]
        : [sl(0, 'A'), sl(1, CB), sl(3, 'N0000148', CB)] } }
    })
    sapPatch.mockResolvedValue({ ok: true, status: 204 })
    const r = await patchDocumentToSap({ serviceLayerUrl: '', companyDb: '', sapUser: '', sapPassword: '' } as never, {
      entitySet: 'Orders', docEntry: 9,
      lines: [
        { lineNum: 0, itemCode: 'A', quantity: 1, unitPrice: 1 },
        { itemCode: CB, quantity: 1, unitPrice: 10, isBomChild: false, bomGroupKey: 'g1' },
        { itemCode: 'N0000148', quantity: 6, unitPrice: 0, isBomChild: true, bomGroupKey: 'g1', bomEditable: true },
      ],
    })
    const first = sapPatch.mock.calls[0][2] as { DocumentLines: Record<string, unknown>[] }
    expect(first.DocumentLines.map((l) => l.ItemCode)).toEqual(['A', CB])
    expect(sapPatch.mock.calls[1][2]).toEqual({ DocumentLines: [
      { LineNum: 0 }, { LineNum: 1 }, { LineNum: 3, Quantity: 6, UnitPrice: 0, DiscountPercent: 0, U_BOMID: CB },
    ] })
    expect(r).toMatchObject({ status: 'synced', lineNums: [0, 1, 3] })
  })
})
