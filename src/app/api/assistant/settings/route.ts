import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { encryptSecret } from '@/lib/fm-crypto'
import { createLlmCall, LlmError, normalizeBaseUrl } from '@/lib/assistant/llm'
import { loadAssistantSettings } from '@/lib/assistant/config'

// ============================================================
// GET/PUT /api/assistant/settings — cấu hình máy chủ LLM nội bộ cho trợ lý.
// POST /api/assistant/settings — kiểm tra kết nối (gửi 1 câu "ping" ngắn).
// Quyền: settings.view (GET) / settings.edit (PUT, POST). Key không bao giờ trả về.
// ============================================================

const publicView = (s: Awaited<ReturnType<typeof loadAssistantSettings>>) =>
  ({ enabled: s.enabled, baseUrl: s.baseUrl, model: s.model, hasKey: s.hasKey })

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  // Mọi người dùng trợ lý cần biết trợ lý có bật không; chi tiết máy chủ chỉ cho người xem cài đặt
  const s = await loadAssistantSettings()
  if (!user.permissions.settings?.view) return NextResponse.json({ data: { enabled: s.enabled } })
  return NextResponse.json({ data: publicView(s) })
}

export async function PUT(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa cài đặt' }, { status: 403 })
  }
  let body: { enabled?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown; clearKey?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 }) }

  const rawUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
  const baseUrl = rawUrl ? normalizeBaseUrl(rawUrl) : ''
  if (baseUrl === null) {
    return NextResponse.json({ error: 'URL máy chủ không hợp lệ (cần http(s)://host:port/v1, không kèm user/mật khẩu)' }, { status: 400 })
  }
  const model = typeof body.model === 'string' ? body.model.trim().slice(0, 200) : ''
  const enabled = body.enabled === true
  if (enabled && (!baseUrl || !model)) {
    return NextResponse.json({ error: 'Cần nhập URL máy chủ và tên model trước khi bật trợ lý' }, { status: 400 })
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

  const existing = await prisma.appSettings.findUnique({ where: { id: 'main' }, select: { assistantKeyEnc: true } })
  const data = {
    assistantEnabled: enabled,
    assistantBaseUrl: baseUrl,
    assistantModel: model,
    // Để trống = giữ key cũ; clearKey = xoá key
    assistantKeyEnc: body.clearKey === true ? '' : apiKey ? encryptSecret(apiKey) : existing?.assistantKeyEnc ?? '',
  }
  await prisma.appSettings.upsert({ where: { id: 'main' }, update: data, create: { id: 'main', ...data } })
  return NextResponse.json({ ok: true, data: publicView(await loadAssistantSettings()) })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa cài đặt' }, { status: 403 })
  }
  const s = await loadAssistantSettings()
  const baseUrl = normalizeBaseUrl(s.baseUrl)
  if (!baseUrl || !s.model) return NextResponse.json({ error: 'Chưa lưu URL máy chủ và tên model' }, { status: 400 })
  const started = Date.now()
  try {
    const reply = await createLlmCall({ baseUrl, model: s.model, apiKey: s.apiKey || undefined, timeoutMs: 30_000 })(
      [{ role: 'user', content: 'Trả lời đúng 1 từ: OK' }], [],
    )
    return NextResponse.json({ ok: true, ms: Date.now() - started, sample: reply.content.slice(0, 60) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof LlmError ? e.message : 'Kiểm tra kết nối thất bại' }, { status: 502 })
  }
}
