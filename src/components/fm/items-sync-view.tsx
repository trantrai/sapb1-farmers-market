'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Boxes, RefreshCw, Trash2, Search, DatabaseZap, RotateCcw, Square } from 'lucide-react'
import { api, safeJson } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import { useSyncProgress, SyncProgressCard, type SyncProgress } from './sync-progress'
import SyncModePicker, { fmtWatermark, type SyncMode } from './sync-mode-picker'
import PageHeader from './page-header'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'

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
  watermark: { date: string | null; time: number | null; lastMode: string | null; lastSyncAt: string | null } | null
}

const fmtVND = (n: number) => new Intl.NumberFormat('vi-VN').format(n)
const fmtNum = (n: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(n)
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function ItemsSyncView({ initialQuery = '' }: { initialQuery?: string }) {
  const [rows, setRows] = useState<ItemRow[] | null>(null)
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState(initialQuery)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState<'sync' | 'clear' | null>(null)
  /** Đang gửi yêu cầu dừng lượt sync nền (PATCH) — nút "Dừng" bị khóa tạm */
  const [cancelling, setCancelling] = useState(false)
  const [mode, setMode] = useState<SyncMode>('auto')
  const loadRef = useRef<() => void>(() => {})

  // Tiến trình đồng bộ chạy nền — poll GET 2s/lần, xong thì báo + tải lại danh mục.
  // (hook nằm TRƯỚC load; gọi load muộn qua loadRef để tránh dùng biến trước khai báo)
  const { progress, setProgress, startPolling } = useSyncProgress('/api/items/sync', (p: SyncProgress) => {
    setBusy(null)
    setCancelling(false)
    if (p.error) setMsg({ type: 'error', text: p.error })
    else if (p.message.includes('Đã dừng')) setMsg({ type: 'info', text: p.message })
    else setMsg({ type: 'success', text: p.message || 'Đồng bộ hoàn tất' })
    loadRef.current()
  })

  const loadSeq = useRef(0)
  const load = useCallback(async (p = page, query = q) => {
    // Guard chống race: gõ tìm kiếm nhanh → response cũ về sau phải bị bỏ
    const seq = ++loadSeq.current
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: '20' })
      if (query.trim()) sp.set('q', query.trim())
      const res = await api(`/api/items/sync?${sp.toString()}`)
      if (seq !== loadSeq.current) return
      if (res.status === 401) { window.location.reload(); return }
      const json: any = await safeJson(res)
      if (!res.ok) {
        setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Lỗi máy chủ (HTTP ${res.status}) — hãy thử lại hoặc liên hệ quản trị` : 'Không tải được danh mục mặt hàng') })
        setRows([])
        return
      }
      setRows(json?.data ?? [])
      setTotal(json?.total ?? 0)
      setTotalPages(json?.totalPages ?? 1)
      setPage(json?.page ?? p)
      setSt(json?.status ?? null)
      // Vào màn giữa chừng lượt đồng bộ đang chạy → tiếp tục vẽ tiến trình
      const pr = json?.status?.progress
      if (pr?.running) {
        setProgress(pr)
        setBusy('sync')
        startPolling()
      }
    } catch {
      if (seq !== loadSeq.current) return
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setRows([])
    }
  }, [page, q, startPolling])

  useEffect(() => { load(1, initialQuery) }, [])
  // onDone → luôn gọi bản load mới nhất (q/page hiện tại)
  useEffect(() => { loadRef.current = () => { void load(1, q) } })

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

  const doSync = async () => {
    setBusy('sync')
    setMsg(null)
    try {
      const body = mode === 'auto' ? undefined : { mode }
      const res = await api('/api/items/sync', { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })
      const json: any = await safeJson(res)
      if (!res.ok) {
        setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Lỗi máy chủ (HTTP ${res.status}) — hãy thử lại hoặc liên hệ quản trị` : 'Đồng bộ thất bại') })
        setBusy(null)
        return
      }
      // 202 — tác vụ chạy nền: hiện thanh tiến trình + poll 2s/lần
      setProgress({ running: true, phase: 'connect', message: json?.message ?? 'Đã bắt đầu đồng bộ…', fetched: 0, processed: 0, total: 0, error: '', startedAt: new Date().toISOString(), finishedAt: '' })
      startPolling()
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setBusy(null)
    }
  }

  /** Dừng lượt đồng bộ nền đang chạy — gửi cờ cancel, server tự dừng ở checkpoint tiếp theo */
  const doCancel = async () => {
    if (cancelling) return
    setCancelling(true)
    try {
      const res = await api('/api/items/sync', { method: 'PATCH' })
      const json: any = await safeJson(res)
      if (res.ok) {
        setMsg({ type: 'info', text: json?.message ?? 'Đã gửi yêu cầu dừng đồng bộ' })
        // Giữ polling cho tới khi server kết thúc lượt (onDone báo "Đã dừng…")
      } else {
        setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Lỗi máy chủ (HTTP ${res.status})` : 'Không dừng được đồng bộ') })
        setCancelling(false)
      }
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setCancelling(false)
    }
  }

  const doClear = async () => {
    setConfirmCfg(null)
    setBusy('clear')
    setMsg(null)
    try {
      const res = await api('/api/items/sync', { method: 'DELETE' })
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

  const askClear = () => {
    setConfirmCfg({
      title: 'Xóa dữ liệu đã đồng bộ',
      message: 'Xóa TOÀN BỘ dữ liệu mặt hàng đã đồng bộ trong CSDL local? Danh mục trên SAP B1 không bị ảnh hưởng.',
      confirmLabel: 'Xóa hết',
      tone: 'danger',
      run: () => { void doClear() },
    })
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Đồng bộ dữ liệu', 'Đồng bộ Mặt hàng']}
        title="Quản lý đồng bộ mặt hàng"
        badge="Cập nhật tức thời"
        actions={<>
<button className="fm-btn fm-btn--primary" disabled={busy !== null} onClick={doSync} title="Tải mặt hàng từ SAP B1 về CSDL local (chạy nền, có thanh tiến trình)">
            <RefreshCw size={14} className={busy === 'sync' ? 'fm-spin' : ''} />
            {busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ ngay từ SAP B1'}
          </button>
          {progress?.running && (
            <button className="fm-btn fm-btn--secondary" disabled={cancelling} onClick={doCancel} title="Dừng lượt đồng bộ đang chạy — tác vụ nền sẽ kết thúc ở checkpoint tiếp theo">
              <Square size={14} /> {cancelling ? 'Đang dừng…' : 'Dừng'}
            </button>
          )}
          <button className="fm-btn fm-btn--secondary" onClick={() => load(1, q)}>
            <RotateCcw size={14} /> Tải lại
          </button>
          <button className="fm-btn fm-btn--secondary" disabled={busy !== null || (st?.count ?? 0) === 0} onClick={askClear} title="Xóa toàn bộ dữ liệu mặt hàng đã đồng bộ trong CSDL local">
            <Trash2 size={14} /> Xóa cache local
          </button>
        </>}
      />
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      {/* ===== Thanh tiến trình đồng bộ nền (hiện khi đang chạy) ===== */}
      <SyncProgressCard progress={progress} />

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Boxes size={18} /> Đồng bộ Mặt hàng từ SAP B1
        </h2>

        {/* Trạng thái đồng bộ */}
        <div className="fm-statusbar">
          <span className={`fm-chip ${st?.configured ? 'fm-chip--sap' : 'fm-chip--overdue'}`} title="Trạng thái kết nối Service Layer">
            {st?.configured ? 'SAP B1 đã kết nối' : 'Chưa cấu hình SAP B1'}
          </span>
          <span className="fm-chip fm-chip--role"><DatabaseZap size={14} />{st?.count ?? 0} mặt hàng local</span>
          <span className="fm-chip fm-chip--role">Đồng bộ cuối: {st?.lastSyncAt ? fmtTime(st.lastSyncAt) : 'chưa bao giờ'}</span>
          <span className="fm-chip fm-chip--role" title="Mốc thay đổi (UpdateDate/UpdateTime) lớn nhất đã đồng bộ từ SAP — lượt gia tăng chỉ tải bản ghi mới hơn mốc này">
            Mốc SAP: {fmtWatermark(st?.watermark?.date ?? null, st?.watermark?.time ?? null)}
          </span>
          <span style={{ marginLeft: 'auto' }}>
            <SyncModePicker mode={mode} onChange={setMode} disabled={busy !== null} hasWatermark={!!st?.watermark?.date} />
          </span>
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
            <Search size={14} style={{ verticalAlign: -2, marginRight: 4 }} /> Tìm
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
                  <th scope="row" data-label="Mã hàng"><b>{r.itemCode}</b></th>
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

        <FmPagination page={page} totalPages={totalPages} onPage={(p) => load(p, q)} />
      </div>
      {/* Dialog xác nhận chung thay window.confirm() */}
      {confirmCfg && (
        <ConfirmDialog
          open
          title={confirmCfg.title}
          message={confirmCfg.message}
          confirmLabel={confirmCfg.confirmLabel}
          tone={confirmCfg.tone}
          onConfirm={confirmCfg.run}
          onCancel={() => setConfirmCfg(null)}
        />
      )}
    </div>
  )
}
