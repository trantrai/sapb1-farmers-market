'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { UsersRound, RefreshCw, Trash2, Search, DatabaseZap, RotateCcw } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { useSyncProgress, SyncProgressCard, type SyncProgress } from './sync-progress'
import PageHeader from './page-header'

// ============================================================
// ĐỒNG BỘ KHÁCH HÀNG — quản lý bản mirror danh mục khách hàng
// (/BusinessPartners, CardType='C') của SAP B1 trong CSDL local:
// xem/tìm toàn bộ khách hàng, đồng bộ ngay từ Service Layer,
// xóa dữ liệu đã đồng bộ. Dữ liệu local là dự phòng cho form
// tạo đơn khi Service Layer mất kết nối.
// ============================================================

interface PartnerRow {
  id: string
  cardCode: string
  cardName: string
  address: string | null
  phone: string | null
  email: string | null
  contactPerson: string | null
  contactPhone: string | null
  syncedAt: string | null
}

interface SyncStatus {
  configured: boolean
  count: number
  lastSyncAt: string | null
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function PartnersSyncView() {
  const [rows, setRows] = useState<PartnerRow[] | null>(null)
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState<'sync' | 'clear' | null>(null)
  const loadRef = useRef<() => void>(() => {})

  // Tiến trình đồng bộ chạy nền — poll GET 2s/lần, xong thì báo + tải lại danh mục.
  // (hook nằm TRƯỚC load; gọi load muộn qua loadRef để tránh dùng biến trước khai báo)
  const { progress, setProgress, startPolling } = useSyncProgress('/api/bpartners/sync', (p: SyncProgress) => {
    setBusy(null)
    if (p.error) setMsg({ type: 'error', text: p.error })
    else setMsg({ type: 'success', text: p.message || 'Đồng bộ hoàn tất.' })
    loadRef.current()
  })

  const load = useCallback(async (p = page, query = q) => {
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: '20' })
      if (query.trim()) sp.set('q', query.trim())
      const res = await api(`/api/bpartners/sync?${sp.toString()}`)
      if (res.status === 401) { window.location.reload(); return }
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không tải được danh mục khách hàng' })
        setRows([])
        return
      }
      setRows(json.data ?? [])
      setTotal(json.total ?? 0)
      setTotalPages(json.totalPages ?? 1)
      setPage(json.page ?? p)
      setSt(json.status ?? null)
      // Vào màn giữa chừng lượt đồng bộ đang chạy → tiếp tục vẽ tiến trình
      const pr = json.status?.progress
      if (pr?.running) {
        setProgress(pr)
        setBusy('sync')
        startPolling()
      }
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setRows([])
    }
  }, [page, q, startPolling])

  useEffect(() => { load(1, '') }, [])
  // onDone → luôn gọi bản load mới nhất (q hiện tại)
  useEffect(() => { loadRef.current = () => { void load(1, q) } })

  const doSync = async () => {
    setBusy('sync')
    setMsg(null)
    try {
      const res = await api('/api/bpartners/sync', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Đồng bộ thất bại' })
        setBusy(null)
        return
      }
      // 202 — tác vụ chạy nền: hiện thanh tiến trình + poll 2s/lần
      setProgress({ running: true, phase: 'connect', message: json.message ?? 'Đã bắt đầu đồng bộ…', fetched: 0, processed: 0, total: 0, error: '', startedAt: new Date().toISOString(), finishedAt: '' })
      startPolling()
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setBusy(null)
    }
  }

  const doClear = async () => {
    if (!window.confirm('Xóa TOÀN BỘ dữ liệu khách hàng đã đồng bộ trong CSDL local? Danh mục trên SAP B1 không bị ảnh hưởng.')) return
    setBusy('clear')
    setMsg(null)
    try {
      const res = await api('/api/bpartners/sync', { method: 'DELETE' })
      const json = await res.json()
      if (res.ok) setMsg({ type: 'success', text: json.message ?? 'Đã xóa dữ liệu đồng bộ.' })
      else setMsg({ type: 'error', text: json.error ?? 'Không xóa được dữ liệu' })
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
        breadcrumb={['Đồng bộ dữ liệu', 'Đồng bộ Khách hàng']}
        title="Quản Lý Đồng Bộ Khách Hàng"
        badge="Cập nhật tức thời"
        actions={<>
          <button className="fm-btn fm-btn--primary" disabled={busy !== null} onClick={doSync} title="Tải toàn bộ khách hàng từ SAP B1 về CSDL local">
            <RefreshCw size={14} className={busy === 'sync' ? 'fm-spin' : ''} />
            {busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ ngay từ SAP B1'}
          </button>
          <button className="fm-btn fm-btn--secondary" onClick={() => load(1, q)}>
            <RotateCcw size={14} /> Tải lại
          </button>
          <button className="fm-btn fm-btn--secondary" disabled={busy !== null || (st?.count ?? 0) === 0} onClick={doClear} title="Xóa toàn bộ dữ liệu khách hàng đã đồng bộ trong CSDL local">
            <Trash2 size={14} /> Xóa cache local
          </button>
        </>}
      />
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      {/* ===== Thanh tiến trình đồng bộ nền (hiện khi đang chạy) ===== */}
      <SyncProgressCard progress={progress} />

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <UsersRound size={18} /> Đồng bộ Khách hàng từ SAP B1
        </h2>

        {/* Trạng thái đồng bộ */}
        <div className="fm-statusbar">
          <span className={`fm-chip ${st?.configured ? 'fm-chip--sap' : 'fm-chip--overdue'}`} title="Trạng thái kết nối Service Layer">
            {st?.configured ? 'SAP B1 đã kết nối' : 'Chưa cấu hình SAP B1'}
          </span>
          <span className="fm-chip fm-chip--role"><DatabaseZap size={13} />{st?.count ?? 0} khách hàng local</span>
          <span className="fm-chip fm-chip--role">Đồng bộ cuối: {st?.lastSyncAt ? fmtTime(st.lastSyncAt) : 'chưa bao giờ'}</span>
        </div>

        {/* Mobile (≤640px): .fm-filterbar tự chuyển lưới 2 cột — không đặt display:flex inline */}
        <div className="fm-filterbar">
          <input
            className="fm-input"
            data-search
            placeholder="Tìm mã / tên / điện thoại / email…"
            aria-label="Tìm kiếm khách hàng theo mã, tên, điện thoại hoặc email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, q)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => load(1, q)}>
            <Search size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Tìm
          </button>
          <span className="fm-chip fm-chip--role">{total} khách hàng</span>
        </div>

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Mã KH</th>
                <th style={{ minWidth: 180 }}>Tên đơn vị</th>
                <th style={{ minWidth: 160 }}>Địa chỉ</th>
                <th style={{ minWidth: 140 }}>Người liên hệ</th>
                <th style={{ width: 120 }}>Điện thoại</th>
                <th style={{ minWidth: 150 }}>Email</th>
                <th style={{ width: 150 }}>Đồng bộ lúc</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr><td colSpan={7}><div className="fm-empty">Đang tải danh mục…</div></td></tr>
              )}
              {rows !== null && rows.length === 0 && total === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="fm-empty">
                      Chưa có dữ liệu đồng bộ. {st?.configured
                        ? 'Bấm "Đồng bộ ngay từ SAP B1" để tải danh mục khách hàng về CSDL.'
                        : 'Hãy vào "Cài đặt SAP B1" nhập thông tin kết nối, sau đó quay lại đây bấm "Đồng bộ ngay".'}
                    </div>
                  </td>
                </tr>
              )}
              {rows !== null && rows.length === 0 && total > 0 && (
                <tr><td colSpan={7}><div className="fm-empty">Không có khách hàng nào khớp từ khóa “{q}”.</div></td></tr>
              )}
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td data-label="Mã KH"><b>{r.cardCode}</b></td>
                  <td data-label="Tên đơn vị">{r.cardName}</td>
                  <td data-label="Địa chỉ" data-full>{r.address || '—'}</td>
                  <td data-label="Người liên hệ">{r.contactPerson ? <>{r.contactPerson}{r.contactPhone ? <><br /><small style={{ color: 'var(--fm-text-2)' }}>{r.contactPhone}</small></> : null}</> : '—'}</td>
                  <td data-label="Điện thoại">{r.phone || '—'}</td>
                  <td data-label="Email" data-full>{r.email || '—'}</td>
                  <td data-label="Đồng bộ lúc">{r.syncedAt ? fmtTime(r.syncedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 12 }}>
            <button className="fm-btn fm-btn--ghost fm-btn--sm" disabled={page <= 1} onClick={() => load(page - 1, q)}>← Trước</button>
            <span className="fm-hint">Trang {page}/{totalPages}</span>
            <button className="fm-btn fm-btn--ghost fm-btn--sm" disabled={page >= totalPages} onClick={() => load(page + 1, q)}>Sau →</button>
          </div>
        )}
      </div>
    </div>
  )
}
