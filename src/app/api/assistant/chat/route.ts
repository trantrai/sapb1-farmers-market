import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { createLlmCall, isExternalUrl, LlmError } from '@/lib/assistant/llm'
import { runAssistant, type ChatTurn } from '@/lib/assistant/agent'
import { createToolRegistry } from '@/lib/assistant/tools'
import { buildSystemPrompt, loadAssistantSettings, takeRateLimit, toLlmConfig } from '@/lib/assistant/config'

// ============================================================
// POST /api/assistant/chat  { messages: [{ role: 'user'|'assistant', content }] }
// Trợ lý sale admin: LLM nội bộ hoặc cloud (API chuẩn OpenAI) + công cụ chỉ
// đọc DB nội bộ theo RBAC. Cloud: che SĐT/địa chỉ/ghi chú. Trả { reply, draft? }.
// Không log nội dung hội thoại — chỉ log số token / công cụ đã dùng.
// ============================================================

const MAX_TURNS = 16
const MAX_CHARS = 4000

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view && !user.permissions.ordersNew?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền dùng trợ lý (cần quyền xem hoặc tạo đơn hàng)' }, { status: 403 })
  }

  const settings = await loadAssistantSettings()
  const cfg = toLlmConfig(settings)
  if (!cfg) {
    return NextResponse.json({ error: 'Trợ lý chưa được bật hoặc chưa cấu hình máy chủ LLM nội bộ (Cài đặt → Trợ lý sale admin)', code: 'not_configured' }, { status: 503 })
  }
  if (!takeRateLimit(user.id)) {
    return NextResponse.json({ error: 'Bạn hỏi quá nhanh — vui lòng đợi ít phút rồi thử lại' }, { status: 429 })
  }

  let body: { messages?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 }) }
  const history: ChatTurn[] = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m): m is ChatTurn =>
      !!m && typeof m === 'object'
      && ((m as ChatTurn).role === 'user' || (m as ChatTurn).role === 'assistant')
      && typeof (m as ChatTurn).content === 'string' && (m as ChatTurn).content.trim() !== '')
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Thiếu câu hỏi' }, { status: 400 })
  }
  // Hội thoại phải bắt đầu bằng lượt người dùng
  while (history.length && history[0].role !== 'user') history.shift()

  const s = await loadSapSettings(user.databaseId)
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' })
  // LLM ở cloud → che dữ liệu cá nhân trong kết quả công cụ
  const tools = createToolRegistry({ permissions: user.permissions, dbId: s?.dbId ?? null, today, redactPii: isExternalUrl(cfg.baseUrl) })

  try {
    const out = await runAssistant({
      llm: createLlmCall(cfg),
      tools,
      system: buildSystemPrompt({
        userName: user.fullName || user.username,
        databaseLabel: user.databaseLabel,
        today,
        canDraft: Boolean(user.permissions.ordersNew?.create),
      }),
      history,
    })
    console.info(`assistant: user=${user.id} tools=${out.toolsUsed.join(',') || '-'} tokens=${out.usage.prompt}/${out.usage.completion}`)
    return NextResponse.json({ reply: out.reply, draft: out.draft ?? null })
  } catch (e) {
    if (e instanceof LlmError) return NextResponse.json({ error: e.message }, { status: 502 })
    console.error('POST /api/assistant/chat', (e as Error)?.name)
    return NextResponse.json({ error: 'Trợ lý gặp lỗi, vui lòng thử lại' }, { status: 500 })
  }
}
