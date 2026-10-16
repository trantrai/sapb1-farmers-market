// Test validation engine V1–V9 / W1–W10 (F3)
import { describe, expect, it } from 'vitest'
import {
  errorsOf,
  hasErrors,
  linkParentToSet,
  validateCanonical,
  warningsOf,
  type ValidationContext,
} from '../validator'
import { buildCanonicalDoc } from '../canonical'
import { makeParent } from './fixtures'

const baseCtx: ValidationContext = {}

function validate(over: Partial<ValidationContext> = {}, parentOver: Parameters<typeof makeParent>[0] = {}) {
  const doc = buildCanonicalDoc([makeParent(parentOver)], { sourceFile: 'x.xlsx' })
  return validateCanonical(doc, { ...baseCtx, ...over })
}

describe('V1 — fail-fast cấu trúc', () => {
  it('itemName trống → lỗi V1', () => {
    const issues = validate({}, { itemName: '' })
    expect(errorsOf(issues).some((i) => i.code === 'V1' && i.field === 'itemName')).toBe(true)
  })
  it('bomKind null → lỗi V1 kèm giá trị ô gốc', () => {
    const issues = validate({}, { bomKind: null, bomKindRaw: 'XYZ lạ' })
    const v1 = errorsOf(issues).find((i) => i.code === 'V1' && i.field === 'bomKind')
    expect(v1).toBeDefined()
    expect(v1!.message).toContain('XYZ lạ')
  })
  it('không có component → lỗi V1', () => {
    const issues = validate({}, { components: [] })
    expect(errorsOf(issues).some((i) => i.code === 'V1')).toBe(true)
  })
  it('parent hợp lệ → không lỗi V1', () => {
    expect(errorsOf(validate()).filter((i) => i.code === 'V1')).toHaveLength(0)
  })
})

describe('V2 — mã thuế', () => {
  it('taxOut sai format → lỗi V2', () => {
    const issues = validate({}, { taxOut: 'SX' })
    expect(errorsOf(issues).some((i) => i.code === 'V2')).toBe(true)
  })
  it('mã thuế không trong VatGroups → lỗi V2', () => {
    const issues = validate({ vatCodes: ['S2'] }, { taxOut: 'S4' })
    expect(errorsOf(issues).some((i) => i.code === 'V2')).toBe(true)
  })
  it('S2/P2 hợp lệ → không lỗi V2', () => {
    expect(errorsOf(validate()).filter((i) => i.code === 'V2')).toHaveLength(0)
  })
})

describe('V3 — dòng con', () => {
  it('childCode trống → lỗi V3', () => {
    const p = makeParent()
    p.components = [{ ...p.components[0], childCode: '' }]
    const issues = validate({}, p as never)
    expect(errorsOf(issues).some((i) => i.code === 'V3' && i.field === 'childCode')).toBe(true)
  })
  it('qtyPerParent <= 0 → lỗi V3', () => {
    const p = makeParent()
    p.components = [{ ...p.components[0], qtyPerParent: 0, qtyRaw: 0 }]
    const issues = validate({}, p as never)
    expect(errorsOf(issues).some((i) => i.code === 'V3')).toBe(true)
  })
  it('ĐVT trống → lỗi V3; ĐVT không trong master (khi có master) → lỗi V3', () => {
    const p = makeParent()
    p.components = [{ ...p.components[0], uom: '' }]
    expect(errorsOf(validate({}, p as never)).some((i) => i.code === 'V3')).toBe(true)

    const p2 = makeParent()
    p2.components = [{ ...p2.components[0], uom: 'Thùng' }]
    const issues = validate({ uoms: ['Kg', 'Cái'] }, p2 as never)
    expect(errorsOf(issues).some((i) => i.code === 'V3' && i.message.includes('Thùng'))).toBe(true)
  })
  it('không truyền uoms (Sprint 1 chưa có master B1) → chỉ kiểm tra rỗng', () => {
    const issues = validate()
    expect(errorsOf(issues).filter((i) => i.code === 'V3')).toHaveLength(0)
  })
})

describe('V4 — mã NVL tồn tại (ADR-005)', () => {
  it('mã con thiếu + policy mặc định → lỗi V4 fail-fast', () => {
    const issues = validate({ existingChildCodes: new Set(['I9999999']) })
    const v4 = errorsOf(issues).filter((i) => i.code === 'V4')
    expect(v4).toHaveLength(1)
    expect(v4[0].message).toContain('I0000001')
  })
  it('policy=warn → cảnh báo, không lỗi', () => {
    const issues = validate({ existingChildCodes: new Set(), missingChildPolicy: 'warn' })
    expect(errorsOf(issues).filter((i) => i.code === 'V4')).toHaveLength(0)
    expect(warningsOf(issues).some((i) => i.code === 'V4')).toBe(true)
  })
  it('mã con đã tồn tại → không có V4', () => {
    const issues = validate({ existingChildCodes: new Set(['I0000001']) })
    expect([...errorsOf(issues), ...warningsOf(issues)].filter((i) => i.code === 'V4')).toHaveLength(0)
  })
})

describe('V5 — mã cha đã tồn tại', () => {
  it('trùng mã cha, không allowUpdate → lỗi V5', () => {
    const issues = validate({ existingParentCodes: new Set(['CB-001']) }, { itemCode: 'CB-001' })
    expect(errorsOf(issues).some((i) => i.code === 'V5')).toBe(true)
  })
  it('allowUpdate=true → cảnh báo update (không lỗi)', () => {
    const issues = validate(
      { existingParentCodes: new Set(['CB-001']), allowUpdate: true },
      { itemCode: 'CB-001' },
    )
    expect(errorsOf(issues).filter((i) => i.code === 'V5')).toHaveLength(0)
    expect(warningsOf(issues).some((i) => i.code === 'V5')).toBe(true)
  })
})

describe('V6 — trùng mã con trong cha', () => {
  it('2 dòng cùng childCode → lỗi V6 đúng dòng', () => {
    const p = makeParent()
    const dup = { ...p.components[0], rowNo: 9, sortOrder: 1 }
    p.components = [p.components[0], dup]
    const issues = validate({}, p as never)
    const v6 = errorsOf(issues).filter((i) => i.code === 'V6')
    expect(v6).toHaveLength(1)
    expect(v6[0].rowNo).toBe(9)
  })
})

describe('V7/V8 — ràng buộc job + toàn vẹn file', () => {
  const jobCtx = {
    jobId: '4818871',
    jobName: 'Job test',
    workflowId: null,
    sourceFiles: [{ field: 'File BOM', filename: 'a.xlsx', md5: 'abc123', sha256: 'def456', bytes: 10, downloadedAt: '' }],
  }
  function validateJob(over: Partial<ValidationContext> = {}, jobOver: Partial<typeof jobCtx> = {}) {
    const doc = buildCanonicalDoc([makeParent()], {
      sourceFile: 'a.xlsx',
      jobContext: { ...jobCtx, ...jobOver },
    })
    return validateCanonical(doc, { jobId: '4818871', sourceFiles: [{ field: 'File BOM', md5: 'abc123', sha256: 'def456' }], ...over })
  }
  it('jobId khớp + md5 khớp → không lỗi V7/V8', () => {
    const issues = validateJob()
    expect([...errorsOf(issues)].filter((i) => i.code === 'V7' || i.code === 'V8')).toHaveLength(0)
  })
  it('jobId lệch → lỗi V7', () => {
    const issues = validateJob({ jobId: '9999' })
    expect(errorsOf(issues).some((i) => i.code === 'V7')).toBe(true)
  })
  it('md5 lệch → lỗi V7 (nghi tráo file)', () => {
    const issues = validateJob({}, { sourceFiles: [{ field: 'File BOM', filename: 'a.xlsx', md5: 'KHAC', sha256: 'def456', bytes: 10, downloadedAt: '' }] })
    expect(errorsOf(issues).some((i) => i.code === 'V7')).toBe(true)
  })
  it('thiếu sha256 → lỗi V8', () => {
    const issues = validateJob({}, { sourceFiles: [{ field: 'File BOM', filename: 'a.xlsx', md5: 'abc123', sha256: '', bytes: 10, downloadedAt: '' }] })
    expect(errorsOf(issues).some((i) => i.code === 'V8')).toBe(true)
  })
})

describe('V9 — link báo giá bắt buộc', () => {
  it('requireQuotationLink + không link được → lỗi V9', () => {
    const issues = validate(
      {
        requireQuotationLink: true,
        quotationSets: [{ name: 'Set hoàn toàn khác', lines: [], subtotalExVat: 1 }],
      },
      { itemName: 'PHẦN QUÀ TEST' },
    )
    expect(errorsOf(issues).some((i) => i.code === 'V9')).toBe(true)
  })
  it('link được → không lỗi V9', () => {
    const issues = validate(
      {
        requireQuotationLink: true,
        quotationSets: [{ name: 'Set Phần Quà Test 2026', lines: [], subtotalExVat: 1 }],
      },
      { itemName: 'PHẦN QUÀ TEST' },
    )
    expect(errorsOf(issues).filter((i) => i.code === 'V9')).toHaveLength(0)
  })
})

describe('W1/W2/W4/W5/W6 — cảnh báo', () => {
  it('W1: margin âm → cảnh báo', () => {
    const p = makeParent()
    p.mdChecks = { ...p.mdChecks, marginPct: -0.2 }
    const issues = validate({}, p as never)
    expect(warningsOf(issues).some((i) => i.code === 'W1')).toBe(true)
  })
  it('W2: costDelta vượt 5% → cảnh báo', () => {
    const p = makeParent()
    p.mdChecks = { ...p.mdChecks, costTotal: 60000, systemCost: 90000 }
    const issues = validate({}, p as never)
    expect(warningsOf(issues).some((i) => i.code === 'W2')).toBe(true)
  })
  it('W4: duplicateNameHit → cảnh báo', () => {
    const p = makeParent()
    p.mdChecks = { ...p.mdChecks, duplicateNameHit: true }
    const issues = validate({}, p as never)
    expect(warningsOf(issues).some((i) => i.code === 'W4')).toBe(true)
  })
  it('W5: cột S lệch >0.5% so với giá tính lại → cảnh báo', () => {
    const issues = validate({}, { priceExVat: 100000, priceCheckS: 101000, priceCheckQ: 100000 })
    expect(warningsOf(issues).some((i) => i.code === 'W5')).toBe(true)
  })
  it('W5: lệch trong ngưỡng → không cảnh báo', () => {
    const issues = validate({}, { priceExVat: 100000, priceCheckS: 100200 })
    expect(warningsOf(issues).filter((i) => i.code === 'W5')).toHaveLength(0)
  })
  it('W6: barcode trùng mặt hàng khác → cảnh báo', () => {
    const issues = validate({ existingBarcodes: new Map([['8931234567890', 'ITEM-KHAC']]) })
    expect(warningsOf(issues).some((i) => i.code === 'W6')).toBe(true)
  })
})

describe('W7/W8/W9/W10 — đối chiếu báo giá', () => {
  const sets = [{ name: 'Set Phần Quà Test', lines: [{ itemCode: 'I0000001' }], subtotalExVat: 110000 }]
  it('W7: lệch giá >1% (NQ3) → cảnh báo kèm số lệch', () => {
    const issues = validate({ quotationSets: sets }, { itemName: 'PHẦN QUÀ TEST', priceExVat: 100000 })
    const w7 = warningsOf(issues).filter((i) => i.code === 'W7')
    expect(w7).toHaveLength(1)
    expect(w7[0].message).toContain('110000')
  })
  it('W7: lệch trong 1% → không cảnh báo', () => {
    const issues = validate(
      { quotationSets: [{ name: 'Set Phần Quà Test', lines: [], subtotalExVat: 100500 }] },
      { itemName: 'PHẦN QUÀ TEST', priceExVat: 100000 },
    )
    expect(warningsOf(issues).filter((i) => i.code === 'W7')).toHaveLength(0)
  })
  it('W8: lệch margin >3 điểm % (NQ3) → cảnh báo', () => {
    const p = makeParent({ itemName: 'PHẦN QUÀ TEST' })
    p.mdChecks = { ...p.mdChecks, marginPct: 0.4 }
    p.itemCode = 'CB-001'
    const issues = validate(
      {
        quotationSets: sets,
        costing: [{ itemCode: 'CB-001', margin: 0.3 }],
      },
      p as never,
    )
    expect(warningsOf(issues).some((i) => i.code === 'W8')).toBe(true)
  })
  it('W9: mã con thiếu ở báo giá → cảnh báo liệt kê mã', () => {
    const issues = validate(
      { quotationSets: [{ name: 'Set Phần Quà Test', lines: [{ itemCode: 'I9999999' }], subtotalExVat: 100000 }] },
      { itemName: 'PHẦN QUÀ TEST' },
    )
    const w9 = warningsOf(issues).filter((i) => i.code === 'W9')
    expect(w9).toHaveLength(1)
    expect(w9[0].message).toContain('I0000001')
  })
  it('W10: lịch giao quá khứ → cảnh báo', () => {
    const issues = validate({ deliverySchedule: [{ date: '2000-01-01' }] })
    expect(warningsOf(issues).some((i) => i.code === 'W10')).toBe(true)
  })
  it('W10: lịch giao tương lai → không cảnh báo', () => {
    const issues = validate({ deliverySchedule: [{ date: '2099-01-01' }] })
    expect(warningsOf(issues).filter((i) => i.code === 'W10')).toHaveLength(0)
  })
})

describe('linkParentToSet (NQ4)', () => {
  it('khớp theo tên chứa nhau (2 chiều)', () => {
    const sets = [{ name: 'Set 4 — Quà Tết', lines: [], subtotalExVat: null }]
    expect(linkParentToSet(makeParent({ itemName: 'QUÀ TẾT' }), sets)).not.toBeNull()
    expect(linkParentToSet(makeParent({ itemName: 'Set 4 — Quà Tết 2026' }), sets)).not.toBeNull()
  })
  it('không khớp → null', () => {
    const sets = [{ name: 'Set hoàn toàn khác', lines: [], subtotalExVat: null }]
    expect(linkParentToSet(makeParent({ itemName: 'PHẦN QUÀ TEST' }), sets)).toBeNull()
  })
})

describe('helpers', () => {
  it('hasErrors/errorsOf/warningsOf phân loại đúng', () => {
    const issues = validate({ existingChildCodes: new Set() }) // V4 error
    expect(hasErrors(issues)).toBe(true)
    expect(errorsOf(issues).every((i) => i.severity === 'error')).toBe(true)
    expect(warningsOf(issues).every((i) => i.severity === 'warning')).toBe(true)
  })
  it('mỗi issue có đủ { code, rowNo, field, message, severity }', () => {
    const issues = validate({ existingChildCodes: new Set() })
    for (const i of issues) {
      expect(i.code).toBeTruthy()
      expect(['error', 'warning']).toContain(i.severity)
      expect(i.message.length).toBeGreaterThan(0)
    }
  })
})
