'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useFocusTrap } from './use-focus-trap'
import { History, RefreshCw, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import PageHeader from './page-header'

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
  new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

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
  const [confirmClear, setConfirmClear] = useState(false)

  // Focus trap + Escape cho 2 dialog xac nhan
  const closeDialogs = () => {
    setConfirmRetry(null)
    setConfirmClear(false)
  }
  const retryModalRef = useFocusTrap<HTMLDivElement>(!!confirmRetry, closeDialogs)
  const clearModalRef = useFocusTrap<HTMLDivElement>(!!confirmClear, closeDialogs)

  const loadSeq = useRef(0)
  const load = useCallback(async (p: number, st: string, query: string) => {
    // Guard chống race: gõ tìm kiếm nhanh → response cũ về sau phải bị bỏ
    const seq = ++loadSeq.current
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: '20', status: st })
      if (query.trim()) sp.set('q', query.trim())
      const res = await api(`/api/sap-audit?${sp.toString()}`)
      if (seq !== loadSeq.current) return
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
      if (seq !== loadSeq.current) return
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setRows([])
    }
  }, [])

  // Debounce 400ms khi gõ tìm kiếm — tránh gọi API mỗi ký tự
  useEffect(() => {
    const t = setTimeout(() => load(1, status, q), 400)
    return () => clearTimeout(t)
  }, [load, status, q])

  const doRetry = async (row: AuditRow) => {
    setBusyId(row.id)
    setMsg(null)
    setConfirmRetry(null)
    try {
      const res = await api(`/api/sap-audit/${row.id}/retry`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Thử lại thất bại' })
      } else if (json.ok) {
        setMsg({ type: 'success', text: `Thử lại ${row.method} ${row.path} thành công${json.result?.DocNum ? ` — DocNum ${json.result.DocNum}` : ''}.` })
      } else {
        setMsg({ type: 'error', text: `Thử lại ${row.method} ${row.path} LỖI (HTTP ${json.httpStatus ?? '?'})${json.error ? `: ${json.error}` : ''}` })
      }
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setBusyId(null)
      await load(page, status, q)
    }
  }

  const clearLog = async () => {
    setConfirmClear(false)
    const res = await api('/api/sap-audit', { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (res.ok) {
      setMsg({ type: 'success', text: 'Đã xóa toàn bộ nhật ký' })
      await load(1, status, q)
    } else {
      setMsg({ type: 'error', text: json.error ?? 'Không xóa được nhật ký' })
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Quản trị & Hệ thống', 'Service Layer Audit']}
        title="Nhật ký gọi SAP B1 Service Layer"
actions={<>
          <button className="fm-btn fm-btn--secondary" onClick={() => load(1, status, q)}>
            <RefreshCw size={14} /> Tải lại
          </button>
          <button className="fm-btn fm-btn--secondary" onClick={() => setConfirmClear(true)}>
            <Trash2 size={14} /> Xóa nhật ký
          </button>
        </>}
      />
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{' '}{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm fm-ml-auto" aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <History size={18} /> Nhật ký gọi SAP B1 Service Layer
        </h2>

        {/* Mobile (≤640px): .fm-filterbar tự chuyển sang lưới 2 cột (mục 15.6 globals.css) —
            KHÔNG đặt display:flex inline vì sẽ đè rule grid của mobile */}
        <div className="fm-filterbar">
          <select className="fm-select" aria-label="Lọc theo trạng thái lệnh gọi" value={status} onChange={(e) => { const v = e.target.value as 'all' | 'ok' | 'error'; setStatus(v) }}>
            <option value="all">Tất cả trạng thái</option>
            <option value="ok">Chỉ thành công</option>
            <option value="error">Chỉ lỗi</option>
          </select>
          <input
            className="fm-input"
            data-search
            placeholder="Tìm theo endpoint (/Orders…)"
            aria-label="Tìm theo endpoint Service Layer"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, status, q)}
          />
          <span className="fm-chip fm-chip--role">{total} bản ghi</span>
        </div>

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th style={{ width: 148 }}>Thời gian</th>
                <th style={{ width: 64 }}>Phương thức</th>
                <th style={{ minWidth: 210 }}>Endpoint</th>
                <th style={{ width: 110 }}>Kết quả</th>
                <th className="fm-num" style={{ width: 90 }}>Ms</th>
                <th style={{ width: 96 }}>Thử lại</th>
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
                  <tr
                    className={r.ok ? '' : 'fm-audit-row--err'}
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    style={{ cursor: 'pointer' }}
                    tabIndex={0}
                    aria-expanded={expanded === r.id}
                    aria-label={`${r.method} ${fmtPath(r.path)} — ${r.ok ? 'thành công' : 'lỗi'}. Bấm để xem chi tiết.`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setExpanded(expanded === r.id ? null : r.id)
                      }
                    }}
                  >
                    <td data-label="">{expanded === r.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td data-label="Thời gian">{fmtTime(r.createdAt)}</td>
                    <td data-label="Phương thức">
                      <span className={`fm-line-meta ${r.method === 'POST' ? 'fm-audit-method--post' : r.method === 'PATCH' ? 'fm-audit-method--patch' : ''}`}>{r.method}</span>
                    </td>
                    <th scope="row" data-label="Endpoint" data-full title={r.path}>{fmtPath(r.path)}</th>
                    <td data-label="Kết quả">
                      <span className={`fm-chip ${r.ok ? 'fm-chip--sap' : 'fm-chip--overdue'}`} title={r.error ?? r.resultSummary ?? ''}>
                        {r.ok ? 'OK' : 'LỖI'}{r.httpStatus != null && r.httpStatus > 0 ? ` ${r.httpStatus}` : ''}
                      </span>
                      {r.retryOf && <span className="fm-chip fm-chip--role" style={{ marginLeft: 4 }} title="Kết quả của lệnh Thử lại">↻</span>}
                    </td>
                    <td className="fm-num" data-label="Ms">{r.durationMs}</td>
                    <td data-label="Thử lại">
                      <button
                        className="fm-btn fm-btn--ghost fm-btn--sm"
                        title={r.method === 'POST' ? 'Gửi lại payload lên Service Layer (POST /Orders sẽ tạo chứng từ MỚI)' : r.method === 'PATCH' ? 'Gửi lại payload PATCH để cập nhật lại chứng từ' : 'Gọi lại endpoint GET này'}
                        aria-label={`Thử lại ${r.method} ${fmtPath(r.path)}`}
                        disabled={busyId === r.id}
                        onClick={(e) => { e.stopPropagation(); setConfirmRetry(r) }}
                      >
                        <RotateCcw size={14} />
                        {busyId === r.id ? 'Đang gửi…' : 'Thử lại'}
                      </button>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr className="fm-audit-detail">
                      <td colSpan={7} className="fm-audit-detail-cell" data-full>
                        <div className="fm-audit-detail__inner" onClick={(e) => e.stopPropagation()}>
                          <div><b>Kết quả:</b> {r.resultSummary ?? (r.ok ? 'OK' : '—')}</div>
                          {r.error && <div className="fm-audit-error"><b>Lỗi:</b> {r.error}</div>}
                          {r.retryOf && <div><b>Thử lại của:</b> {r.retryOf}</div>}
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

        <FmPagination page={page} totalPages={totalPages} onPage={(p) => load(p, status, q)} />
      </div>

      {/* Xác nhận Thử lại — dùng .fm-backdrop chung (z-index 81: trên drawer mobile) */}
      {confirmRetry && (
        <div className="fm-backdrop" onClick={() => setConfirmRetry(null)}>
          <div
            ref={retryModalRef}
            tabIndex={-1}
            className="fm-modal"
            style={{ maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={`Xác nhận thử lại ${confirmRetry.method} ${fmtPath(confirmRetry.path)}`}
          >
            <h2 className="fm-modal__title">Xác nhận thử lại</h2>
            <p className="fm-card__desc">
              Gửi lại <b>{confirmRetry.method} {fmtPath(confirmRetry.path)}</b> lên Service Layer?
              {confirmRetry.method === 'POST' && (
                <span style={{ color: 'var(--fm-coral-deep)', fontWeight: 600 }}>
                  {' '}Lưu ý: với POST /Orders, SAP sẽ tạo CHỨNG TỪ MỚI — có thể trùng đơn nếu lệnh gốc thực tế đã thành công.
                </span>
              )}
              {confirmRetry.method === 'PATCH' && (
                <span style={{ color: 'var(--fm-gold-ink)', fontWeight: 600 }}>
                  {' '}Lệnh PATCH sẽ cập nhật lại chứng từ theo payload đã lưu — chỉ chạy được khi chứng từ còn Open.
                </span>
              )}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--ghost" onClick={() => setConfirmRetry(null)}>Hủy</button>
              <button
                className={`fm-btn ${confirmRetry.method === 'POST' ? 'fm-btn--danger' : 'fm-btn--primary'}`}
                disabled={busyId === confirmRetry.id}
                onClick={() => doRetry(confirmRetry)}
              >
                <RotateCcw size={14} />
                {busyId === confirmRetry.id ? 'Đang gửi…' : 'Thử lại ngay'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Xác nhận Xóa log — dùng cùng pattern modal như Thử lại (không dùng window.confirm) */}
      {confirmClear && (
        <div className="fm-backdrop" onClick={() => setConfirmClear(false)}>
          <div
            ref={clearModalRef}
            tabIndex={-1}
            className="fm-modal"
            style={{ maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Xác nhận xóa nhật ký Service Layer"
          >
            <h2 className="fm-modal__title">Xóa nhật ký Audit?</h2>
            <p className="fm-card__desc">
              Xóa <b>TOÀN BỘ</b> nhật ký gọi Service Layer đã ghi nhận. Hành động không thể hoàn tác.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--ghost" onClick={() => setConfirmClear(false)}>Hủy</button>
              <button className="fm-btn fm-btn--danger" onClick={clearLog}>
                <Trash2 size={14} />
                Xóa toàn bộ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
