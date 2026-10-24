// ============================================================
// CLIENT LLM — gọi máy chủ có API chuẩn OpenAI (POST {baseUrl}/chat/completions):
// nội bộ (Ollama, vLLM, llama.cpp, LM Studio) hoặc dịch vụ cloud miễn phí
// (OpenRouter, Groq, Gemini, Zhipu GLM…). Cloud: bắt buộc HTTPS + admin xác nhận
// cho phép gửi dữ liệu ra ngoài (xem config.ts), dữ liệu cá nhân được che (tools.ts).
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

/** Lỗi HTTP → thông điệp tiếng Việt (không trả nguyên body: có thể chứa thông tin máy chủ) */
export function httpError(status: number): LlmError {
  if (status === 401 || status === 403) return new LlmError(`API key máy chủ LLM không hợp lệ hoặc hết quyền (HTTP ${status})`, status)
  if (status === 429) return new LlmError('Dịch vụ LLM đang giới hạn lượt gọi (gói miễn phí) — thử lại sau ít phút', status)
  if (status === 404) return new LlmError('Không tìm thấy model hoặc đường dẫn API (HTTP 404) — kiểm tra URL và tên model', status)
  return new LlmError(`Máy chủ LLM trả lỗi HTTP ${status}`, status)
}

/** Máy chủ trong mạng nội bộ? (localhost, IP private, tên 1 nhãn, .local/.lan/.internal/.home.arpa) */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1' || !h.includes('.') && !h.includes(':')) return true
  if (/\.(local|lan|internal|intranet|home\.arpa)$/.test(h)) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)
}

/** URL trỏ ra dịch vụ bên ngoài (cloud) — dữ liệu rời mạng nội bộ */
export function isExternalUrl(baseUrl: string): boolean {
  try { return !isPrivateHost(new URL(baseUrl).hostname) } catch { return true }
}

/** Chuẩn hoá baseUrl: http(s) hợp lệ, bỏ "/" cuối, bỏ hậu tố /chat/completions nếu admin dán nhầm */
export function normalizeBaseUrl(raw: string): string | null {
  const s = raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null // không nhận credential trong URL
    // Dịch vụ bên ngoài bắt buộc HTTPS (API key + dữ liệu đi qua Internet)
    if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) return null
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

/** Danh sách model máy chủ đang phục vụ (GET {baseUrl}/models — Ollama, vLLM, LM Studio đều hỗ trợ) */
export async function listModels(cfg: Omit<LlmConfig, 'model'>, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 10_000)
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: ctrl.signal,
    })
    if (!res.ok) throw httpError(res.status)
    const j = (await res.json()) as { data?: { id?: unknown }[] }
    return (Array.isArray(j?.data) ? j.data : [])
      .map((m) => (typeof m?.id === 'string' ? m.id : ''))
      .filter(Boolean)
      .sort()
  } catch (e) {
    if (e instanceof LlmError) throw e
    if ((e as Error)?.name === 'AbortError') throw new LlmError('Máy chủ LLM phản hồi quá lâu (timeout)')
    throw new LlmError('Không kết nối được máy chủ LLM')
  } finally {
    clearTimeout(timer)
  }
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
        throw httpError(res.status)
      }
      return parseReply(await res.json())
    } catch (e) {
      if (e instanceof LlmError) throw e
      if ((e as Error)?.name === 'AbortError') throw new LlmError('Máy chủ LLM phản hồi quá lâu (timeout)')
      throw new LlmError('Không kết nối được máy chủ LLM')
    } finally {
      clearTimeout(timer)
    }
  }
}
