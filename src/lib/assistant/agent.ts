// ============================================================
// VÒNG LẶP TRỢ LÝ — gửi hội thoại + danh sách công cụ cho LLM; model gọi
// công cụ (chỉ đọc DB nội bộ / soạn nháp đơn) → trả kết quả → lặp tới khi có
// câu trả lời, tối đa maxRounds vòng. Thuần: LLM và công cụ được tiêm vào.
// ============================================================

import type { LlmCall, LlmMessage, LlmToolSpec } from './llm'

export interface DraftLine {
  itemCode: string
  itemName: string
  quantity: number
  uom?: string | null
  price?: number | null
  taxCode?: string | null
  vatRate?: number | null
  barcode?: string | null
}

/** Nháp đơn trợ lý đề xuất — UI đổ vào form tạo đơn, người dùng tự kiểm tra rồi bấm Lưu */
export interface OrderDraft {
  cardCode: string
  cardName: string
  lines: DraftLine[]
}

export interface ToolOutcome {
  result: unknown
  draft?: OrderDraft
}

export interface ToolRegistry {
  specs: LlmToolSpec[]
  run: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

export interface AssistantResult {
  reply: string
  draft?: OrderDraft
  toolsUsed: string[]
  usage: { prompt: number; completion: number }
}

/** Kết quả công cụ có thể lớn — cắt bớt để không tràn context model nội bộ */
const MAX_TOOL_RESULT_CHARS = 6000

export async function runAssistant({ llm, tools, system, history, maxRounds = 5 }: {
  llm: LlmCall
  tools: ToolRegistry
  system: string
  history: ChatTurn[]
  maxRounds?: number
}): Promise<AssistantResult> {
  const messages: LlmMessage[] = [{ role: 'system', content: system }, ...history]
  const toolsUsed: string[] = []
  const usage = { prompt: 0, completion: 0 }
  let draft: OrderDraft | undefined

  for (let round = 0; round <= maxRounds; round++) {
    // Vòng cuối: không đưa công cụ → buộc model trả lời bằng dữ liệu đã có
    const reply = await llm(messages, round < maxRounds ? tools.specs : [])
    usage.prompt += reply.usage?.prompt_tokens ?? 0
    usage.completion += reply.usage?.completion_tokens ?? 0

    if (reply.toolCalls.length === 0 || round === maxRounds) {
      return {
        reply: reply.content || 'Xin lỗi, tôi chưa có câu trả lời cho yêu cầu này.',
        draft,
        toolsUsed,
        usage,
      }
    }

    messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls })
    for (const call of reply.toolCalls) {
      toolsUsed.push(call.function.name)
      let payload: unknown
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new SyntaxError('args')
        const out = await tools.run(call.function.name, args as Record<string, unknown>)
        if (out.draft) draft = out.draft
        payload = out.result
      } catch (e) {
        // Không đưa chi tiết lỗi nội bộ (Prisma/stack) vào hội thoại
        if (!(e instanceof SyntaxError)) console.error(`assistant tool ${call.function.name} failed:`, (e as Error)?.name)
        payload = { error: e instanceof SyntaxError ? 'Tham số công cụ không phải JSON hợp lệ' : 'Công cụ lỗi khi truy vấn dữ liệu' }
      }
      let content = JSON.stringify(payload)
      if (content.length > MAX_TOOL_RESULT_CHARS) content = `${content.slice(0, MAX_TOOL_RESULT_CHARS)}…(đã cắt bớt)`
      messages.push({ role: 'tool', tool_call_id: call.id, content })
    }
  }
  return { reply: '', draft, toolsUsed, usage } // không tới được: vòng cuối luôn return
}
