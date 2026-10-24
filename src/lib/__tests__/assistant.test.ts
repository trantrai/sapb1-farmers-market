// ============================================================
// Trợ lý sale admin (LLM on-premise):
// - Client OpenAI-compatible: chuẩn hoá URL, parse tool_calls (chuỗi/obj), bỏ <think>
// - Vòng lặp công cụ: gọi công cụ → trả kết quả → câu trả lời; giới hạn vòng; lỗi JSON
// - RBAC: công cụ theo quyền; công cụ không được phép bị từ chối
// - Nháp đơn: khớp mặt hàng → draft; mơ hồ / không thấy → không tạo draft
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const bpFindFirst = vi.fn()
const itemFindMany = vi.fn()
vi.mock('@/lib/db', () => ({
  db: {
    businessPartner: { findFirst: (...a: unknown[]) => bpFindFirst(...a), findMany: vi.fn() },
    item: { findMany: (...a: unknown[]) => itemFindMany(...a) },
    vatGroup: { findMany: async () => [{ code: 'S8', rate: 8, category: 'S' }] },
  },
}))

import { createLlmCall, listModels, normalizeBaseUrl, parseReply, stripThinking, type LlmCall, type LlmReply } from '@/lib/assistant/llm'
import { runAssistant, type ToolRegistry } from '@/lib/assistant/agent'
import { allowedTools, createToolRegistry } from '@/lib/assistant/tools'
import { takeRateLimit } from '@/lib/assistant/config'
import type { PermMap } from '@/lib/fm-shared'

const perm = (p: Partial<Record<string, Partial<Record<'view' | 'create' | 'edit' | 'delete', boolean>>>>) => p as unknown as PermMap
const reply = (content: string, calls: [string, unknown][] = []): LlmReply => ({
  content,
  finishReason: calls.length ? 'tool_calls' : 'stop',
  toolCalls: calls.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })),
})

describe('llm client', () => {
  it('chuẩn hoá baseUrl, từ chối URL không phải http(s) hoặc có credential', () => {
    expect(normalizeBaseUrl('http://10.0.0.5:8000/v1/')).toBe('http://10.0.0.5:8000/v1')
    expect(normalizeBaseUrl('http://host:11434/v1/chat/completions')).toBe('http://host:11434/v1')
    expect(normalizeBaseUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeBaseUrl('http://u:p@host/v1')).toBeNull()
    expect(normalizeBaseUrl('không phải url')).toBeNull()
  })

  it('parse tool_calls dạng chuỗi lẫn object (Ollama) và bỏ khối <think>', () => {
    const r = parseReply({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '<think>suy luận</think>Đang tra',
          tool_calls: [
            { id: 'a', function: { name: 'find_items', arguments: '{"query":"cà chua"}' } },
            { function: { name: 'find_customers', arguments: { query: 'C2' } } },
            { function: { arguments: '{}' } },
          ],
        },
      }],
    })
    expect(r.content).toBe('Đang tra')
    expect(r.toolCalls).toEqual([
      { id: 'a', type: 'function', function: { name: 'find_items', arguments: '{"query":"cà chua"}' } },
      { id: 'call_1', type: 'function', function: { name: 'find_customers', arguments: '{"query":"C2"}' } },
    ])
    expect(stripThinking('a</think>  Kết quả')).toBe('Kết quả')
    expect(() => parseReply({})).toThrow()
  })

  it('gửi đúng endpoint/model/key, lỗi HTTP không lộ body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 }))
    const call = createLlmCall({ baseUrl: 'http://llm:8000/v1', model: 'glm-x', apiKey: 'k' }, fetchImpl as unknown as typeof fetch)
    expect((await call([{ role: 'user', content: 'hi' }], [])).content).toBe('OK')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://llm:8000/v1/chat/completions')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'glm-x', stream: false })
    expect(JSON.parse(String(init.body)).tools).toBeUndefined()
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')

    const bad = createLlmCall({ baseUrl: 'http://llm/v1', model: 'm' }, (async () => new Response('secret stack', { status: 500 })) as unknown as typeof fetch)
    await expect(bad([{ role: 'user', content: 'x' }], [])).rejects.toThrow('HTTP 500')
  })
})

describe('listModels', () => {
  it('lấy id model từ GET /models (chuẩn OpenAI), sắp xếp', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.1:8b' }, { foo: 1 }] })))
    expect(await listModels({ baseUrl: 'http://localhost:11434/v1' }, fetchImpl as unknown as typeof fetch)).toEqual(['llama3.1:8b', 'qwen2.5:7b'])
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('http://localhost:11434/v1/models')
    const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    await expect(listModels({ baseUrl: 'http://x/v1' }, down)).rejects.toThrow('Không kết nối được')
  })
})

describe('runAssistant', () => {
  const tools: ToolRegistry = {
    specs: [{ type: 'function', function: { name: 'find_items', description: '', parameters: {} } }],
    run: vi.fn(async (_name, args) => ({ result: { items: [{ itemCode: 'A', q: args.query }] } })),
  }

  it('gọi công cụ, đưa kết quả về model, trả câu trả lời cuối', async () => {
    const llm = vi.fn<LlmCall>()
      .mockResolvedValueOnce(reply('', [['find_items', { query: 'cà chua' }]]))
      .mockResolvedValueOnce(reply('Có mặt hàng A'))
    const out = await runAssistant({ llm, tools, system: 'sys', history: [{ role: 'user', content: 'tìm cà chua' }] })
    expect(out).toMatchObject({ reply: 'Có mặt hàng A', toolsUsed: ['find_items'] })
    const second = llm.mock.calls[1][0]
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c0' })
    expect(JSON.parse((second.at(-1) as { content: string }).content)).toEqual({ items: [{ itemCode: 'A', q: 'cà chua' }] })
  })

  it('tham số không phải JSON → báo lỗi cho model, không gọi công cụ', async () => {
    const run = vi.fn()
    const llm = vi.fn<LlmCall>()
      .mockResolvedValueOnce(reply('', [['find_items', '{oops']]))
      .mockResolvedValueOnce(reply('Xin lỗi'))
    await runAssistant({ llm, tools: { ...tools, run }, system: 's', history: [{ role: 'user', content: 'x' }] })
    expect(run).not.toHaveBeenCalled()
    expect(llm.mock.calls[1][0].at(-1)).toMatchObject({ content: expect.stringContaining('JSON') })
  })

  it('vượt số vòng → vòng cuối không đưa công cụ, vẫn có câu trả lời', async () => {
    const llm = vi.fn<LlmCall>(async (_m, specs) => (specs.length ? reply('', [['find_items', {}]]) : reply('Tổng hợp')))
    const out = await runAssistant({ llm, tools, system: 's', history: [{ role: 'user', content: 'x' }], maxRounds: 2 })
    expect(out.reply).toBe('Tổng hợp')
    expect(llm).toHaveBeenCalledTimes(3)
    expect(llm.mock.calls[2][1]).toEqual([])
  })
})

describe('công cụ & quyền', () => {
  beforeEach(() => {
    bpFindFirst.mockReset()
    itemFindMany.mockReset()
  })

  it('chỉ đưa công cụ theo quyền', () => {
    const names = (p: PermMap) => allowedTools(p).map((t) => t.function.name)
    expect(names(perm({ ordersNew: { create: true } }))).toEqual(['find_customers', 'customer_summary', 'find_items', 'prepare_order_draft'])
    expect(names(perm({ orders: { view: true } }))).not.toContain('prepare_order_draft')
    expect(names(perm({}))).toEqual([])
  })

  it('công cụ ngoài quyền bị từ chối khi model cố gọi', async () => {
    const reg = createToolRegistry({ permissions: perm({ orders: { view: true } }), dbId: 'db1', today: '2026-10-24' })
    const out = await reg.run('prepare_order_draft', { cardCode: 'C1', lines: [] })
    expect(out.draft).toBeUndefined()
    expect(out.result).toMatchObject({ error: expect.stringContaining('không có quyền') })
  })

  it('nháp đơn: khớp hết → draft; mơ hồ/không thấy → chỉ báo vấn đề', async () => {
    bpFindFirst.mockResolvedValue({ cardCode: 'C20001', cardName: 'Cửa hàng A' })
    itemFindMany.mockResolvedValue([
      { itemCode: 'FM-RAU-002', itemName: 'Cà chua bi Đà Lạt', uom: 'kg', price: 45000, taxCode: 'S8', barcode: '893', stock: 10 },
      { itemCode: 'FM-RAU-005', itemName: 'Cà chua thường', uom: 'kg', price: 20000, taxCode: 'S8', barcode: '', stock: 0 },
      { itemCode: 'FM-RAU-001', itemName: 'Rau cải ngọt hữu cơ', uom: 'kg', price: 31000, taxCode: 'S8', barcode: '', stock: 5 },
    ])
    const reg = createToolRegistry({ permissions: perm({ ordersNew: { create: true } }), dbId: 'db1', today: '2026-10-24' })
    const ok = await reg.run('prepare_order_draft', { cardCode: 'C20001', lines: [{ item: 'cà chua bi', quantity: 10 }, { item: '893', quantity: 2 }, { item: 'cải ngọt', quantity: 5 }] })
    expect(ok.draft).toMatchObject({
      cardCode: 'C20001',
      lines: [
        { itemCode: 'FM-RAU-002', quantity: 10, price: 45000, vatRate: 8 },
        { itemCode: 'FM-RAU-002', quantity: 2 },
        { itemCode: 'FM-RAU-001', quantity: 5 },
      ],
    })
    const bad = await reg.run('prepare_order_draft', { cardCode: 'C20001', lines: [{ item: 'cà chua', quantity: 1 }, { item: 'sầu riêng', quantity: 1 }, { item: 'cải ngọt', quantity: -1 }] })
    expect(bad.draft).toBeUndefined()
    expect((bad.result as { problems: string[] }).problems).toEqual([
      expect.stringContaining('khớp nhiều mặt hàng'),
      expect.stringContaining('không tìm thấy'),
      expect.stringContaining('số lượng không hợp lệ'),
    ])
    bpFindFirst.mockResolvedValue(null)
    expect((await reg.run('prepare_order_draft', { cardCode: 'X', lines: [{ item: 'a', quantity: 1 }] })).result).toMatchObject({ error: expect.stringContaining('Không tìm thấy khách hàng') })
  })
})

describe('giới hạn lượt hỏi', () => {
  it('12 lượt/phút/người dùng', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 12; i++) expect(takeRateLimit('u-rate', t0 + i)).toBe(true)
    expect(takeRateLimit('u-rate', t0 + 100)).toBe(false)
    expect(takeRateLimit('u-other', t0 + 100)).toBe(true)
    expect(takeRateLimit('u-rate', t0 + 61_000)).toBe(true)
  })
})
