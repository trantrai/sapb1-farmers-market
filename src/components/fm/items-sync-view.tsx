'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Boxes, RefreshCw, Trash2, Search, DatabaseZap, RotateCcw } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { useSyncProgress, SyncProgressCard, type SyncProgress } from './sync-progress'
import PageHeader from './page-header'

// ============================================================
// ĐỒNG BỘ MẶT HÀNG — quản lý bản mirror danh mục Sales Item của
// SAP B1 trong CSDL local: xem/tìm toàn bộ mặt hàng bán được,
// đồng bộ ngay từ Service Layer, xóa dữ liệu đã đồng bộ.
// Danh sách local còn là dữ liệu dự phòng khi SL mất kết nối.
// ============================================================

interface ItemRow {
  id: string
  itemCode: string
  itemName: string
  uom: string
  price: number
  stock: number
  taxCode: string | null
  barcode: string | null
  syncedAt: string | null
}

interface SyncStatus {
  configured: boolean
  count: number
  lastSyncAt: string | null
}

const fmtVND = (n: number) => new Intl.NumberFormat('vi-VN').format(n)
const fmtNum = (n: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(n)
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function ItemsSyncView() {
  const [rows, setRows] = useState<ItemRow[] | null>(null)
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
  const { progress, setProgress, startPolling } = useSyncProgress('/api/items/sync', (p: SyncProgress) => {
    setBusy(null)
    if (p.error) setMsg({ type: 'error', text: p.error })
    else setMsg({ type: 'success', text: p.message || 'Đồng bộ hoàn tất.' })
    loadRef.current()
  })

  const load = useCallback(async (p = page, query = q) => {
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: '20' })
      if (query.trim()) sp.set('q', query.trim())
      const res = await api(`/api/items/sync?${sp.toString()}`)
      if (res.status === 401) { window.location.reload(); return }
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không tải được danh mục mặt hàng' })
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
  // onDone → luôn gọi bản load mới nhất (q/page hiện tại)
  useEffect(() => { loadRef.current = () => { void load(1, q) } })

  const doSync = async () => {
    setBusy('sync')
    setMsg(null)
    try {
      const res = await api('/api/items/sync', { method: 'POST' })
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
    if (!window.confirm('Xóa TOÀN BỘ dữ liệu mặt hàng đã đồng bộ trong CSDL local? Danh mục trên SAP B1 không bị ảnh hưởng.')) return
    setBusy('clear')
    setMsg(null)
    try {
      const res = await api('/api/items/sync', { method: 'DELETE' })
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
        breadcrumb={['Đồng bộ dữ liệu', 'Đồng bộ Mặt hàng']}
        title="Quản Lý Đồng Bộ Mặt Hàng (Items)"
        badge="Cập nhật tức thời"
        actions={<>
          <button className="fm-btn fm-btn--primary" disabled={busy !== null} onClick={doSync} title="Tải toàn bộ mặt hàng bán được từ SAP B1 về CSDL local (chạy nền, có thanh tiến trình)">
            <RefreshCw size={14} className={busy === 'sync' ? 'fm-spin' : ''} />
            {busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ ngay từ SAP B1'}
          </button>
          <button className="fm-btn fm-btn--secondary" onClick={() => load(1, q)}>
            <RotateCcw size={14} /> Tải lại
          </button>
          <button className="fm-btn fm-btn--secondary" disabled={busy !== null || (st?.count ?? 0) === 0} onClick={doClear} title="Xóa toàn bộ dữ liệu mặt hàng đã đồng bộ trong CSDL local">
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
          <Boxes size={18} /> Đồng bộ Mặt hàng từ SAP B1
        </h2>
        <p className="fm-card__desc">
          Tạo bản sao danh mục <b>Sales Item</b> (mặt hàng bán được) từ SAP B1 vào CSDL của hệ thống này:
          phục vụ tìm kiếm nhanh, kiểm tra giá/thuế/tồn và làm dữ liệu dự phòng khi Service Layer mất kết nối.
          Đồng bộ lại để cập nhật giá mới nhất.
        </p>

        {/* Trạng thái đồng bộ */}
        <div className="fm-statusbar">
          <span className={`fm-chip ${st?.configured ? 'fm-chip--sap' : 'fm-chip--overdue'}`} title="Trạng thái kết nối Service Layer">
            {st?.configured ? 'SAP B1 đã kết nối' : 'Chưa cấu hình SAP B1'}
          </span>
          <span className="fm-chip fm-chip--role"><DatabaseZap size={13} />{st?.count ?? 0} mặt hàng local</span>
          <span className="fm-chip fm-chip--role">Đồng bộ cuối: {st?.lastSyncAt ? fmtTime(st.lastSyncAt) : 'chưa bao giờ'}</span>
        </div>

        {/* Mobile (≤640px): .fm-filterbar tự chuyển lưới 2 cột — không đặt display:flex inline */}
        <div className="fm-filterbar">
          <input
            className="fm-input"
            data-search
            placeholder="Tìm mã / tên hàng / mã vạch / mã thuế…"
            aria-label="Tìm kiếm mặt hàng theo mã, tên, mã vạch hoặc mã thuế"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, q)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => load(1, q)}>
            <Search size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Tìm
          </button>
          <span className="fm-chip fm-chip--role">{total} mặt hàng</span>
        </div>

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 128 }}>Mã hàng</th>
                <th style={{ minWidth: 200 }}>Tên mặt hàng</th>
                <th style={{ width: 64 }}>ĐVT</th>
                <th className="fm-num" style={{ width: 110 }}>Đơn giá (₫)</th>
                <th className="fm-num" style={{ width: 90 }}>Tồn kho</th>
                <th style={{ width: 80 }}>Mã thuế</th>
                <th style={{ width: 140 }}>Mã vạch</th>
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
                        ? 'Bấm "Đồng bộ ngay từ SAP B1" để tải danh mục mặt hàng bán được về CSDL.'
                        : 'Hãy vào "Cài đặt SAP B1" nhập thông tin kết nối, sau đó quay lại đây bấm "Đồng bộ ngay".'}
                    </div>
                  </td>
                </tr>
              )}
              {rows !== null && rows.length === 0 && total > 0 && (
                <tr><td colSpan={7}><div className="fm-empty">Không có mặt hàng nào khớp từ khóa “{q}”.</div></td></tr>
              )}
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td data-label="Mã hàng"><b>{r.itemCode}</b></td>
                  <td data-label="Tên mặt hàng" data-full>{r.itemName}</td>
                  <td data-label="ĐVT">{r.uom || '—'}</td>
                  <td className="fm-num" data-label="Đơn giá (₫)">{fmtVND(r.price)}</td>
                  <td className="fm-num" data-label="Tồn kho">{fmtNum(r.stock)}</td>
                  <td data-label="Mã thuế">{r.taxCode || '—'}</td>
                  <td data-label="Mã vạch">{r.barcode || '—'}</td>
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
