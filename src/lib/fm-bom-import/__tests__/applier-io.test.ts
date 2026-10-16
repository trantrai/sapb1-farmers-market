// Test realB1IO: mọi call qua Service Layer phải gắn audit 'always' + retryOf=runId (F7)
import { describe, expect, it, vi } from 'vitest'

const seen: { fn: string; opts: unknown }[] = []

vi.mock('../../sap-service-layer', () => ({
  sapGet: async (_c: unknown, _p: string, _q: unknown, opts: unknown) => {
    seen.push({ fn: 'get', opts })
    return { ok: true, status: 200, data: {} }
  },
  sapPost: async (_c: unknown, _p: string, _b: unknown, opts: unknown) => {
    seen.push({ fn: 'post', opts })
    return { ok: true, status: 201, data: {} }
  },
  sapDelete: async (_c: unknown, _p: string, opts: unknown) => {
    seen.push({ fn: 'del', opts })
    return { ok: true, status: 204 }
  },
}))

import { realB1IO } from '../applier'

const CFG = { serviceLayerUrl: 'https://sl.test:50000/b1s/v2', companyDb: 'TESTDB', sapUser: 'u', sapPassword: 'p' }

describe('realB1IO', () => {
  it('get/post/del đều truyền { audit: "always", retryOf: runId }', async () => {
    seen.length = 0
    const io = realB1IO(CFG, 'runX')
    await io.get('/Items', { $select: 'ItemCode' })
    await io.post('/Items', { ItemCode: 'A' })
    await io.del('/Items')
    expect(seen.map((s) => s.fn)).toEqual(['get', 'post', 'del'])
    for (const s of seen) {
      expect(s.opts).toMatchObject({ audit: 'always', retryOf: 'runX' })
    }
  })
})
