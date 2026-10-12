'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { History, RefreshCw, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/lib/fm-client'

// ============================================================
// SERVICE LAYER AUDIT — nhật ký mọi lệnh gọi SAP B1 Service Layer
// (POST luôn ghi, GET ghi khi lỗi + tổng kết lấy-all). Mỗi dòng có
// nút RETRY gửi lại lệnh gốc: POST → gửi lại payload (cảnh báo trùng
// chứng từ), GET → gọi lại path+query, POST /Login → đăng nhập lại.
// ============================================================

interface AuditRow {
  id: string
  method: string
  path: string
  ok: boolean
  httpStatus: number | null
  durationMs: number
  error: string | null
  payload: string | null
  resultSummary: string | null
  retryOf: string | null
  createdAt: string
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const fmtPath = (p: string) => (p.length > 64 ? `${p.slice(0, 64)}…` : p)

export default function SapAuditView() {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<'all' | 'ok' | 'error'>('all')
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmRetry, setConfirmRetry] = useState<AuditRow | null>(null)

  const load = useCallback(async (p = page, st = status, query = q) => {
    setRows(null)
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: '20', status: st })
      if (query.trim()) sp.set('q', query.trim())
      const res = await api(`/api/sap-audit?${sp.toString()}`)
      if (res.status === 401) { window.location.reload(); return }
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không tải được nhật ký' })
        setRows([])
        return
      }
      setRows(json.data ?? [])
      setTotal(json.total ?? 0)
      setTotalPages(json.totalPages ?? 1)
      setPage(json.page ?? p)
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setRows([])
    }
  }, [page, status, q])

  useEffect(() => { load(1, status, q) /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

  const doRetry = async (row: AuditRow) => {
    setBusyId(row.id)
    setMsg(null)
    setConfirmRetry(null)
    try {
      const res = await api(`/api/sap-audit/${row.id}/retry`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Retry thất bại' })
      } else if (json.ok) {
        setMsg({ type: 'success', text: `Retry ${row.method} ${row.path} thành công${json.result?.DocNum ? ` — DocNum ${json.result.DocNum}` : ''}.` })
      } else {
        setMsg({ type: 'error', text: `Retry ${row.method} ${row.path} lại LỖI (HTTP ${json.httpStatus ?? '?'})${json.error ? `: ${json.error}` : ''}` })
      }
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setBusyId(null)
      await load(page, status, q)
    }
  }

  const clearLog = async () => {
    if (!window.confirm('Xóa TOÀN BỘ nhật ký Service Layer Audit?')) return
    const res = await api('/api/sap-audit', { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      setMsg({ type: 'success', text: 'Đã xóa toàn bộ nhật ký.' })
      await load(1, status, q)
    } else {
      setMsg({ type: 'error', text: json.error ?? 'Không xóa được nhật ký' })
    }
  }

  return (
    <div>
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <History size={18} /> Nhật ký gọi SAP B1 Service Layer
        </h2>
        <p className="fm-card__desc">
          Ghi lại mọi lệnh gọi Service Layer: <b>POST</b> (đẩy đơn /Login…) luôn được ghi; <b>GET</b> ghi khi lỗi
          và tổng kết các lần lấy-all. Bấm <b>Retry</b> để gửi lại lệnh gốc — POST /Orders sẽ tạo chứng từ MỚI trên SAP.
        </p>

        {/* Mobile (≤640px): .fm-filterbar tự chuyển sang lưới 2 cột (mục 15.6 globals.css) —
            KHÔNG đặt display:flex inline vì sẽ đè rule grid của mobile */}
        <div className="fm-filterbar">
          <select className="fm-select" value={status} onChange={(e) => { const v = e.target.value as 'all' | 'ok' | 'error'; setStatus(v); load(1, v, q) }}>
            <option value="all">Tất cả trạng thái</option>
            <option value="ok">Chỉ thành công</option>
            <option value="error">Chỉ lỗi</option>
          </select>
          <input
            className="fm-input"
            data-search
            placeholder="Tìm theo endpoint (/Orders…)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, status, q)}
          />
          <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => load(1, status, q)}>
            <RefreshCw size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Tải lại
          </button>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ color: 'var(--fm-red)' }} onClick={clearLog} title="Xóa toàn bộ nhật ký">
            <Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Xóa log
          </button>
          <span className="fm-chip fm-chip--role">{total} bản ghi</span>
        </div>

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th style={{ width: 148 }}>Thời gian</th>
                <th style={{ width: 64 }}>Method</th>
                <th style={{ minWidth: 210 }}>Endpoint</th>
                <th style={{ width: 110 }}>Kết quả</th>
                <th className="fm-num" style={{ width: 90 }}>Ms</th>
                <th style={{ width: 96 }}>Retry</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr><td colSpan={7}><div className="fm-empty">Đang tải nhật ký…</div></td></tr>
              )}
              {rows !== null && rows.length === 0 && (
                <tr><td colSpan={7}><div className="fm-empty">Chưa có lệnh gọi Service Layer nào được ghi nhận.</div></td></tr>
              )}
              {rows?.map((r) => (
                <Fragment key={r.id}>
                  <tr className={r.ok ? '' : 'fm-audit-row--err'} onClick={() => setExpanded(expanded === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                    <td data-label="">{expanded === r.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td data-label="Thời gian">{fmtTime(r.createdAt)}</td>
                    <td data-label="Method">
                      <span className={`fm-line-meta ${r.method === 'POST' ? 'fm-audit-method--post' : r.method === 'PATCH' ? 'fm-audit-method--patch' : ''}`}>{r.method}</span>
                    </td>
                    <td data-label="Endpoint" data-full title={r.path}>{fmtPath(r.path)}</td>
                    <td data-label="Kết quả">
                      <span className={`fm-chip ${r.ok ? 'fm-chip--sap' : 'fm-chip--overdue'}`} title={r.error ?? r.resultSummary ?? ''}>
                        {r.ok ? 'OK' : 'LỖI'}{r.httpStatus != null && r.httpStatus > 0 ? ` ${r.httpStatus}` : ''}
                      </span>
                      {r.retryOf && <span className="fm-chip fm-chip--role" style={{ marginLeft: 4 }} title="Kết quả của lệnh Retry">↻</span>}
                    </td>
                    <td className="fm-num" data-label="Ms">{r.durationMs}</td>
                    <td data-label="Retry">
                      <button
                        className="fm-btn fm-btn--ghost fm-btn--sm"
                        title={r.method === 'POST' ? 'Gửi lại payload lên Service Layer (POST /Orders sẽ tạo chứng từ MỚI)' : r.method === 'PATCH' ? 'Gửi lại payload PATCH để cập nhật lại chứng từ' : 'Gọi lại endpoint GET này'}
                        disabled={busyId === r.id}
                        onClick={(e) => { e.stopPropagation(); setConfirmRetry(r) }}
                      >
                        <RotateCcw size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                        {busyId === r.id ? 'Đang gửi…' : 'Retry'}
                      </button>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr className="fm-audit-detail">
                      <td colSpan={7} className="fm-audit-detail-cell" data-full>
                        <div className="fm-audit-detail__inner" onClick={(e) => e.stopPropagation()}>
                          <div><b>Kết quả:</b> {r.resultSummary ?? (r.ok ? 'OK' : '—')}</div>
                          {r.error && <div className="fm-audit-error"><b>Lỗi:</b> {r.error}</div>}
                          {r.retryOf && <div><b>Retry của:</b> {r.retryOf}</div>}
                          {r.payload && (
                            <>
                              <div style={{ marginTop: 6 }}><b>Payload đã gửi:</b></div>
                              <pre className="fm-audit-payload">{r.payload}</pre>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 12 }}>
            <button className="fm-btn fm-btn--ghost fm-btn--sm" disabled={page <= 1} onClick={() => load(page - 1, status, q)}>← Trước</button>
            <span className="fm-hint">Trang {page}/{totalPages}</span>
            <button className="fm-btn fm-btn--ghost fm-btn--sm" disabled={page >= totalPages} onClick={() => load(page + 1, status, q)}>Sau →</button>
          </div>
        )}
      </div>

      {/* Xác nhận Retry — z-index 75: trên bottom tab bar (65), ngang hàng modal thường */}
      {confirmRetry && (
        <div className="fm-drawer-backdrop" style={{ zIndex: 75 }} onClick={() => setConfirmRetry(null)}>
          <div
            className="fm-card"
            style={{ maxWidth: 460, margin: '10vh auto 0', position: 'relative', zIndex: 76, cursor: 'default' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2 className="fm-card__title">Xác nhận Retry</h2>
            <p className="fm-card__desc">
              Gửi lại <b>{confirmRetry.method} {fmtPath(confirmRetry.path)}</b> lên Service Layer?
              {confirmRetry.method === 'POST' && (
                <span style={{ color: 'var(--fm-red)', fontWeight: 600 }}>
                  {' '}Lưu ý: với POST /Orders, SAP sẽ tạo CHỨNG TỪ MỚI — có thể trùng đơn nếu lệnh gốc thực tế đã thành công.
                </span>
              )}
              {confirmRetry.method === 'PATCH' && (
                <span style={{ color: 'var(--fm-amber, #B8860B)', fontWeight: 600 }}>
                  {' '}Lệnh PATCH sẽ cập nhật lại chứng từ theo payload đã lưu — chỉ chạy được khi chứng từ còn Open.
                </span>
              )}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--ghost" onClick={() => setConfirmRetry(null)}>Hủy</button>
              <button className="fm-btn fm-btn--primary" disabled={busyId === confirmRetry.id} onClick={() => doRetry(confirmRetry)}>
                <RotateCcw size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                {busyId === confirmRetry.id ? 'Đang gửi…' : 'Retry ngay'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
