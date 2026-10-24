'use client'

// ============================================================
// HỘP THOẠI "DÁN DANH SÁCH DÒNG HÀNG" — dán từ Excel / Zalo / email →
// tách mã/barcode/tên + SL → tra mặt hàng (/api/items/resolve) → xem trước,
// chọn ứng viên cho dòng khớp nhiều mặt hàng, sửa SL → thêm tất cả 1 lượt.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { ClipboardPaste, X } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { parsePastedLines, type PastedLine } from '@/lib/paste-lines'
import type { ResolveResult, ResolvedItem } from '@/lib/item-resolve'
import { useFocusTrap } from './use-focus-trap'
import type { ACOption } from './autocomplete'

export interface PasteEntry { item: ACOption; quantity: number }

interface Row {
  line: PastedLine
  result: ResolveResult
  /** Mã mặt hàng được chọn (matched → mặc định; ambiguous → người dùng chọn) */
  chosen: string
  quantity: number
  include: boolean
}

const toOption = (it: ResolvedItem): ACOption => ({
  code: it.itemCode,
  name: it.itemName,
  uom: it.uom,
  price: it.price > 0 ? it.price : undefined,
  taxCode: it.taxCode,
  vatRate: typeof it.vatRate === 'number' ? it.vatRate : undefined,
  barcode: it.barcode,
})

const MATCH_LABEL = { code: 'mã', barcode: 'barcode', name: 'tên' } as const

export default function PasteLinesDialog({ initialText, onConfirm, onCancel }: {
  initialText: string
  onConfirm: (entries: PasteEntry[]) => void
  onCancel: () => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(initialText)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const analyze = async (src: string) => {
    const lines = parsePastedLines(src)
    if (lines.length === 0) { setRows([]); return }
    setBusy(true); setError('')
    try {
      const res = await api('/api/items/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: lines.map((l) => l.key) }),
      })
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      const results: ResolveResult[] = Array.isArray(j?.data) ? j.data : []
      setRows(lines.map((line, i) => {
        const r = results[i] ?? { key: line.key, status: 'notfound' as const }
        return {
          line,
          result: r,
          chosen: r.status === 'matched' ? r.item.itemCode : '',
          quantity: line.quantity,
          include: r.status === 'matched',
        }
      }))
    } catch (e) {
      setError(`Không tra được mặt hàng: ${e instanceof Error ? e.message : 'lỗi không rõ'}`)
    } finally {
      setBusy(false)
    }
  }

  // Mở từ thao tác dán (Ctrl+V) → phân tích ngay; mở bằng nút → focus ô dán
  useEffect(() => {
    if (initialText.trim()) void analyze(initialText)
    else textRef.current?.focus()
  }, [])

  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs && rs.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const itemOf = (r: Row): ResolvedItem | undefined =>
    r.result.status === 'matched' ? r.result.item
      : r.result.status === 'ambiguous' ? r.result.candidates.find((c) => c.itemCode === r.chosen) : undefined
  const ready = (rows ?? []).filter((r) => r.include && itemOf(r) && r.quantity > 0)
  const counts = {
    matched: (rows ?? []).filter((r) => r.result.status === 'matched').length,
    ambiguous: (rows ?? []).filter((r) => r.result.status === 'ambiguous').length,
    notfound: (rows ?? []).filter((r) => r.result.status === 'notfound').length,
  }

  return (
    <div className="fm-backdrop" onClick={onCancel}>
      <div
        ref={trapRef}
        className="fm-modal fm-modal--wide fm-paste"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fm-paste-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fm-bom-swap__head">
          <h3 id="fm-paste-title" className="fm-modal__title"><ClipboardPaste size={18} aria-hidden /> Dán danh sách dòng hàng</h3>
          <button type="button" className="fm-icon-btn" aria-label="Đóng" onClick={onCancel}><X size={16} /></button>
        </div>

        {rows === null ? (
          <>
            <label className="fm-label" htmlFor="fm-paste-text">Dán từ Excel, Zalo hoặc email — mỗi dòng 1 mặt hàng (mã / barcode / tên + số lượng)</label>
            <textarea
              id="fm-paste-text"
              ref={textRef}
              className="fm-input fm-paste__text"
              rows={8}
              placeholder={'FM-RAU-002   10\n8934563100021 x5\ncà chua bi 2,5kg'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </>
        ) : rows.length === 0 ? (
          <div className="fm-hint">Không tách được dòng hàng nào từ nội dung đã dán.</div>
        ) : (
          <>
            <p className="fm-hint fm-paste__summary" role="status">
              {counts.matched} dòng khớp · {counts.ambiguous} dòng cần chọn mặt hàng · {counts.notfound} dòng không tìm thấy
            </p>
            <div className="fm-paste__list fm-scroll">
              <table className="fm-table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}><span className="fm-sr-only">Thêm</span></th>
                    <th>Dòng đã dán</th>
                    <th>Mặt hàng</th>
                    <th className="fm-num" style={{ width: 96 }}>SL</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const it = itemOf(r)
                    return (
                      <tr key={i} className={r.result.status === 'notfound' ? 'is-notfound' : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={r.include && !!it}
                            disabled={!it}
                            onChange={(e) => patch(i, { include: e.target.checked })}
                            aria-label={`Thêm dòng ${i + 1}`}
                          />
                        </td>
                        <td className="fm-paste__raw">{r.line.raw}</td>
                        <td>
                          {r.result.status === 'matched' && (
                            <span><b>{r.result.item.itemCode}</b> — {r.result.item.itemName} <span className="fm-paste__by">khớp {MATCH_LABEL[r.result.matchedBy]}</span></span>
                          )}
                          {r.result.status === 'ambiguous' && (
                            <select
                              className="fm-line-select fm-paste__pick"
                              value={r.chosen}
                              onChange={(e) => patch(i, { chosen: e.target.value, include: !!e.target.value })}
                              aria-label={`Chọn mặt hàng cho dòng ${i + 1}`}
                            >
                              <option value="">— {r.result.candidates.length} mặt hàng khớp, chọn 1 —</option>
                              {r.result.candidates.map((c) => (
                                <option key={c.itemCode} value={c.itemCode}>{c.itemCode} — {c.itemName}</option>
                              ))}
                            </select>
                          )}
                          {r.result.status === 'notfound' && <span className="fm-paste__nf">Không tìm thấy “{r.line.key}”</span>}
                        </td>
                        <td className="fm-num">
                          <input
                            type="number"
                            min={0}
                            step="any"
                            inputMode="decimal"
                            className="fm-line-input"
                            value={r.quantity || ''}
                            onChange={(e) => patch(i, { quantity: Number(e.target.value) || 0 })}
                            aria-label={`Số lượng dòng ${i + 1}`}
                            title={r.line.qtyDefaulted ? 'Không thấy số lượng trong dòng — mặc định 1' : undefined}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {error && <div className="fm-error-text" role="alert">{error}</div>}

        <div className="fm-bom-swap__foot">
          {rows !== null && <button type="button" className="fm-btn fm-btn--ghost" onClick={() => setRows(null)}>Sửa nội dung dán</button>}
          <button type="button" className="fm-btn fm-btn--secondary" onClick={onCancel}>Hủy bỏ</button>
          {rows === null ? (
            <button type="button" className="fm-btn fm-btn--primary" onClick={() => analyze(text)} disabled={busy || !text.trim()}>
              {busy ? 'Đang tra mặt hàng…' : 'Phân tích'}
            </button>
          ) : (
            <button
              type="button"
              className="fm-btn fm-btn--primary"
              disabled={ready.length === 0}
              onClick={() => onConfirm(ready.map((r) => ({ item: toOption(itemOf(r)!), quantity: r.quantity })))}
            >
              Thêm {ready.length} dòng
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
