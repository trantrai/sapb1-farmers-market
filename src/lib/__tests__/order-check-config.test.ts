import { describe, expect, it } from 'vitest'
import { DEFAULT_ORDER_CHECK_CONFIG, historyNeeds, isIssueEnabled, parseOrderCheckConfig } from '@/lib/order-check-config'

describe('parseOrderCheckConfig', () => {
  it('empty / invalid → all enabled', () => {
    expect(parseOrderCheckConfig('')).toEqual(DEFAULT_ORDER_CHECK_CONFIG)
    expect(parseOrderCheckConfig('{bad json')).toEqual(DEFAULT_ORDER_CHECK_CONFIG)
    expect(parseOrderCheckConfig(null)).toEqual(DEFAULT_ORDER_CHECK_CONFIG)
  })
  it('keeps booleans, drops unknown keys and non-boolean values', () => {
    const c = parseOrderCheckConfig(JSON.stringify({ enabled: false, notices: 'no', rules: { atp: false, bogus: false, dupOrder: 0 } }))
    expect(c.enabled).toBe(false)
    expect(c.notices).toBe(true)
    expect(c.rules.atp).toBe(false)
    expect(c.rules.dupOrder).toBe(true)
    expect('bogus' in c.rules).toBe(false)
  })
})

describe('isIssueEnabled', () => {
  const off = (patch: object) => parseOrderCheckConfig({ ...patch })
  it('errors always shown', () => {
    expect(isIssueEnabled(off({ enabled: false }), { level: 'error', code: 'no-partner' })).toBe(true)
  })
  it('master switch hides all warnings', () => {
    expect(isIssueEnabled(off({ enabled: false }), { level: 'warning', code: 'atp' })).toBe(false)
  })
  it('per-rule switch, incl. multi-code rule', () => {
    const c = off({ rules: { dueDate: false } })
    expect(isIssueEnabled(c, { level: 'warning', code: 'due-past' })).toBe(false)
    expect(isIssueEnabled(c, { level: 'warning', code: 'due-sunday' })).toBe(false)
    expect(isIssueEnabled(c, { level: 'warning', code: 'atp' })).toBe(true)
  })
})

describe('historyNeeds', () => {
  it('reflects history rules and master switch', () => {
    expect(historyNeeds(DEFAULT_ORDER_CHECK_CONFIG)).toEqual({ duplicates: true, items: true })
    expect(historyNeeds(parseOrderCheckConfig({ rules: { dupOrder: false, qtyAnomaly: false } }))).toEqual({ duplicates: false, items: true })
    expect(historyNeeds(parseOrderCheckConfig({ enabled: false }))).toEqual({ duplicates: false, items: false })
  })
})
