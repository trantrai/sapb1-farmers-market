// ============================================================
// CLIENT LLM ON-PREMISE — gọi máy chủ nội bộ có API chuẩn OpenAI
// (POST {baseUrl}/chat/completions: vLLM, Ollama, llama.cpp server, LM Studio…).
// Không gửi dữ liệu ra ngoài: baseUrl do admin cấu hình, trỏ vào mạng nội bộ.
// ============================================================

export interface LlmToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface LlmToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface LlmReply {
  content: string
  toolCalls: LlmToolCall[]
  finishReason: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface LlmConfig {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
}

export type LlmCall = (messages: LlmMessage[], tools: LlmToolSpec[]) => Promise<LlmReply>

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'LlmError'
  }
}

/** Chuẩn hoá baseUrl: http(s) hợp lệ, bỏ "/" cuối, bỏ hậu tố /chat/completions nếu admin dán nhầm */
export function normalizeBaseUrl(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null // không nhận credential trong URL
    return s
  } catch {
    return null
  }
}

/** Một số model (GLM, Qwen…) trả kèm khối suy luận <think>…</think> trong content — bỏ đi */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim()
}

/** Ollama/llama.cpp có thể trả arguments là object thay vì chuỗi JSON — chuẩn hoá về chuỗi */
export function parseReply(json: unknown): LlmReply {
  const j = json as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown[] }; finish_reason?: string }[]
    usage?: LlmReply['usage']
  }
  const choice = j?.choices?.[0]
  if (!choice?.message) throw new LlmError('Máy chủ LLM trả về dữ liệu không đúng định dạng')
  const raw = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : []
  const toolCalls: LlmToolCall[] = raw.flatMap((c, i) => {
    const call = c as { id?: string; function?: { name?: unknown; arguments?: unknown } }
    const name = typeof call?.function?.name === 'string' ? call.function.name : ''
    if (!name) return []
    const args = call.function?.arguments
    return [{
      id: call.id || `call_${i}`,
      type: 'function' as const,
      function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
    }]
  })
  const content = typeof choice.message.content === 'string' ? stripThinking(choice.message.content) : ''
  return { content, toolCalls, finishReason: choice.finish_reason ?? '', usage: j.usage }
}

export function createLlmCall(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): LlmCall {
  return async (messages, tools) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 90_000)
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          temperature: 0.2,
          stream: false,
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        // Không trả nguyên body lỗi lên UI (có thể chứa thông tin máy chủ) — chỉ mã HTTP
        throw new LlmError(`Máy chủ LLM nội bộ trả lỗi HTTP ${res.status}`, res.status)
      }
      return parseReply(await res.json())
    } catch (e) {
      if (e instanceof LlmError) throw e
      if ((e as Error)?.name === 'AbortError') throw new LlmError('Máy chủ LLM nội bộ phản hồi quá lâu (timeout)')
      throw new LlmError('Không kết nối được máy chủ LLM nội bộ')
    } finally {
      clearTimeout(timer)
    }
  }
}
