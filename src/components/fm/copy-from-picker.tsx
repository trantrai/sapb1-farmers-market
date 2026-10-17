'use client'

// ============================================================
// "Sao chép từ…" (Copy From) chuẩn SAP B1 — modal dùng chung cho các
// form TẠO chứng từ (đơn hàng, phiếu giao hàng, hóa đơn, ghi có,
// trả hàng, đặt cọc). 2 bước: (a) chọn loại chứng từ nguồn (chỉ hiện
// loại hợp lệ theo ma trận COPY_FROM_SOURCES), (b) chọn 1 chứng từ
// nguồn → gọi POST ?prefill=1 (KHÔNG tạo chứng từ) rồi trả prefill
// cho form điền vào qua onPick.
// Thuật ngữ chuẩn SAP B1. Dùng .fm-backdrop/.fm-modal + useFocusTrap
// (cùng pattern với ConfirmDialog).
// ============================================================

import { useEffect, useState } from 'react'
import { Copy, Search, X } from 'lucide-react'
import { useFocusTrap } from './use-focus-trap'
import { api } from '@/lib/fm-client'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { DOC_TYPE_LABEL, DOC_STATUS_LABEL, docNumLabel } from './sales-doc-shared'
import {
  COPY_FROM_SOURCES,
  copyFromPrefillRequest,
  type CopyFromTarget,
  type CopyFromSourceKey,
  type PrefillDoc,
} from '@/lib/copy-from'

interface Props {
  /** Loại chứng từ đích: quyết định danh sách nguồn + endpoint prefill */
  targetType: CopyFromTarget
  /** Nhận prefill (?prefill=1) để form điền vào */
  onPick: (prefill: PrefillDoc) => void
  onClose: () => void
}

interface SourceRow {
  id: string
  docNum: number | null
  cardCode: string
  cardName: string
  docDate: string
  grandTotal: number
  status: string
  isDraft?: boolean
}

export default function CopyFromPicker({ targetType, onPick, onClose }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const sources = COPY_FROM_SOURCES[targetType]
  const [sourceKey, setSourceKey] = useState<CopyFromSourceKey>(sources[0].key)
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<SourceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const [copyError, setCopyError] = useState('')

  const sourceLabel = (k: CopyFromSourceKey) => DOC_TYPE_LABEL[k] ?? k

  // Tải danh sách chứng từ nguồn (loại trừ nháp + đã hủy; chỉ chứng từ local —
  // ?isDraft=false nên API không gộp chứng từ SAP live)
  useEffect(() => {
    const opt = sources.find((s) => s.key === sourceKey) ?? sources[0]
    let cancelled = false
    setLoading(true)
    setError('')
    setSelectedId(null)
    const qs = new URLSearchParams({ isDraft: 'false', pageSize: '50' })
    if (q.trim()) qs.set('q', q.trim())
    const t = setTimeout(() => {
      api(`${opt.listApi}?${qs.toString()}`)
        .then(async (res) => {
          const j = await res.json().catch(() => ({}))
          if (cancelled) return
          if (!res.ok) {
            setError(j?.error ?? 'Không tải được danh sách chứng từ nguồn')
            setRows([])
            return
          }
          const data = (Array.isArray(j?.data) ? j.data : []) as SourceRow[]
          setRows(data.filter((r) => !r.isDraft && r.status !== 'Cancelled'))
        })
        .catch(() => {
          if (!cancelled) {
            setError('Không kết nối được máy chủ')
            setRows([])
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [sourceKey, q, sources])

  const doCopy = async () => {
    if (!selectedId || copying) return
    setCopying(true)
    setCopyError('')
    try {
      const { url, body } = copyFromPrefillRequest(targetType, sourceKey, selectedId)
      const res = await api(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok || !json?.prefill) {
        setCopyError(json?.error ?? 'Không sao chép được dữ liệu từ chứng từ nguồn')
        return
      }
      onPick(json.prefill as PrefillDoc)
    } catch {
      setCopyError('Không kết nối được máy chủ')
    } finally {
      setCopying(false)
    }
  }

  const selected = rows.find((r) => r.id === selectedId) ?? null

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div
        ref={trapRef}
        className="fm-modal fm-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fm-copyfrom-title"
        onClick={(e) => e.stopPropagation()}
        style={{ borderTopColor: 'var(--fm-navy)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <h3 id="fm-copyfrom-title" className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Copy size={16} aria-hidden /> Sao chép từ…
          </h3>
          <button type="button" className="fm-icon-btn" onClick={onClose} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ flex: '1 1 220px', minWidth: 200 }}>
            <label className="fm-label" htmlFor="fm-copyfrom-source">Loại chứng từ nguồn</label>
            <select
              id="fm-copyfrom-source"
              className="fm-select"
              value={sourceKey}
              disabled={copying}
              onChange={(e) => setSourceKey(e.target.value as CopyFromSourceKey)}
            >
              {sources.map((s) => (
                <option key={s.key} value={s.key}>{sourceLabel(s.key)}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: '2 1 260px', minWidth: 220 }}>
            <label className="fm-label" htmlFor="fm-copyfrom-q">Tìm kiếm</label>
            <div style={{ position: 'relative' }}>
              <Search size={14} aria-hidden style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fm-text-3)' }} />
              <input
                id="fm-copyfrom-q"
                type="search"
                className="fm-input"
                style={{ paddingLeft: 30 }}
                placeholder="Số chứng từ, mã/tên khách hàng…"
                value={q}
                disabled={copying}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="fm-hint" style={{ marginBottom: 10 }}>
          Chọn 1 {sourceLabel(sourceKey)} (loại trừ bản nháp và chứng từ đã hủy) để điền sẵn dữ liệu vào chứng từ mới — chứng từ nguồn không bị thay đổi.
        </div>

        {error && (
          <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 10 }}>{error}</div>
        )}
        {copyError && (
          <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 10 }}>{copyError}</div>
        )}

        <div className="fm-table-wrap" style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto', border: '1px solid var(--fm-line)', borderRadius: 8 }}>
          <table className="fm-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}><span className="fm-sr-only">Chọn</span></th>
                <th>Số chứng từ</th>
                <th>Khách hàng</th>
                <th>Ngày</th>
                <th className="fm-num">Tổng tiền (₫)</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6}><div aria-busy="true" style={{ padding: 12 }}>Đang tải…</div></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6}><div className="fm-empty" style={{ padding: 12 }}>Không tìm thấy {sourceLabel(sourceKey)} nào (đã loại trừ nháp và đã hủy).</div></td></tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => setSelectedId(r.id)}
                    style={{ cursor: 'pointer', background: r.id === selectedId ? 'var(--fm-bg-2)' : undefined }}
                    aria-selected={r.id === selectedId}
                  >
                    <td>
                      <input
                        type="radio"
                        name="fm-copyfrom-row"
                        checked={r.id === selectedId}
                        onChange={() => setSelectedId(r.id)}
                        aria-label={`Chọn ${sourceLabel(sourceKey)} ${docNumLabel(r.docNum, r.isDraft)}`}
                      />
                    </td>
                    <th scope="row"><b>{docNumLabel(r.docNum, r.isDraft)}</b></th>
                    <td>{r.cardName || r.cardCode || '—'}</td>
                    <td>{r.docDate ? formatDateVN(r.docDate) : '—'}</td>
                    <td className="fm-num">{formatVND(r.grandTotal ?? 0)}</td>
                    <td>{DOC_STATUS_LABEL[r.status] ?? r.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="fm-hint" style={{ marginTop: 8 }}>
            Đã chọn: <b>{sourceLabel(sourceKey)} {docNumLabel(selected.docNum, selected.isDraft)}</b> — {selected.cardName || selected.cardCode}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="fm-btn fm-btn--secondary" onClick={onClose} disabled={copying}>
            Hủy bỏ
          </button>
          <button
            type="button"
            className="fm-btn fm-btn--primary"
            onClick={() => void doCopy()}
            disabled={!selectedId || copying}
          >
            <Copy size={14} /> {copying ? 'Đang sao chép…' : 'Sao chép'}
          </button>
        </div>
      </div>
    </div>
  )
}
