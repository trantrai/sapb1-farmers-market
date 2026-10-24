'use client'

import { useCallback, useEffect, useState } from 'react'
import { SearchCheck, X, Link2, Send } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { useFocusTrap } from './use-focus-trap'
import ConfirmDialog from './confirm-dialog'
import { SAP_ERROR_KIND_LABEL, type SapSyncErrorKind } from '@/lib/sap-sync-retry'

/** Trường đồng bộ SAP của đơn local dùng cho chip/tooltip */
export interface SapSyncFields {
  sapSyncError?: string | null
  sapSyncErrorKind?: string | null
  sapSyncAttempts?: number | null
  sapNextRetryAt?: string | null
}

const timeVN = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })

/** Mô tả trạng thái chờ đồng bộ: loại lỗi + lần tự thử kế tiếp (tooltip / dòng phụ) */
export function sapSyncHint(o: SapSyncFields): string {
  const kind = o.sapSyncErrorKind as SapSyncErrorKind | null | undefined
  const parts = [kind && SAP_ERROR_KIND_LABEL[kind] ? SAP_ERROR_KIND_LABEL[kind] : null]
  if (o.sapNextRetryAt) parts.push(`tự thử lại lúc ${timeVN(o.sapNextRetryAt)}`)
  else if ((kind === 'safe' || kind === 'unknown') && (o.sapSyncAttempts ?? 0) > 0) parts.push(`đã tự thử ${o.sapSyncAttempts} lần — chờ đẩy tay`)
  if (o.sapSyncError) parts.push(`lỗi: ${o.sapSyncError}`)
  return parts.filter(Boolean).join(' · ')
}

// ============================================================
// ĐỐI CHIẾU ĐƠN "KHÔNG RÕ ĐÃ LÊN SAP HAY CHƯA" (DB SAP chưa có UDF U_FM_LocalId)
// Liệt kê đơn trên SAP cùng khách + cùng ngày chứng từ (chỉ đọc). Người dùng:
//  - "Đây là đơn này" → gắn đơn local với chứng từ SAP (không ghi gì lên SAP)
//  - "SAP chưa có — đẩy lại" → xác nhận DB đích rồi đẩy (force)
// ============================================================

interface Candidate {
  DocEntry: number
  DocNum?: number
  DocDate?: string
  DocDueDate?: string
  DocTotal?: number
  totalDiff: number
  totalMatch: boolean
  dueMatch: boolean
  numAtCard: string
  comments: string
  cancelled: boolean
  linkedToDocNum: number | null
}

interface MatchData {
  sapDb: { label?: string; companyDb: string }
  order: { id: string; docNum: number | null; cardCode: string; cardName: string; docDate: string; docDueDate: string; grandTotal: number; lineCount: number }
  candidates: Candidate[]
}

interface Props {
  orderId: string
  onClose: () => void
  /** Xong (đã gắn hoặc đã đẩy lại) — msg hiển thị ở màn hình cha */
  onDone: (type: 'success' | 'error', msg: string) => void
}

type Pending = { kind: 'link'; c: Candidate } | { kind: 'push' } | null

export default function SapReconcileDialog({ orderId, onClose, onDone }: Props) {
  const [data, setData] = useState<MatchData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>(null)
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api(`/api/orders/${orderId}/sap-match`)
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) setError(json.error ?? 'Không tra được đơn trên SAP B1')
      else setData(json as MatchData)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tra được đơn trên SAP B1')
    }
  }, [orderId])

  useEffect(() => { void load() }, [load])

  const link = async (c: Candidate) => {
    setPending(null)
    setBusy(true)
    try {
      const res = await api(`/api/orders/${orderId}/sap-match`, { method: 'POST', body: JSON.stringify({ docEntry: c.DocEntry }) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        setError(json.error ?? 'Không gắn được chứng từ SAP')
        return
      }
      onDone('success', `Đã gắn đơn #${data?.order.docNum ?? ''} với SAP DocNum ${c.DocNum ?? c.DocEntry}${json.lineNumsOk ? '' : ' — số dòng khác nhau, kiểm tra trước khi sửa đơn'}`)
    } finally {
      setBusy(false)
    }
  }

  const pushAgain = async () => {
    setPending(null)
    setBusy(true)
    try {
      const res = await api(`/api/orders/${orderId}/sync`, { method: 'POST', body: JSON.stringify({ force: true }) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) onDone('error', json.error ?? json.sap?.error ?? 'Không thể đẩy đơn sang SAP B1')
      else onDone('success', `Đã đẩy đơn #${data?.order.docNum ?? ''} sang SAP B1 — DocNum ${json.order?.sapDocNum}`)
    } finally {
      setBusy(false)
    }
  }

  const dbName = data ? `${data.sapDb.label && data.sapDb.label !== data.sapDb.companyDb ? `${data.sapDb.label} · ` : ''}${data.sapDb.companyDb}` : ''

  return (
    <>
    <div className="fm-backdrop" onClick={onClose}>
      <div
        ref={trapRef}
        className="fm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fm-reconcile-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 760, width: '100%' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <h3 id="fm-reconcile-title" className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SearchCheck size={18} aria-hidden /> Đối chiếu đơn với SAP B1
          </h3>
          <button type="button" className="fm-icon-btn" onClick={onClose} aria-label="Đóng"><X size={16} /></button>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.55, color: 'var(--fm-text-2)' }}>
          Lần đẩy trước bị gián đoạn — SAP có thể đã tạo đơn. DB SAP chưa có UDF <code>U_FM_LocalId</code> nên không tự kiểm tra được.
          Hãy chọn đơn tương ứng trên SAP (nếu có) để tránh tạo trùng.
        </p>

        {error && <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
        {!data && !error && <p style={{ fontSize: 13 }}>Đang tra đơn trên SAP B1…</p>}

        {data && (
          <>
            <div style={{ fontSize: 13, marginBottom: 10 }}>
              Đơn <b>#{data.order.docNum ?? '—'}</b> · {data.order.cardCode} — {data.order.cardName} · ngày {formatDateVN(data.order.docDate)} · giao {formatDateVN(data.order.docDueDate)} ·{' '}
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{formatVND(data.order.grandTotal)}</b> · {data.order.lineCount} dòng
              <div style={{ color: 'var(--fm-text-2)' }}>DB SAP: {dbName}</div>
            </div>
            {data.candidates.length === 0 ? (
              <p style={{ fontSize: 13, padding: '12px 0' }}>SAP không có đơn nào của khách này cùng ngày chứng từ.</p>
            ) : (
              <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>SAP DocNum</th>
                      <th>Ngày giao</th>
                      <th style={{ textAlign: 'right' }}>Tổng tiền</th>
                      <th>Ghi chú / Số tham chiếu</th>
                      <th aria-label="Thao tác" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.map((c) => {
                      const blocked = c.cancelled || c.linkedToDocNum != null
                      return (
                        <tr key={c.DocEntry}>
                          <td>
                            {c.DocNum ?? '—'}
                            {c.totalMatch && c.dueMatch && <span className="fm-chip fm-chip--ok" style={{ marginLeft: 6 }}>Khớp</span>}
                          </td>
                          <td>
                            {c.DocDueDate ? formatDateVN(c.DocDueDate) : '—'}
                            {!c.dueMatch && <span className="fm-chip fm-chip--warn" style={{ marginLeft: 6 }}>khác</span>}
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {formatVND(Number(c.DocTotal) || 0)}
                            {!c.totalMatch && (
                              <div style={{ fontSize: 11, color: 'var(--fm-coral-deep)' }}>
                                lệch {c.totalDiff > 0 ? '+' : ''}{formatVND(c.totalDiff)}
                              </div>
                            )}
                          </td>
                          <td style={{ maxWidth: 220, fontSize: 12 }}>
                            {[c.numAtCard, c.comments].filter(Boolean).join(' · ') || '—'}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {c.cancelled ? (
                              <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
                            ) : c.linkedToDocNum != null ? (
                              <span className="fm-chip fm-chip--closed">Đã gắn đơn #{c.linkedToDocNum}</span>
                            ) : (
                              <button
                                type="button"
                                className="fm-btn fm-btn--secondary"
                                disabled={busy || blocked}
                                onClick={() => setPending({ kind: 'link', c })}
                              >
                                <Link2 size={14} /> Đây là đơn này
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="fm-btn fm-btn--secondary" onClick={onClose}>Đóng</button>
          {data && (
            <button type="button" className="fm-btn fm-btn--danger" disabled={busy} onClick={() => setPending({ kind: 'push' })}>
              <Send size={14} /> SAP chưa có đơn này — đẩy lại
            </button>
          )}
        </div>
      </div>
    </div>

      {pending?.kind === 'link' && (
        <ConfirmDialog
          open
          title="Gắn với chứng từ SAP"
          message={`Gắn đơn #${data?.order.docNum ?? ''} với đơn SAP DocNum ${pending.c.DocNum ?? pending.c.DocEntry}?\nKhông ghi gì lên SAP — chỉ đánh dấu đơn này đã đồng bộ.`}
          confirmLabel="Gắn đơn"
          tone="primary"
          onConfirm={() => { void link(pending.c) }}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === 'push' && (
        <ConfirmDialog
          open
          title="Đẩy lại đơn sang SAP B1"
          message={`Bạn đã kiểm tra và SAP CHƯA có đơn này?\nDB đích: ${dbName}\nThao tác tạo chứng từ thật trên SAP — nếu SAP đã có đơn sẽ bị TRÙNG.`}
          confirmLabel="Đẩy sang SAP"
          tone="danger"
          onConfirm={() => { void pushAgain() }}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  )
}
