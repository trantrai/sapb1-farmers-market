'use client'

// ============================================================
// TRỢ LÝ SALE ADMIN — nút chat nổi + khung hội thoại (không chặn màn hình).
// Gọi /api/assistant/chat (LLM on-premise, công cụ chỉ đọc theo RBAC).
// Nháp đơn trợ lý soạn → nút "Mở trong form tạo đơn" (người dùng tự Lưu).
// Hội thoại giữ trong phiên tab (sessionStorage), không lưu lên server.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { Bot, FileInput, Loader2, MessageSquarePlus, SendHorizontal, X } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { formatVND } from '@/lib/fm-shared'
import type { OrderDraft } from '@/lib/assistant/agent'

interface Msg { role: 'user' | 'assistant'; content: string; draft?: OrderDraft | null; error?: boolean }

const STORE_KEY = 'fm-assistant-chat'
const SUGGESTIONS = [
  'Đơn hàng đang mở gần đây',
  'Khách C20001 hay mua gì, giao thứ mấy?',
  'Công nợ và nợ quá hạn của khách C20001',
  'Lên đơn cho C20001: cà chua bi 10, cải ngọt 5',
]

const loadStored = (): Msg[] => {
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    const v = raw ? JSON.parse(raw) : null
    return Array.isArray(v) ? v.slice(-30) : []
  } catch { return [] }
}

export default function AssistantChat({ onOpenDraft }: { onOpenDraft: (draft: OrderDraft) => void }) {
  const [enabled, setEnabled] = useState(false)
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>(loadStored)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fabRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    api('/api/assistant/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setEnabled(Boolean(j?.data?.enabled)) })
      .catch(() => { /* chưa cấu hình → ẩn nút */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(msgs.slice(-30))) } catch { /* bỏ qua */ }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  if (!enabled) return null

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || busy) return
    const next: Msg[] = [...msgs, { role: 'user', content: q }]
    setMsgs(next)
    setInput('')
    setBusy(true)
    try {
      const res = await api('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Chỉ gửi lượt hỏi/đáp thành công (bỏ thông báo lỗi) — server tự cắt 16 lượt cuối
        body: JSON.stringify({ messages: next.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })) }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setMsgs((m) => [...m, { role: 'assistant', content: String(j?.reply ?? ''), draft: j?.draft ?? null }])
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: e instanceof Error ? e.message : 'Trợ lý gặp lỗi', error: true }])
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const close = () => { setOpen(false); fabRef.current?.focus() }

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className={`fm-assistant-fab${open ? ' is-open' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls="fm-assistant-panel"
        title="Trợ lý sale admin"
      >
        {open ? <X size={20} aria-hidden /> : <Bot size={20} aria-hidden />}
        <span className="fm-sr-only">{open ? 'Đóng trợ lý' : 'Mở trợ lý sale admin'}</span>
      </button>
      {open && (
        <section
          id="fm-assistant-panel"
          className="fm-assistant"
          role="dialog"
          aria-modal="false"
          aria-labelledby="fm-assistant-title"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close() } }}
        >
          <header className="fm-assistant__head">
            <Bot size={18} aria-hidden />
            <h2 id="fm-assistant-title">Trợ lý sale admin</h2>
            <button
              type="button"
              className="fm-icon-btn fm-icon-btn--sm fm-ml-auto"
              onClick={() => setMsgs([])}
              disabled={busy || msgs.length === 0}
              title="Hội thoại mới"
              aria-label="Hội thoại mới"
            >
              <MessageSquarePlus size={16} aria-hidden />
            </button>
            <button type="button" className="fm-icon-btn fm-icon-btn--sm" onClick={close} aria-label="Đóng trợ lý"><X size={16} aria-hidden /></button>
          </header>

          <div className="fm-assistant__list fm-scroll" ref={listRef} aria-live="polite">
            {msgs.length === 0 && (
              <div className="fm-assistant__intro">
                <p>Hỏi nhanh về khách hàng, đơn hàng, công nợ, giá và tồn kho — hoặc nhờ soạn nháp đơn. Dữ liệu chỉ xử lý trên máy chủ nội bộ.</p>
                <div className="fm-assistant__chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" className="fm-assistant__chip" onClick={() => void send(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`fm-assistant__msg is-${m.role}${m.error ? ' is-error' : ''}`}>
                <div className="fm-assistant__bubble">{m.content}</div>
                {m.draft && (
                  <div className="fm-assistant__draft">
                    <div className="fm-assistant__draft-head"><b>Nháp đơn</b> · {m.draft.cardCode} — {m.draft.cardName}</div>
                    <ul>
                      {m.draft.lines.slice(0, 6).map((l) => (
                        <li key={l.itemCode}>
                          <span>{l.itemCode} — {l.itemName}</span>
                          <span className="fm-assistant__draft-qty">{l.quantity} {l.uom ?? ''}{typeof l.price === 'number' && l.price > 0 ? ` · ${formatVND(l.price)}` : ''}</span>
                        </li>
                      ))}
                      {m.draft.lines.length > 6 && <li className="fm-assistant__more">… và {m.draft.lines.length - 6} dòng khác</li>}
                    </ul>
                    <button type="button" className="fm-btn fm-btn--primary fm-btn--sm fm-btn--block" onClick={() => onOpenDraft(m.draft!)}>
                      <FileInput size={14} aria-hidden /> Mở trong form tạo đơn
                    </button>
                    <p className="fm-assistant__note">Đơn chưa được lưu — kiểm tra giá, tồn kho rồi bấm Lưu trên form.</p>
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="fm-assistant__msg is-assistant">
                <div className="fm-assistant__bubble fm-assistant__typing"><Loader2 size={14} className="fm-spin" aria-hidden /> Đang tra cứu…</div>
              </div>
            )}
          </div>

          <form className="fm-assistant__form" onSubmit={(e) => { e.preventDefault(); void send(input) }}>
            <label htmlFor="fm-assistant-input" className="fm-sr-only">Câu hỏi cho trợ lý</label>
            <textarea
              id="fm-assistant-input"
              ref={inputRef}
              className="fm-input fm-assistant__input"
              rows={2}
              maxLength={2000}
              placeholder="Hỏi trợ lý… (Enter gửi, Shift+Enter xuống dòng)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey) return // Shift+Enter: xuống dòng mặc định
                // preventDefault cũng chặn Ctrl+Enter lọt ra phím tắt "Lưu chứng từ" của form phía sau
                e.preventDefault()
                void send(input)
              }}
              disabled={busy}
            />
            <button type="submit" className="fm-btn fm-btn--primary" disabled={busy || !input.trim()} aria-label="Gửi câu hỏi">
              <SendHorizontal size={16} aria-hidden />
            </button>
          </form>
        </section>
      )}
    </>
  )
}
