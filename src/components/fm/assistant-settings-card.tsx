'use client'

// ============================================================
// CÀI ĐẶT → TRỢ LÝ SALE ADMIN: máy chủ LLM có API chuẩn OpenAI — nội bộ
// (Ollama…) hoặc dịch vụ cloud miễn phí (OpenRouter, Groq, Gemini, Zhipu GLM).
// Cloud: bắt buộc HTTPS + admin tick xác nhận gửi dữ liệu ra ngoài.
// ============================================================

import { useEffect, useState } from 'react'
import { Bot, ListRestart, PlugZap, Save } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { isExternalUrl } from '@/lib/assistant/llm'

interface Cfg { enabled: boolean; baseUrl: string; model: string; hasKey: boolean; allowCloud: boolean; external?: boolean }

/** Máy chủ LLM miễn phí. Nội bộ: "localhost" = chính máy chạy hệ thống này.
 *  Cloud: cần đăng ký lấy API key; gói miễn phí giới hạn lượt gọi, model free thay đổi theo thời gian. */
const PRESETS = [
  { key: 'ollama', group: 'local', label: 'Ollama (dễ cài nhất)', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { key: 'lmstudio', group: 'local', label: 'LM Studio (có giao diện)', url: 'http://localhost:1234/v1', model: '' },
  { key: 'llamacpp', group: 'local', label: 'llama.cpp server', url: 'http://localhost:8080/v1', model: '' },
  { key: 'vllm', group: 'local', label: 'vLLM (máy chủ GPU)', url: 'http://localhost:8000/v1', model: '' },
  { key: 'zhipu', group: 'cloud', label: 'Zhipu GLM (bigmodel.cn)', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { key: 'openrouter', group: 'cloud', label: 'OpenRouter (model đuôi ":free")', url: 'https://openrouter.ai/api/v1', model: '' },
  { key: 'groq', group: 'cloud', label: 'Groq', url: 'https://api.groq.com/openai/v1', model: '' },
  { key: 'gemini', group: 'cloud', label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '' },
] as const

export default function AssistantSettingsCard({ canEdit }: { canEdit: boolean }) {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [saved, setSaved] = useState<Cfg | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [models, setModels] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    api('/api/assistant/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.data) return
        const c: Cfg = { enabled: Boolean(j.data.enabled), baseUrl: j.data.baseUrl ?? '', model: j.data.model ?? '', hasKey: Boolean(j.data.hasKey), allowCloud: Boolean(j.data.allowCloud) }
        setCfg(c); setSaved(c)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!cfg) return null
  const dirty = apiKey !== '' || JSON.stringify(cfg) !== JSON.stringify(saved)

  const save = async (patch?: Partial<Cfg> & { clearKey?: boolean }) => {
    setBusy(true); setMsg(null)
    try {
      const body = { ...cfg, ...patch, apiKey }
      const res = await api('/api/assistant/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      const c: Cfg = { enabled: j.data.enabled, baseUrl: j.data.baseUrl, model: j.data.model, hasKey: j.data.hasKey, allowCloud: j.data.allowCloud }
      setCfg(c); setSaved(c); setApiKey('')
      setMsg({ type: 'ok', text: 'Đã lưu cấu hình trợ lý. Tải lại trang để hiện/ẩn nút trợ lý.' })
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Không lưu được' })
    } finally { setBusy(false) }
  }

  const test = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await api('/api/assistant/settings', { method: 'POST' })
      const j = await res.json().catch(() => null)
      if (!res.ok || !j?.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setMsg({ type: 'ok', text: `Kết nối OK (${j.ms} ms) — model trả lời: "${j.sample}"` })
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Kiểm tra thất bại' })
    } finally { setBusy(false) }
  }

  const loadModels = async () => {
    setBusy(true); setMsg(null)
    try {
      const res = await api('/api/assistant/models')
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      const list: string[] = Array.isArray(j?.data) ? j.data : []
      setModels(list)
      setMsg(list.length
        ? { type: 'ok', text: `Máy chủ có ${list.length} model — chọn ở ô "Tên model".` }
        : { type: 'error', text: 'Máy chủ chưa có model nào — tải model trước (vd: ollama pull qwen2.5:7b).' })
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Không tải được danh sách model' })
    } finally { setBusy(false) }
  }

  const applyPreset = (key: string) => {
    const p = PRESETS.find((x) => x.key === key)
    // Đổi nhà cung cấp → tên model cũ thường không còn đúng
    if (p) setCfg({ ...cfg, baseUrl: p.url, model: p.model })
  }
  const external = cfg.baseUrl.trim() !== '' && isExternalUrl(cfg.baseUrl.trim())

  return (
    <div className="fm-card fm-mt-3">
      <div className="fm-card__head">
        <Bot size={18} /> Trợ lý sale admin (LLM miễn phí)
        {saved?.enabled ? <span className="fm-chip fm-chip--ok">Đang bật</span> : <span className="fm-chip fm-chip--role">Đang tắt</span>}
      </div>
      <div className="fm-card__body">
        <p className="fm-hint">
          Trợ lý dùng máy chủ LLM có API chuẩn OpenAI — <b>miễn phí</b>, chọn 1 trong 2 cách. Trợ lý chỉ đọc dữ liệu theo quyền
          người dùng và soạn nháp đơn — không lưu hay đẩy chứng từ lên SAP. Model phải hỗ trợ <b>tool calling</b>.
        </p>
        <ul className="fm-hint fm-ai-options">
          <li><b>Nội bộ (khuyến nghị):</b> cài Ollama + model mã nguồn mở <code>qwen2.5:7b</code> — dữ liệu không rời mạng công ty.</li>
          <li><b>Cloud miễn phí:</b> Zhipu GLM, OpenRouter, Groq, Gemini — đăng ký lấy API key; không cần máy mạnh nhưng dữ liệu được
            gửi ra nhà cung cấp, gói free giới hạn lượt gọi và có thể dùng dữ liệu để huấn luyện.</li>
        </ul>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-preset">Mẫu nhanh</label>
            <select id="fm-ai-preset" className="fm-input" value="" onChange={(e) => applyPreset(e.target.value)} disabled={!canEdit || busy}>
              <option value="">— Chọn máy chủ LLM miễn phí —</option>
              <optgroup label="Nội bộ (dữ liệu không rời mạng công ty)">
                {PRESETS.filter((p) => p.group === 'local').map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </optgroup>
              <optgroup label="Cloud miễn phí (cần API key, dữ liệu gửi ra ngoài)">
                {PRESETS.filter((p) => p.group === 'cloud').map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </optgroup>
            </select>
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-url">URL máy chủ (OpenAI-compatible)</label>
            <input id="fm-ai-url" className="fm-input" placeholder="http://<máy-nội-bộ>:11434/v1 hoặc https://…/v1" value={cfg.baseUrl}
              onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} disabled={!canEdit || busy} />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-model">Tên model</label>
            <input id="fm-ai-model" className="fm-input" placeholder="vd qwen2.5:7b, glm-4-flash — hoặc bấm Tải danh sách model" value={cfg.model}
              list="fm-ai-model-list" autoComplete="off"
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })} disabled={!canEdit || busy} />
            <datalist id="fm-ai-model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-key">API key {external ? '(bắt buộc với cloud)' : '(nếu máy chủ yêu cầu)'}</label>
            <input id="fm-ai-key" type="password" autoComplete="new-password" className="fm-input"
              placeholder={cfg.hasKey ? '••••••••  (để trống = giữ key cũ)' : 'Để trống nếu máy chủ không cần key'}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={!canEdit || busy} />
          </div>
          <div className="fm-field">
            <span className="fm-label">Trạng thái</span>
            <label className="fm-check">
              <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} disabled={!canEdit || busy} />
              Bật trợ lý cho người dùng
            </label>
          </div>
        </div>
        {external && (
          <div className="fm-alert fm-alert--warning fm-mt-2" role="note">
            <div>
              <b>Máy chủ nằm ngoài mạng nội bộ.</b> Câu hỏi của người dùng và dữ liệu tra cứu (tên khách, mặt hàng, số lượng, giá,
              công nợ) sẽ được gửi tới nhà cung cấp này. Hệ thống tự che SĐT, địa chỉ, ghi chú đơn; người dùng không nên gõ thông tin
              cá nhân vào câu hỏi. Gói miễn phí có thể dùng dữ liệu để huấn luyện — xem điều khoản của nhà cung cấp.
              <label className="fm-check">
                <input type="checkbox" checked={cfg.allowCloud} onChange={(e) => setCfg({ ...cfg, allowCloud: e.target.checked })} disabled={!canEdit || busy} />
                Tôi xác nhận cho phép gửi dữ liệu nghiệp vụ tới dịch vụ LLM bên ngoài
              </label>
            </div>
          </div>
        )}
        <div className="fm-actions fm-mt-2">
          <button type="button" className="fm-btn fm-btn--primary" onClick={() => void save()} disabled={!canEdit || busy || !dirty}>
            <Save size={16} aria-hidden /> {busy ? 'Đang xử lý…' : 'Lưu'}
          </button>
          <button type="button" className="fm-btn fm-btn--secondary" onClick={() => void test()} disabled={!canEdit || busy || dirty || !saved?.baseUrl || !saved?.model}
            title={dirty ? 'Lưu trước rồi kiểm tra' : undefined}>
            <PlugZap size={16} aria-hidden /> Kiểm tra kết nối
          </button>
          <button type="button" className="fm-btn fm-btn--secondary" onClick={() => void loadModels()}
            disabled={!canEdit || busy || !saved?.baseUrl || cfg.baseUrl !== saved.baseUrl}
            title={cfg.baseUrl !== saved?.baseUrl ? 'Lưu URL máy chủ trước' : 'Lấy các model đã tải trên máy chủ'}>
            <ListRestart size={16} aria-hidden /> Tải danh sách model
          </button>
          {cfg.hasKey && canEdit && (
            <button type="button" className="fm-btn fm-btn--ghost" onClick={() => void save({ clearKey: true })} disabled={busy}>Xoá API key</button>
          )}
        </div>
        {msg && <p className={msg.type === 'ok' ? 'fm-hint fm-mt-1' : 'fm-error-text fm-mt-1'} role="status">{msg.text}</p>}
      </div>
    </div>
  )
}
