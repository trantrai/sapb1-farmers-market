// Test canonical v1.1 + decision log (F2, F8)
import { describe, expect, it } from 'vitest'
import {
  buildCanonicalDoc,
  parentsOf,
  primaryBarcodeOf,
} from '../canonical'
import { BOM_DECISIONS, snapshotDecisions } from '../decisions'
import { makeParent } from './fixtures'

describe('buildCanonicalDoc', () => {
  it('version 1.1, giữ nguyên parents[], thêm jobContext optional', () => {
    const doc = buildCanonicalDoc([makeParent()], {
      sourceFile: 'md_05_test.xlsx',
      jobContext: {
        jobId: '9999',
        jobName: 'Job test',
        workflowId: 'w1',
        sourceFiles: [],
      },
    })
    expect(doc.version).toBe('1.1')
    expect(doc.sourceFile).toBe('md_05_test.xlsx')
    expect(doc.parents).toHaveLength(1)
    expect(doc.jobContext?.jobId).toBe('9999')
    expect(doc.importedAt).toBeTruthy()
  })

  it('không có jobContext → field vắng mặt (tương thích v1.0)', () => {
    const doc = buildCanonicalDoc([makeParent()], { sourceFile: 'x.xlsx' })
    expect(doc.jobContext).toBeUndefined()
    expect(doc.quotation).toBeUndefined()
  })
})

describe('ADR-010 — tương thích ngược', () => {
  it('parentsOf đọc được doc chỉ có parents[] (kiểu v1.0)', () => {
    const legacy = { parents: [makeParent()] }
    expect(parentsOf(legacy)).toHaveLength(1)
  })
})

describe('primaryBarcodeOf (Q2a)', () => {
  it('ưu tiên thương mại → đầu 8 → đầu I', () => {
    expect(primaryBarcodeOf({ trade: 'a', internal8: 'b', internalI: 'c' })).toBe('a')
    expect(primaryBarcodeOf({ trade: null, internal8: 'b', internalI: 'c' })).toBe('b')
    expect(primaryBarcodeOf({ trade: null, internal8: null, internalI: 'c' })).toBe('c')
    expect(primaryBarcodeOf({ trade: null, internal8: null, internalI: null })).toBeNull()
  })
})

describe('BOM_DECISIONS (F8)', () => {
  it('đủ 17 mục, mỗi mục có id + quyết định đã chốt', () => {
    expect(BOM_DECISIONS).toHaveLength(17)
    const ids = BOM_DECISIONS.map((d) => d.id)
    for (const want of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9', 'Q10',
      'NQ1', 'NQ2', 'NQ3', 'NQ4', 'NQ5', 'NQ6', 'NQ7']) {
      expect(ids).toContain(want)
    }
    for (const d of BOM_DECISIONS) {
      expect(d.question.length).toBeGreaterThan(0)
      expect(d.decided.length).toBeGreaterThan(0)
    }
  })

  it('snapshotDecisions → JSON parse được, đủ 17 mục', () => {
    const snap = JSON.parse(snapshotDecisions())
    expect(snap).toHaveLength(17)
    expect(snap[0]).toHaveProperty('id')
    expect(snap[0]).toHaveProperty('decided')
    expect(snap[0]).toHaveProperty('at')
  })
})
