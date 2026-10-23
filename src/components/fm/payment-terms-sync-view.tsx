'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarClock, RefreshCw, Trash2, Search, DatabaseZap, RotateCcw } from 'lucide-react'
import { api, safeJson } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import PageHeader from './page-header'
import ConfirmDialog from './confirm-dialog'

// ============================================================
// ĐỒNG BỘ ĐIỀU KHOẢN THANH TOÁN — quản lý bản mirror danh mục
// /PaymentTermsTypes (OCTG) của SAP B1 trong CSDL local: xem/tìm,
// đồng bộ ngay từ Service Layer (GroupNum → code, PymntGroup → name),
// xóa dữ liệu đã đồng bộ.
// OCTG rất ít dòng → đồng bộ chạy ĐỒNG BỘ trong request POST,
// view tối giản: nút Đồng bộ + bảng kết quả (không cần progress nền).
// ============================================================

interface PaymentTermRow {
  id: string
  code: number
  name: string
  sapDatabaseId: string | null
  updatedAt: string
}

interface SyncStatus {
  configured: boolean
  count: number
  lastSyncAt: string | null
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function PaymentTermsSyncView() {
  const [rows, setRows] = useState<PaymentTermRow[] | null>(null)
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState<'sync' | 'clear' | null>(null)
  /** Dialog xác nhận xóa toàn bộ dữ liệu đồng bộ (thay window.confirm) */
  const [confirmClear, setConfirmClear] = useState(false)

  const loadSeq = useRef(0)
  const load = useCallback(async (p = page, query = q) => {
    // Guard chống race: gõ tìm kiếm nhanh → response cũ về sau phải bị bỏ
    const seq = ++loadSeq.current
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: '20' })
      if (query.trim()) sp.set('q', query.trim())
      const res = await api(`/api/payment-terms/sync?${sp.toString()}`)
      if (seq !== loadSeq.current) return
      if (res.status === 401) { window.location.reload(); return }
      const json: any = await safeJson(res)
      if (!res.ok) {
        setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Lỗi máy chủ (HTTP ${res.status}) — hãy thử lại hoặc liên hệ quản trị` : 'Không tải được danh mục điều khoản thanh toán') })
        setRows([])
        return
      }
      setRows(json?.data ?? [])
      setTotal(json?.total ?? 0)
      setTotalPages(json?.totalPages ?? 1)
      setPage(json?.page ?? p)
      setSt(json?.status ?? null)
    } catch {
      if (seq !== loadSeq.current) return
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setRows([])
    }
  }, [page, q])

  useEffect(() => { load(1, '') }, [])

  const doSync = async () => {
    setBusy('sync')
    setMsg(null)
    try {
      const res = await api('/api/payment-terms/sync', { method: 'POST' })
      const json: any = await safeJson(res)
      if (!res.ok) {
        setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Lỗi máy chủ (HTTP ${res.status}) — hãy thử lại hoặc liên hệ quản trị` : 'Đồng bộ thất bại') })
      } else {
        setMsg({ type: 'success', text: json?.message ?? 'Đồng bộ hoàn tất' })
        await load(1, q)
      }
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setBusy(null)
    }
  }

  const doClear = async () => {
    setConfirmClear(false)
    setBusy('clear')
    setMsg(null)
    try {
      const res = await api('/api/payment-terms/sync', { method: 'DELETE' })
      const json: any = await safeJson(res)
      if (res.ok) setMsg({ type: 'success', text: json?.message ?? 'Đã xóa dữ liệu đồng bộ' })
      else setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Lỗi máy chủ (HTTP ${res.status}) — hãy thử lại hoặc liên hệ quản trị` : 'Không xóa được dữ liệu') })
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setBusy(null)
      await load(1, q)
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Đồng bộ', 'Đồng bộ Điều khoản thanh toán']}
        title="Quản lý đồng bộ điều khoản thanh toán"
        badge="OCTG · SAP B1"
        actions={<>
          <button className="fm-btn fm-btn--primary" disabled={busy !== null} onClick={doSync} title="Tải toàn bộ điều khoản thanh toán từ SAP B1 về CSDL local">
            <RefreshCw size={14} className={busy === 'sync' ? 'fm-spin' : ''} />
            {busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ ngay từ SAP B1'}
          </button>
          <button className="fm-btn fm-btn--secondary" onClick={() => load(1, q)} title="Tải lại danh mục từ CSDL local">
            <RotateCcw size={14} /> Tải lại
          </button>
          <button className="fm-btn fm-btn--secondary" disabled={busy !== null || (st?.count ?? 0) === 0} onClick={() => setConfirmClear(true)} title="Xóa toàn bộ dữ liệu điều khoản thanh toán đã đồng bộ trong CSDL local">
            <Trash2 size={14} /> Xóa cache local
          </button>
        </>}
      />
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm fm-ml-auto" aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <CalendarClock size={18} /> Đồng bộ Điều khoản thanh toán từ SAP B1
        </h2>

        {/* Trạng thái đồng bộ */}
        <div className="fm-statusbar">
          <span className={`fm-chip ${st?.configured ? 'fm-chip--sap' : 'fm-chip--overdue'}`} title="Trạng thái kết nối Service Layer">
            {st?.configured ? 'SAP B1 đã kết nối' : 'Chưa cấu hình SAP B1'}
          </span>
          <span className="fm-chip fm-chip--role"><DatabaseZap size={14} />{st?.count ?? 0} điều khoản local</span>
          <span className="fm-chip fm-chip--role">Lần đồng bộ cuối: {st?.lastSyncAt ? fmtTime(st.lastSyncAt) : 'chưa bao giờ'}</span>
        </div>

        {/* Mobile (≤640px): .fm-filterbar tự chuyển lưới 2 cột — không đặt display:flex inline */}
        <div className="fm-filterbar">
          <input
            className="fm-input"
            data-search
            placeholder="Tìm mã / tên điều khoản thanh toán…"
            aria-label="Tìm kiếm điều khoản thanh toán theo mã hoặc tên"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, q)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => load(1, q)}>
            <Search size={14} /> Tìm
          </button>
          <span className="fm-chip fm-chip--role">{total} điều khoản</span>
        </div>

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Mã nhóm</th>
                <th style={{ minWidth: 200 }}>Tên điều khoản thanh toán</th>
                <th style={{ width: 150 }}>Đồng bộ lúc</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr><td colSpan={3} style={{ padding: 8 }}>
                  <div aria-busy="true">
                    {Array.from({ length: 6 }, (_, i) => (
                      <div key={i} className="fm-skeleton fm-skeleton--row" />
                    ))}
                  </div>
                </td></tr>
              )}
              {rows !== null && rows.length === 0 && total === 0 && (
                <tr>
                  <td colSpan={3}>
                    <div className="fm-empty">
                      Chưa có dữ liệu đồng bộ. {st?.configured
                        ? 'Bấm "Đồng bộ ngay từ SAP B1" để tải danh mục điều khoản thanh toán về CSDL.'
                        : 'Hãy vào "Cài đặt SAP B1" nhập thông tin kết nối, sau đó quay lại đây bấm "Đồng bộ ngay".'}
                    </div>
                  </td>
                </tr>
              )}
              {rows !== null && rows.length === 0 && total > 0 && (
                <tr><td colSpan={3}><div className="fm-empty">Không có điều khoản thanh toán nào khớp từ khóa “{q}”.</div></td></tr>
              )}
              {rows?.map((r) => (
                <tr key={r.id}>
                  <th scope="row" data-label="Mã nhóm"><b>{r.code}</b></th>
                  <td data-label="Tên điều khoản thanh toán" data-full>{r.name || '—'}</td>
                  <td data-label="Đồng bộ lúc">{r.updatedAt ? fmtTime(r.updatedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <FmPagination page={page} totalPages={totalPages} onPage={(p) => load(p, q)} />
      </div>

      {/* Dialog xác nhận xóa toàn bộ (thay window.confirm) */}
      <ConfirmDialog
        open={confirmClear}
        title="Xóa toàn bộ dữ liệu đồng bộ?"
        message={`Xóa TOÀN BỘ dữ liệu điều khoản thanh toán đã đồng bộ trong CSDL local?\nDanh mục trên SAP B1 không bị ảnh hưởng.\nHành động không thể hoàn tác.`}
        confirmLabel="Xóa toàn bộ"
        tone="danger"
        onConfirm={() => { void doClear() }}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  )
}
