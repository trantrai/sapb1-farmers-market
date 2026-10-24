import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { listModels, LlmError, normalizeBaseUrl } from '@/lib/assistant/llm'
import { loadAssistantSettings } from '@/lib/assistant/config'

// ============================================================
// GET /api/assistant/models — danh sách model trên máy chủ LLM nội bộ ĐÃ LƯU
// (GET {baseUrl}/models), để admin chọn model free đã tải (vd qua Ollama).
// Quyền: settings.edit.
// ============================================================

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa cài đặt' }, { status: 403 })
  }
  const s = await loadAssistantSettings()
  const baseUrl = normalizeBaseUrl(s.baseUrl)
  if (!baseUrl) return NextResponse.json({ error: 'Chưa lưu URL máy chủ' }, { status: 400 })
  try {
    return NextResponse.json({ data: await listModels({ baseUrl, apiKey: s.apiKey || undefined }) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof LlmError ? e.message : 'Không tải được danh sách model' }, { status: 502 })
  }
}
