'use client'

// ============================================================
// CÀI ĐẶT → TRỢ LÝ SALE ADMIN: máy chủ LLM nội bộ (API chuẩn OpenAI).
// Không gửi dữ liệu ra ngoài — URL phải trỏ tới máy chủ trong mạng nội bộ.
// ============================================================

import { useEffect, useState } from 'react'
import { Bot, PlugZap, Save } from 'lucide-react'
import { api } from '@/lib/fm-client'

interface Cfg { enabled: boolean; baseUrl: string; model: string; hasKey: boolean }

export default function AssistantSettingsCard({ canEdit }: { canEdit: boolean }) {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [saved, setSaved] = useState<Cfg | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

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
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-url">URL máy chủ (OpenAI-compatible)</label>
            <input id="fm-ai-url" className="fm-input" placeholder="http://<máy-chủ-nội-bộ>:8000/v1" value={cfg.baseUrl}
              onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} disabled={!canEdit || busy} />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-ai-model">Tên model</label>
            <input id="fm-ai-model" className="fm-input" placeholder="Tên model như máy chủ khai báo (vd glm-…)" value={cfg.model}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })} disabled={!canEdit || busy} />
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
          {cfg.hasKey && canEdit && (
            <button type="button" className="fm-btn fm-btn--ghost" onClick={() => void save({ clearKey: true })} disabled={busy}>Xoá API key</button>
          )}
        </div>
        {msg && <p className={msg.type === 'ok' ? 'fm-hint fm-mt-1' : 'fm-error-text fm-mt-1'} role="status">{msg.text}</p>}
      </div>
    </div>
  )
}
