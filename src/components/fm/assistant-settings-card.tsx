'use client'

// ============================================================
// CÀI ĐẶT → TRỢ LÝ SALE ADMIN: máy chủ LLM nội bộ (API chuẩn OpenAI).
// Không gửi dữ liệu ra ngoài — URL phải trỏ tới máy chủ trong mạng nội bộ.
// ============================================================

import { useEffect, useState } from 'react'
import { Bot, ListRestart, PlugZap, Save } from 'lucide-react'
import { api } from '@/lib/fm-client'

interface Cfg { enabled: boolean; baseUrl: string; model: string; hasKey: boolean }

/** Máy chủ LLM miễn phí, tự chạy nội bộ (cổng mặc định). "localhost" = chính máy chạy hệ thống này. */
const PRESETS = [
  { key: 'ollama', label: 'Ollama (miễn phí, dễ cài nhất)', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { key: 'lmstudio', label: 'LM Studio (miễn phí, có giao diện)', url: 'http://localhost:1234/v1', model: '' },
  { key: 'llamacpp', label: 'llama.cpp server', url: 'http://localhost:8080/v1', model: '' },
  { key: 'vllm', label: 'vLLM (máy chủ GPU)', url: 'http://localhost:8000/v1', model: '' },
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
        const c: Cfg = { enabled: Boolean(j.data.enabled), baseUrl: j.data.baseUrl ?? '', model: j.data.model ?? '', hasKey: Boolean(j.data.hasKey) }
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
      setCfg(j.data); setSaved(j.data); setApiKey('')
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
    if (p) setCfg({ ...cfg, baseUrl: p.url, model: cfg.model || p.model })
  }

  return (
    <div className="fm-card fm-mt-3">
      <div className="fm-card__head">
        <Bot size={18} /> Trợ lý sale admin (LLM nội bộ)
        {saved?.enabled ? <span className="fm-chip fm-chip--ok">Đang bật</span> : <span className="fm-chip fm-chip--role">Đang tắt</span>}
      </div>
      <div className="fm-card__body">
        <p className="fm-hint">
          Trợ lý chạy trên máy chủ LLM <b>nội bộ</b> có API chuẩn OpenAI (vLLM, Ollama, llama.cpp…), ví dụ
          <code> http://10.0.0.5:8000/v1</code>. Dữ liệu chỉ đi giữa hệ thống này và máy chủ đó. Trợ lý chỉ đọc dữ liệu
          theo quyền người dùng và soạn nháp đơn — không lưu hay đẩy chứng từ lên SAP.
        </p>
        <p className="fm-hint">
          Dùng model <b>miễn phí, mã nguồn mở</b> chạy trên máy nội bộ — không tốn phí API, không gửi dữ liệu ra ngoài.
          Đề xuất: cài <b>Ollama</b> rồi tải <code>qwen2.5:7b</code> (tiếng Việt tốt, hỗ trợ gọi công cụ; cần ~8 GB RAM/VRAM)
          hoặc <code>qwen2.5:14b</code> nếu máy mạnh hơn. Model phải hỗ trợ <b>tool calling</b> để tra cứu dữ liệu.
        </p>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-preset">Mẫu nhanh</label>
            <select id="fm-ai-preset" className="fm-input" value="" onChange={(e) => applyPreset(e.target.value)} disabled={!canEdit || busy}>
              <option value="">— Chọn máy chủ LLM miễn phí —</option>
              {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-url">URL máy chủ (OpenAI-compatible)</label>
            <input id="fm-ai-url" className="fm-input" placeholder="http://<máy-chủ-nội-bộ>:8000/v1" value={cfg.baseUrl}
              onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} disabled={!canEdit || busy} />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-model">Tên model</label>
            <input id="fm-ai-model" className="fm-input" placeholder="vd qwen2.5:7b — hoặc bấm Tải danh sách model" value={cfg.model}
              list="fm-ai-model-list" autoComplete="off"
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })} disabled={!canEdit || busy} />
            <datalist id="fm-ai-model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-key">API key (nếu máy chủ yêu cầu)</label>
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
