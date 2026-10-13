'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Percent, RefreshCw, Trash2, Search, DatabaseZap } from 'lucide-react'
import { api, safeJson } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import { useSyncProgress, SyncProgressCard, type SyncProgress } from './sync-progress'
import SyncModePicker, { fmtWatermark, type SyncMode } from './sync-mode-picker'
import PageHeader from './page-header'

// ============================================================
// ĐỒNG BỘ NHÓM THUẾ — quản lý bản mirror danh mục /VatGroups
// (OVTG) của SAP B1 trong CSDL local: xem/tìm toàn bộ nhóm thuế
// bán (S) và mua (P), đồng bộ ngay từ Service Layer (kèm lịch sử
// suất VTG1 → lấy suất hiệu lực hôm nay), xóa dữ liệu đã đồng bộ.
// ============================================================

interface VatRow {
  id: string
  code: string
  category: string // 'S' | 'P'
  name: string
  rate: number | null
  syncedAt: string | null
}

interface SyncStatus {
  configured: boolean
  count: number
  salesCount: number
  purchaseCount: number
  missingRateCount: number
  lastSyncAt: string | null
  watermark: { date: string | null; time: number | null; lastMode: string | null; lastSyncAt: string | null } | null
}

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function VatGroupsSyncView() {
  const [rows, setRows] = useState<VatRow[] | null>(null)
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<'' | 'S' | 'P'>('')
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState<'sync' | 'clear' | null>(null)
  const [mode, setMode] = useState<SyncMode>('auto')
  const loadRef = useRef<() => void>(() => {})

  // Tiến trình đồng bộ chạy nền — poll GET 2s/lần, xong thì báo + tải lại danh mục.
  // (hook nằm TRƯỚC load; gọi load muộn qua loadRef để tránh dùng biến trước khai báo)
  const { progress, setProgress, startPolling } = useSyncProgress('/api/vatgroups/sync', (p: SyncProgress) => {
    setBusy(null)
    if (p.error) setMsg({ type: 'error', text: p.error })
    else setMsg({ type: 'success', text: p.message || 'Đồng bộ hoàn tất.' })
    loadRef.current()
  })

  const loadSeq = useRef(0)
  const load = useCallback(async (p = page, query = q, category: '' | 'S' | 'P' = cat) => {
    // Guard chống race: gõ tìm kiếm nhanh → response cũ về sau phải bị bỏ
    const seq = ++loadSeq.current
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: '20' })
      if (query.trim()) sp.set('q', query.trim())
      if (category) sp.set('cat', category)
      const res = await api(`/api/vatgroups/sync?${sp.toString()}`)
      if (seq !== loadSeq.current) return
      if (res.status === 401) { window.location.reload(); return }
      const json: any = await safeJson(res)
      if (!res.ok) {
        setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Máy chủ lỗi HTTP ${res.status} — kiểm tra server.log` : 'Không tải được danh mục nhóm thuế') })
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
  }, [page, q, cat, startPolling])

  useEffect(() => { load(1, '', '') }, [])
  // onDone → luôn gọi bản load mới nhất (q/cat hiện tại)
  useEffect(() => { loadRef.current = () => { void load(1, q, cat) } })

  const doSync = async () => {
    setBusy('sync')
    setMsg(null)
    try {
      const body = mode === 'auto' ? undefined : { mode }
      const res = await api('/api/vatgroups/sync', { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) })
      const json: any = await safeJson(res)
      if (!res.ok) {
        setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Máy chủ lỗi HTTP ${res.status} — kiểm tra server.log` : 'Đồng bộ thất bại') })
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

  const doClear = async () => {
    if (!window.confirm('Xóa TOÀN BỘ dữ liệu nhóm thuế đã đồng bộ trong CSDL local? Danh mục trên SAP B1 không bị ảnh hưởng.')) return
    setBusy('clear')
    setMsg(null)
    try {
      const res = await api('/api/vatgroups/sync', { method: 'DELETE' })
      const json: any = await safeJson(res)
      if (res.ok) setMsg({ type: 'success', text: json?.message ?? 'Đã xóa dữ liệu đồng bộ.' })
      else setMsg({ type: 'error', text: json?.error ?? (json === undefined ? `Máy chủ lỗi HTTP ${res.status} — kiểm tra server.log` : 'Không xóa được dữ liệu') })
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setBusy(null)
      await load(1, q, cat)
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Đồng bộ dữ liệu', 'Đồng bộ Nhóm thuế']}
        title="Quản lý đồng bộ nhóm thuế"
        badge="Cập nhật tức thời"
        actions={<>
<button className="fm-btn fm-btn--primary" disabled={busy !== null} onClick={doSync} title="Tải toàn bộ nhóm thuế từ SAP B1 về CSDL local">
            <RefreshCw size={14} className={busy === 'sync' ? 'fm-spin' : ''} />
            {busy === 'sync' ? 'Đang đồng bộ…' : 'Đồng bộ ngay từ SAP B1'}
          </button>
          <button className="fm-btn fm-btn--secondary" disabled={busy !== null || (st?.count ?? 0) === 0} onClick={doClear} title="Xóa toàn bộ dữ liệu nhóm thuế đã đồng bộ trong CSDL local">
            <Trash2 size={14} /> Xóa dữ liệu
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
          <Percent size={18} /> Đồng bộ Nhóm thuế từ SAP B1
        </h2>

        {/* Trạng thái đồng bộ */}
        <div className="fm-statusbar">
          <span className={`fm-chip ${st?.configured ? 'fm-chip--sap' : 'fm-chip--overdue'}`} title="Trạng thái kết nối Service Layer">
            {st?.configured ? 'SAP B1 đã kết nối' : 'Chưa cấu hình SAP B1'}
          </span>
          <span className="fm-chip fm-chip--role"><DatabaseZap size={13} />{st?.count ?? 0} nhóm thuế local</span>
          <span className="fm-chip fm-chip--role">Bán: {st?.salesCount ?? 0} · Mua: {st?.purchaseCount ?? 0}</span>
          {(st?.missingRateCount ?? 0) > 0 && (
            <span className="fm-chip fm-chip--overdue" title="Số nhóm không tra được thuế suất hiệu lực (không có dòng hiệu lực trong VatGroups_Lines)">
              {st?.missingRateCount} nhóm chưa rõ suất
            </span>
          )}
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
            placeholder="Tìm mã / tên nhóm thuế…"
            aria-label="Tìm kiếm nhóm thuế theo mã hoặc tên"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(1, q, cat)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => load(1, q, cat)}>
            <Search size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Tìm
          </button>
          <button
            className={`fm-chip fm-chip--role fm-chip--btn${cat === '' ? ' is-active' : ''}`}
            onClick={() => { setCat(''); load(1, q, '') }}
          >Tất cả</button>
          <button
            className={`fm-chip fm-chip--role fm-chip--btn${cat === 'S' ? ' is-active' : ''}`}
            onClick={() => { setCat('S'); load(1, q, 'S') }}
            title="Nhóm thuế Bán (Output VAT)"
          >Bán (S)</button>
          <button
            className={`fm-chip fm-chip--role fm-chip--btn${cat === 'P' ? ' is-active' : ''}`}
            onClick={() => { setCat('P'); load(1, q, 'P') }}
            title="Nhóm thuế Mua (Input VAT)"
          >Mua (P)</button>
          <span className="fm-chip fm-chip--role">{total} nhóm</span>
        </div>

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Mã</th>
                <th style={{ width: 76 }}>Loại</th>
                <th style={{ minWidth: 200 }}>Tên nhóm thuế</th>
                <th className="fm-num" style={{ width: 110 }}>Thuế suất (%)</th>
                <th style={{ width: 150 }}>Đồng bộ lúc</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr><td colSpan={5}><div className="fm-empty">Đang tải danh mục…</div></td></tr>
              )}
              {rows !== null && rows.length === 0 && total === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="fm-empty">
                      Chưa có dữ liệu đồng bộ. {st?.configured
                        ? 'Bấm "Đồng bộ ngay từ SAP B1" để tải danh mục nhóm thuế về CSDL.'
                        : 'Hãy vào "Cài đặt SAP B1" nhập thông tin kết nối, sau đó quay lại đây bấm "Đồng bộ ngay".'}
                    </div>
                  </td>
                </tr>
              )}
              {rows !== null && rows.length === 0 && total > 0 && (
                <tr><td colSpan={5}><div className="fm-empty">Không có nhóm thuế nào khớp từ khóa “{q}”.</div></td></tr>
              )}
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td data-label="Mã"><b>{r.code}</b></td>
                  <td data-label="Loại">
                    <span className={`fm-chip ${r.category === 'S' ? 'fm-chip--sap' : 'fm-chip--closed'}`}>
                      {r.category === 'S' ? 'Bán (S)' : 'Mua (P)'}
                    </span>
                  </td>
                  <td data-label="Tên nhóm thuế" data-full>{r.name || '—'}</td>
                  <td className="fm-num" data-label="Thuế suất (%)">
                    {r.rate === null || r.rate === undefined
                      ? <span style={{ color: 'var(--fm-text-3)' }}>— (chưa rõ)</span>
                      : <b>{r.rate.toLocaleString('vi-VN', { maximumFractionDigits: 2 })}</b>}
                  </td>
                  <td data-label="Đồng bộ lúc">{r.syncedAt ? fmtTime(r.syncedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <FmPagination page={page} totalPages={totalPages} onPage={(p) => load(p, q, cat)} />
      </div>
    </div>
  )
}
