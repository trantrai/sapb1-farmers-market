// Test sinh mã cha (F4, Q1/ADR-003) — fixture tổng hợp
import { describe, expect, it } from 'vitest'
import { generateParentCodes, splitTrailingNumber } from '../parent-codes'

describe('splitTrailingNumber', () => {
  it('"CB-202610-0007" → prefix + num 7 + width 4', () => {
    expect(splitTrailingNumber('CB-202610-0007')).toEqual({ prefix: 'CB-202610-', num: 7, width: 4 })
  })
  it('không có phần số cuối → null', () => {
    expect(splitTrailingNumber('GIFTBOX')).toBeNull()
    expect(splitTrailingNumber('')).toBeNull()
  })
})

describe('generateParentCodes — tăng dần giữ zero-padding', () => {
  it('"CB-202610-0007" + 2 cha → "…-0007", "…-0008"', async () => {
    const r = await generateParentCodes('CB-202610-0007', { count: 2, exists: () => false })
    expect(r.codes).toEqual(['CB-202610-0007', 'CB-202610-0008'])
    expect(r.dupChecked).toBe(true)
  })
  it('tràn width: "CB-0099" → "CB-0100"', async () => {
    const r = await generateParentCodes('CB-0099', { count: 2, exists: () => false })
    expect(r.codes).toEqual(['CB-0099', 'CB-0100'])
  })
  it('không có phần số cuối → mã đầu giữ nguyên, sau thêm "-001", "-002"', async () => {
    const r = await generateParentCodes('GIFTBOX', { count: 3, exists: () => false })
    expect(r.codes).toEqual(['GIFTBOX', 'GIFTBOX-001', 'GIFTBOX-002'])
  })
  it('mã đầu trống → throw', async () => {
    await expect(generateParentCodes('  ', { count: 1 })).rejects.toThrow()
  })
})

describe('generateParentCodes — kiểm tra trùng', () => {
  it('trùng → tăng tiếp ("CB-0007" đã tồn tại → dùng "CB-0008")', async () => {
    const existing = new Set(['CB-202610-0007'])
    const r = await generateParentCodes('CB-202610-0007', {
      count: 2,
      exists: (c) => existing.has(c),
    })
    expect(r.codes).toEqual(['CB-202610-0008', 'CB-202610-0009'])
  })
  it('trùng quá 10 lần → throw', async () => {
    await expect(
      generateParentCodes('CB-0001', { count: 1, exists: () => true, maxBump: 10 }),
    ).rejects.toThrow(/10 lần/)
  })
  it('không truyền exists → warning + dupChecked=false (B1 chưa sẵn sàng)', async () => {
    const r = await generateParentCodes('CB-0001', { count: 1 })
    expect(r.dupChecked).toBe(false)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.codes).toEqual(['CB-0001'])
  })
  it('idempotent: cùng input → cùng dãy mã', async () => {
    const a = await generateParentCodes('CB-202610-0007', { count: 3, exists: () => false })
    const b = await generateParentCodes('CB-202610-0007', { count: 3, exists: () => false })
    expect(a.codes).toEqual(b.codes)
  })
})
