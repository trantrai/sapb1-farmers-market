// ============================================================
// Đợt 2 — chống trùng & tự thử lại khi đẩy đơn sang SAP B1:
// phân loại lỗi, UDF marker, lịch backoff, xếp hạng ứng viên đối chiếu,
// và sapPost login lại đúng 1 lần khi 401.
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/sap-audit', () => ({ logSapAudit: async () => {} }))

import {
  classifySapPostFailure,
  isAutoRetryable,
  nextRetryState,
  rankSapCandidates,
  SAP_RETRY_MAX_ATTEMPTS,
  withMarker,
} from '@/lib/sap-sync-retry'
import { fetchFailKind, sapClearSessions, sapPost } from '@/lib/sap-service-layer'

describe('classifySapPostFailure', () => {
  it('chưa tới SAP → safe', () => {
    expect(classifySapPostFailure({ status: 0, failKind: 'login' })).toBe('safe')
    expect(classifySapPostFailure({ status: 0, failKind: 'connect' })).toBe('safe')
    expect(classifySapPostFailure({ status: 401 })).toBe('safe')
    expect(classifySapPostFailure({ status: 429 })).toBe('safe')
  })
  it('có thể đã ghi → unknown', () => {
    expect(classifySapPostFailure({ status: 0, failKind: 'timeout' })).toBe('unknown')
    expect(classifySapPostFailure({ status: 0, failKind: 'network' })).toBe('unknown')
    expect(classifySapPostFailure({ status: 0 })).toBe('unknown')
    expect(classifySapPostFailure({ status: 408 })).toBe('unknown')
    expect(classifySapPostFailure({ status: 502 })).toBe('unknown')
  })
  it('SAP từ chối dữ liệu → business', () => {
    expect(classifySapPostFailure({ status: 400 })).toBe('business')
    expect(classifySapPostFailure({ status: 404 })).toBe('business')
  })
})

describe('withMarker / isAutoRetryable', () => {
  it('unknown không UDF → reconcile; có UDF giữ unknown', () => {
    expect(withMarker('unknown', false)).toBe('reconcile')
    expect(withMarker('unknown', true)).toBe('unknown')
    expect(withMarker('safe', false)).toBe('safe')
    expect(withMarker('business', false)).toBe('business')
  })
  it('chỉ safe/unknown được tự thử', () => {
    expect(isAutoRetryable('safe')).toBe(true)
    expect(isAutoRetryable('unknown')).toBe(true)
    expect(isAutoRetryable('reconcile')).toBe(false)
    expect(isAutoRetryable('business')).toBe(false)
    expect(isAutoRetryable(null)).toBe(false)
  })
})

describe('nextRetryState', () => {
  const now = new Date('2026-10-24T03:00:00Z')
  const mins = (d: Date | null) => (d ? (d.getTime() - now.getTime()) / 60_000 : null)

  it('thành công → xoá trạng thái lỗi', () => {
    expect(nextRetryState({ ok: true }, 3, true, now)).toEqual({ sapSyncErrorKind: null, sapSyncAttempts: 0, sapNextRetryAt: null, sapSyncLastAt: now })
  })
  it('đẩy tay / tạo đơn: đếm lại từ 0, thử sau 2 phút', () => {
    const r = nextRetryState({ ok: false, kind: 'safe' }, 4, false, now)
    expect(r.sapSyncAttempts).toBe(0)
    expect(mins(r.sapNextRetryAt)).toBe(2)
  })
  it('job nền: backoff 5, 15, 60, 240 rồi dừng', () => {
    const got = [0, 1, 2, 3, 4].map((p) => mins(nextRetryState({ ok: false, kind: 'unknown' }, p, true, now).sapNextRetryAt))
    expect(got).toEqual([5, 15, 60, 240, null])
    expect(nextRetryState({ ok: false, kind: 'unknown' }, SAP_RETRY_MAX_ATTEMPTS - 1, true, now).sapSyncAttempts).toBe(SAP_RETRY_MAX_ATTEMPTS)
  })
  it('reconcile / business: không đặt lịch', () => {
    expect(nextRetryState({ ok: false, kind: 'reconcile' }, 0, false, now).sapNextRetryAt).toBeNull()
    expect(nextRetryState({ ok: false, kind: 'business' }, 0, false, now).sapNextRetryAt).toBeNull()
    expect(nextRetryState({ ok: false }, 0, false, now).sapSyncErrorKind).toBe('business')
  })
})

describe('rankSapCandidates', () => {
  it('đơn khớp tổng tiền (trong dung sai) + ngày giao lên đầu', () => {
    const r = rankSapCandidates({ grandTotal: 1_000_000, docDueDate: '2026-10-25T00:00:00.000Z' }, [
      { DocEntry: 30, DocTotal: 2_000_000, DocDueDate: '2026-10-25' },
      { DocEntry: 10, DocTotal: 1_004_000, DocDueDate: '2026-10-25' },
      { DocEntry: 20, DocTotal: 1_000_000, DocDueDate: '2026-10-26' },
    ])
    expect(r.map((x) => x.DocEntry)).toEqual([10, 20, 30])
    expect(r[0]).toMatchObject({ totalMatch: true, dueMatch: true, totalDiff: 4000 })
    expect(r[1]).toMatchObject({ totalMatch: true, dueMatch: false })
  })
  it('chỉ khớp tổng tiền xếp trên chỉ khớp ngày giao', () => {
    const r = rankSapCandidates({ grandTotal: 500_000, docDueDate: '2026-10-25' }, [
      { DocEntry: 9, DocTotal: 100_000, DocDueDate: '2026-10-25' },
      { DocEntry: 3, DocTotal: 500_000, DocDueDate: '2026-11-01' },
    ])
    expect(r.map((x) => x.DocEntry)).toEqual([3, 9])
  })
})

describe('fetchFailKind', () => {
  it('phân biệt connect / timeout / network', () => {
    expect(fetchFailKind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('connect')
    expect(fetchFailKind(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(fetchFailKind(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe('network')
  })
})

describe('sapPost — 401 login lại 1 lần', () => {
  const cfg = { serviceLayerUrl: 'https://sap.test:50000/b1s/v2', companyDb: 'TEST', sapUser: 'svc', sapPassword: 'x', dbId: 'db-401' }
  const loginRes = () =>
    new Response(JSON.stringify({ SessionId: 's', SessionTimeout: 30 }), { status: 200, headers: { 'Set-Cookie': 'B1SESSION=abc; Path=/' } })
  afterEach(() => {
    vi.unstubAllGlobals()
    sapClearSessions()
  })

  it('401 → login lại → gửi lại thành công', async () => {
    const calls: string[] = []
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url).replace(cfg.serviceLayerUrl, ''))
      if (String(url).endsWith('/Login')) return loginRes()
      posts++
      return posts === 1
        ? new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ DocEntry: 7, DocNum: 70 }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }))
    const r = await sapPost(cfg, '/Orders', { CardCode: 'C1' })
    expect(r).toMatchObject({ ok: true, data: { DocEntry: 7 } })
    expect(calls).toEqual(['/Login', '/Orders', '/Login', '/Orders'])
  })

  it('401 hai lần → dừng, không thử lần 3', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/Login') ? loginRes() : new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const r = await sapPost(cfg, '/Orders', { CardCode: 'C1' })
    expect(r).toMatchObject({ ok: false, status: 401 })
    expect(classifySapPostFailure(r)).toBe('safe')
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/Orders'))).toHaveLength(2)
  })

  it('login lỗi → failKind login (safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }))
    const r = await sapPost(cfg, '/Orders', {})
    expect(r).toMatchObject({ ok: false, status: 0, failKind: 'login' })
    expect(classifySapPostFailure(r)).toBe('safe')
  })
})
