'use client'

// ============================================================
// DANH SÁCH DELIVERY (phiếu giao hàng)
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, Truck, Trash2, CloudUpload, Eye, RefreshCw, Plus, Network } from 'lucide-react'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { docNumLabel } from './sales-doc-shared'
import { api } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import PageHeader from './page-header'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import RelMapModal from './relmap-modal'

interface DeliveryLine {
  id: string
  lineNum: number
  itemCode: string
  itemName: string
  quantity: number
  uom: string
  unitPrice: number
  lineTotal: number
}

interface Delivery {
  id: string
  /** Bản nháp chưa cấp số thật → API trả null (Phase 2); hiển thị qua docNumLabel() */
  docNum: number
  docDate: string
  cardCode: string
  cardName: string
  status: string
  grandTotal: number
  sapDocNum?: number | null
  sapSyncStatus?: string
  /** 'sap' = từ SAP B1 (GET /DeliveryNotes), 'local' = bản ghi local */
  source?: 'sap' | 'local'
  /** Phase 2 — Nháp: true = bản nháp chưa có hiệu lực (API: ?isDraft=) */
  isDraft?: boolean
  /** id bản ghi local tương ứng (nếu phiếu SAP có bản ghi local) */
  localId?: string | null
  sourceOrder?: { id: string; docNum: number } | null
  lines: DeliveryLine[]
}

interface Props {
  onGoDetail: (id: string) => void
  onGoOrderDetail: (orderId: string) => void
  refreshKey?: number
  /** (legacy) — giữ để tương thích, empty state hiện dùng canCreateDelivery/onGoNewDelivery */
  canCreate?: boolean
  onGoCreate?: () => void
  /** Quyền tạo phiếu giao hàng trực tiếp (form tạo mới) */
  canCreateDelivery?: boolean
  onGoNewDelivery?: () => void
}

const STATUS_LABEL: Record<string, string> = {
  Open: 'Mở',
  Closed: 'Đã đóng',
  Cancelled: 'Đã hủy',
}

export default function DeliveriesListView({ onGoDetail, onGoOrderDetail, refreshKey, canCreate, onGoCreate, canCreateDelivery, onGoNewDelivery }: Props) {
  const [rows, setRows] = useState<Delivery[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(10)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  /** Từ khóa đã debounce 300ms — API chỉ gọi theo giá trị này (D5: tránh 1 API call/ký tự) */
  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300)
    return () => clearTimeout(t)
  }, [q])
  const [status, setStatus] = useState('')
  /** Phase 2 — lọc nhanh theo trạng thái nháp: '' | 'true' | 'false' (→ ?isDraft=) */
  const [draftFilter, setDraftFilter] = useState<'' | 'true' | 'false'>('')
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [sapWarn, setSapWarn] = useState('')

  // Scroll tới alert khi có thông báo mới (mobile không bỏ sót thông báo)
  const alertRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (alert) alertRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [alert])

  // D5: race guard — filter đổi nhanh → response cũ về sau bị bỏ, không đè dữ liệu mới
  const loadSeq = useRef(0)
  const load = useCallback(async (fresh = false) => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (debouncedQ.trim()) p.set('q', debouncedQ.trim())
      if (status) p.set('status', status)
      if (draftFilter) p.set('isDraft', draftFilter)
      // fresh = bỏ qua cache 45s phía server, tải mới trực tiếp từ SAP B1
      if (fresh) p.set('fresh', '1')
      const r = await api(`/api/deliveries?${p}`)
      if (seq !== loadSeq.current) return
      const j = await r.json()
      if (r.ok && j.ok) {
        setRows(j.data ?? [])
        setTotal(j.pagination?.total ?? 0)
        setTotalPages(j.pagination?.totalPages ?? 1)
        setSource(j.source ?? '')
        setSapWarn(j.warning ?? '')
      } else {
        setAlert({ type: 'error', msg: j.error ?? 'Không tải được danh sách' })
      }
    } catch {
      if (seq !== loadSeq.current) return
      setAlert({ type: 'error', msg: 'Không kết nối được máy chủ' })
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [page, pageSize, debouncedQ, status, draftFilter])

  useEffect(() => { void load() }, [load, refreshKey])

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

  // Context menu right-click dòng phiếu → "Sơ đồ liên kết" (pattern orders-list-view)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; delivery: Delivery } | null>(null)
  const [relMapDelivery, setRelMapDelivery] = useState<{ id: string; docNum: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Phần tử đã mở context menu (dòng) — trả focus về khi đóng bằng Escape */
  const openerRef = useRef<HTMLElement | null>(null)

  /** Mở context menu tại tọa độ cho trước (kẹp trong viewport) */
  const openCtxMenu = (delivery: Delivery, x: number, y: number) => {
    setCtxMenu({
      x: Math.min(Math.max(x, 8), window.innerWidth - 220),
      y: Math.min(Math.max(y, 8), window.innerHeight - 80),
      delivery,
    })
  }

  const closeCtxMenu = (restoreFocus: boolean) => {
    setCtxMenu(null)
    if (restoreFocus) openerRef.current?.focus({ preventScroll: true })
  }

  // Mở menu → focus vào menuitem đầu tiên
  useEffect(() => {
    if (!ctxMenu) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [ctxMenu])

  // Đóng context menu khi bấm ra ngoài hoặc cuộn
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  const doDelete = async (d: Delivery) => {
    setConfirmCfg(null)
    setBusyId(d.id)
    // Optimistic UI: gỡ dòng khỏi danh sách ngay, rollback nếu API lỗi
    const prevRows = rows
    setRows((rs) => rs.filter((r) => r.id !== d.id))
    try {
      const r = await api(`/api/deliveries/${d.id}`, { method: 'DELETE' })
      const j = await r.json().catch(() => ({}))
      if (r.ok) {
        setAlert({ type: 'success', msg: `Đã xóa phiếu ${docNumLabel(d.docNum, d.isDraft)}` })
        void load()
      } else {
        setRows(prevRows)
        setAlert({ type: 'error', msg: j.error ?? 'Xóa thất bại' })
      }
    } catch {
      setRows(prevRows)
      setAlert({ type: 'error', msg: 'Không kết nối được máy chủ' })
    } finally {
      setBusyId(null)
    }
  }

  const doPush = async (d: Delivery) => {
    // Đẩy SAP tạo chứng từ THẬT — xác nhận trước khi gọi API
    setConfirmCfg(null)
    setBusyId(d.id)
    try {
      const r = await api(`/api/deliveries/${d.id}/push`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setAlert({ type: 'success', msg: j.message ?? 'Đã đẩy sang SAP B1' })
        void load()
      } else {
        setAlert({ type: 'error', msg: j.error ?? 'Đẩy thất bại' })
      }
    } catch {
      setAlert({ type: 'error', msg: 'Không kết nối được máy chủ' })
    } finally {
      setBusyId(null)
    }
  }

  const askDelete = (d: Delivery) => {
    // Phiếu local ĐÃ đẩy SAP: vẫn cho xóa bản ghi local nhưng phải cảnh báo rõ
    // bằng dialog tone warning — chứng từ thật vẫn còn trên SAP B1.
    const synced = d.sapSyncStatus === 'synced'
    setConfirmCfg({
      title: synced ? 'Xóa bản ghi local?' : 'Xóa phiếu giao hàng',
      message: synced
        ? `Phiếu #${d.docNum} đã đẩy lên SAP B1 — chứng từ thật vẫn còn trên SAP, chỉ xóa bản ghi local.\nHành động không thể hoàn tác.`
        : `Xóa phiếu giao hàng #${d.docNum}?\nHành động không thể hoàn tác.`,
      confirmLabel: synced ? 'Chỉ xóa bản ghi local' : 'Xóa',
      tone: synced ? 'warning' : 'danger',
      run: () => { void doDelete(d) },
    })
  }

  const askPush = (d: Delivery) => {
    setConfirmCfg({
      title: 'Đẩy sang SAP B1',
      message: `Đẩy phiếu #${d.docNum} sang SAP B1?\nThao tác tạo chứng từ thật trên SAP và không thể hoàn tác tự động.`,
      confirmLabel: 'Đẩy sang SAP',
      tone: 'warning',
      run: () => { void doPush(d) },
    })
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Giao hàng']}
        title="Quản lý giao hàng"
        actions={<>
          <button className="fm-btn fm-btn--secondary" onClick={() => void load(true)}><RefreshCw size={14} /> Tải lại</button>
          {canCreateDelivery && onGoNewDelivery && (
            <button className="fm-btn fm-btn--primary" onClick={onGoNewDelivery}><Plus size={14} /> Tạo phiếu giao hàng</button>
          )}
          <span className="fm-hint">{total} phiếu{source === 'sap' ? ' · từ SAP B1' : ''}</span>
        </>}
      />

      {sapWarn && (
        <div className="fm-hint" style={{ color: 'var(--fm-red)', marginBottom: 8 }} role="alert">⚠ {sapWarn}</div>
      )}

      {alert && (
        <div ref={alertRef} className={`fm-alert fm-alert--${alert.type === 'success' ? 'success' : 'error'}`} role={alert.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12 }}>
          {alert.msg}
        </div>
      )}

      {/* Lọc nhanh theo bản nháp (Phase 2) */}
      <div className="fm-quickfilter" role="group" aria-label="Lọc nhanh theo bản nháp" style={{ marginBottom: 10 }}>
        {([
          { key: '', label: 'Tất cả' },
          { key: 'false', label: 'Chính thức' },
          { key: 'true', label: 'Nháp' },
        ] as const).map((f) => (
          <button
            key={f.key}
            type="button"
            className={`fm-btn fm-btn--sm ${draftFilter === f.key ? 'fm-btn--primary' : 'fm-btn--secondary'}`}
            onClick={() => { setDraftFilter(f.key); setPage(1) }}
            aria-pressed={draftFilter === f.key}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="fm-filters">
        <div className="fm-search" style={{ flex: '1 1 220px' }}>
          <Search size={16} className="fm-search__icon" />
          <input
            className="fm-search__input"
            placeholder="Tìm mã khách hàng, tên khách hàng, số phiếu…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1) }}
            aria-label="Tìm kiếm phiếu giao hàng"
          />
        </div>
        <select
          className="fm-input"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          aria-label="Lọc theo trạng thái"
          style={{ width: 'auto' }}
        >
          <option value="">Tất cả trạng thái</option>
          <option value="Open">Mở</option>
          <option value="Closed">Đã đóng</option>
          <option value="Cancelled">Đã hủy</option>
        </select>
      </div>

      <div className="fm-card">
        <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
          <table className="fm-table">
            <thead>
              <tr>
                <th>Số phiếu</th>
                <th>Ngày giao</th>
                <th>Khách hàng</th>
                <th>Đơn nguồn</th>
                <th>Trạng thái</th>
                <th>SAP</th>
                <th className="fm-num">Tổng chứng từ</th>
                <th><span className="fm-sr-only">Thao tác</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ padding: 8 }}>
                  <div aria-busy="true">
                    {Array.from({ length: 6 }, (_, i) => (
                      <div key={i} className="fm-skeleton fm-skeleton--row" />
                    ))}
                  </div>
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8}><div className="fm-empty"><Truck />Chưa có phiếu giao hàng nào. Tạo phiếu giao hàng từ chi tiết đơn hàng (nút “Sao chép sang phiếu giao hàng”).
                  {canCreateDelivery && onGoNewDelivery && (
                    <button type="button" className="fm-btn fm-btn--primary" style={{ marginTop: 10 }} onClick={onGoNewDelivery}>
                      <Plus size={16} /> Tạo phiếu giao hàng
                    </button>
                  )}
                </div></td></tr>
              ) : rows.map((d) => (
                <tr
                  key={d.id}
                  tabIndex={0}
                  style={{ cursor: 'pointer' }}
                  title="Bấm để xem chi tiết — Chuột phải để xem sơ đồ liên kết"
                  aria-label={`Xem chi tiết phiếu giao hàng #${d.docNum} — ${d.cardName}`}
                  onClick={() => onGoDetail(d.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openerRef.current = e.currentTarget
                    openCtxMenu(d, e.clientX, e.clientY)
                  }}
                  onKeyDown={(e) => {
                    // Shift+F10: mở context menu tại dòng đang focus (tương đương right-click)
                    if (e.shiftKey && e.key === 'F10') {
                      e.preventDefault()
                      e.stopPropagation()
                      openerRef.current = e.currentTarget
                      const r = e.currentTarget.getBoundingClientRect()
                      openCtxMenu(d, r.left + 80, r.bottom - 20)
                      return
                    }
                    // Enter/Space: mở chi tiết — cùng pattern với orders-list-view
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onGoDetail(d.id)
                    }
                  }}
                >
                  <th scope="row"><b>{docNumLabel(d.docNum, d.isDraft)}</b></th>
                  <td>{formatDateVN(d.docDate)}</td>
                  <td>
                    <div><b>{d.cardCode}</b></div>
                    <div style={{ fontSize: 12, color: 'var(--fm-text-2)' }}>{d.cardName}</div>
                  </td>
                  <td>
                    {d.sourceOrder ? (
                      <button
                        type="button"
                        className="fm-link"
                        onClick={(e) => { e.stopPropagation(); onGoOrderDetail(d.sourceOrder!.id) }}
                        title={`Xem đơn hàng bán #${d.sourceOrder.docNum}`}
                      >
                        SO #{d.sourceOrder.docNum}
                      </button>
                    ) : '—'}
                  </td>
                  <td>
                    <span className={`fm-chip fm-chip--${d.status.toLowerCase()}`}>{STATUS_LABEL[d.status] ?? d.status}</span>{d.isDraft && <span className="fm-chip fm-chip--warn" title="Bản nháp — chưa có hiệu lực">Nháp</span>}
                  </td>
                  <td>
                    {d.source === 'sap' ? (
                      <span className="fm-chip fm-chip--sap" title={`DocEntry ${d.id.replace('sap-', '')} — từ SAP B1`}>SAP B1</span>
                    ) : d.sapSyncStatus === 'synced' ? (
                      <span className="fm-chip fm-chip--sap" title={`DocNum ${d.sapDocNum}`}>Đã đẩy</span>
                    ) : d.sapSyncStatus === 'pending' ? (
                      <span className="fm-chip fm-chip--error">Lỗi đẩy</span>
                    ) : (
                      <span className="fm-hint">Chưa đẩy</span>
                    )}
                  </td>
                  <td className="fm-num"><b>{formatVND(d.grandTotal)}</b></td>
                  <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        type="button"
                        className="fm-btn fm-btn--ghost fm-btn--sm"
                        onClick={() => onGoDetail(d.id)}
                        title="Xem chi tiết"
                        aria-label={`Xem chi tiết phiếu ${d.docNum}`}
                      >
                        <Eye size={16} />
                      </button>
                      {/* W26: nút Sơ đồ liên kết hiển thị rõ trên mỗi dòng (desktop), tái dùng modal của context menu */}
                      <button
                        type="button"
                        className="fm-btn fm-btn--ghost fm-btn--sm"
                        onClick={() => setRelMapDelivery({ id: d.id, docNum: d.docNum })}
                        title="Sơ đồ liên kết"
                        aria-label={`Sơ đồ liên kết phiếu ${d.docNum}`}
                      >
                        <Network size={16} />
                      </button>
                      {!d.isDraft && d.sapSyncStatus !== 'synced' && d.status !== 'Cancelled' && (
                        <button
                          type="button"
                          className="fm-btn fm-btn--ghost fm-btn--sm"
                          onClick={() => askPush(d)}
                          disabled={busyId === d.id}
                          title="Đẩy sang SAP B1"
                          aria-label={`Đẩy phiếu ${d.docNum} sang SAP`}
                        >
                          <CloudUpload size={16} />
                        </button>
                      )}
                      {d.source !== 'sap' && (
                        <button
                          type="button"
                          className="fm-btn fm-btn--ghost fm-btn--sm"
                          onClick={() => askDelete(d)}
                          disabled={busyId === d.id}
                          title="Xóa"
                          aria-label={`Xóa phiếu ${d.docNum}`}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Danh sách card (mobile) — thay bảng 8 cột cuộn ngang */}
        <div className="fm-only-mobile">
          {loading ? (
            <div aria-busy="true" style={{ padding: '8px 4px' }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="fm-skeleton fm-skeleton--row" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="fm-empty"><Truck />Chưa có phiếu giao hàng nào. Tạo phiếu giao hàng từ chi tiết đơn hàng (nút “Sao chép sang phiếu giao hàng”).
              {canCreateDelivery && onGoNewDelivery && (
                <button type="button" className="fm-btn fm-btn--primary" style={{ marginTop: 10 }} onClick={onGoNewDelivery}>
                  <Plus size={16} /> Tạo phiếu giao hàng
                </button>
              )}
            </div>
          ) : rows.map((d) => (
            <div
              key={d.id}
              className="fm-ocard"
              role="button"
              tabIndex={0}
              aria-label={`Xem chi tiết phiếu giao hàng #${d.docNum} — ${d.cardName}`}
              onClick={() => onGoDetail(d.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onGoDetail(d.id)
                }
              }}
            >
              <div className="fm-ocard__top">
                <span className="fm-ocard__num">{docNumLabel(d.docNum, d.isDraft)}</span>
                <span className={`fm-chip fm-chip--${d.status.toLowerCase()}`}>{STATUS_LABEL[d.status] ?? d.status}</span>{d.isDraft && <span className="fm-chip fm-chip--warn" title="Bản nháp — chưa có hiệu lực">Nháp</span>}
                {d.source === 'sap' ? (
                  <span className="fm-chip fm-chip--sap">SAP B1</span>
                ) : d.sapSyncStatus === 'synced' ? (
                  <span className="fm-chip fm-chip--sap" title={`DocNum ${d.sapDocNum}`}>Đã đẩy</span>
                ) : d.sapSyncStatus === 'pending' ? (
                  <span className="fm-chip fm-chip--error">Lỗi đẩy</span>
                ) : (
                  <span className="fm-hint">Chưa đẩy</span>
                )}
              </div>
              <div>
                <div className="fm-ocard__name">{d.cardName}</div>
                <div className="fm-ocard__meta">{d.cardCode}</div>
              </div>
              <div className="fm-ocard__meta">
                Ngày giao {formatDateVN(d.docDate)}
                {d.sourceOrder ? ` · Đơn nguồn SO #${d.sourceOrder.docNum}` : ''}
              </div>
              <div className="fm-ocard__bottom">
                <span className="fm-ocard__total">{formatVND(d.grandTotal)}</span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    className="fm-ocard__more"
                    title="Xem chi tiết"
                    aria-label={`Xem chi tiết phiếu ${d.docNum}`}
                    onClick={(e) => { e.stopPropagation(); onGoDetail(d.id) }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Eye size={16} />
                  </button>
                  <button
                    type="button"
                    className="fm-ocard__more"
                    title="Sơ đồ liên kết"
                    aria-label={`Sơ đồ liên kết phiếu ${d.docNum}`}
                    onClick={(e) => { e.stopPropagation(); setRelMapDelivery({ id: d.id, docNum: d.docNum }) }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Network size={16} />
                  </button>
                  {!d.isDraft && d.sapSyncStatus !== 'synced' && d.status !== 'Cancelled' && (
                    <button
                      type="button"
                      className="fm-ocard__push"
                      title="Đẩy sang SAP B1"
                      aria-label={`Đẩy phiếu ${d.docNum} sang SAP`}
                      onClick={(e) => { e.stopPropagation(); askPush(d) }}
                      onKeyDown={(e) => e.stopPropagation()}
                      disabled={busyId === d.id}
                    >
                      <CloudUpload size={16} />
                      <span>Đẩy</span>
                    </button>
                  )}
                  {d.source !== 'sap' && (
                    <button
                      type="button"
                      className="fm-ocard__del"
                      title="Xóa"
                      aria-label={`Xóa phiếu ${d.docNum}`}
                      onClick={(e) => { e.stopPropagation(); askDelete(d) }}
                      onKeyDown={(e) => e.stopPropagation()}
                      disabled={busyId === d.id}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>

        <FmPagination page={page} totalPages={totalPages} onPage={setPage} />
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

      {/* Context menu khi right-click / Shift+F10 dòng phiếu */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fm-ctxmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          aria-label={`Thao tác phiếu giao hàng #${ctxMenu.delivery.docNum}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Điều hướng bàn phím trong menu: ↑↓ di chuyển giữa các item, Escape đóng
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
            if (e.key === 'Escape') {
              e.preventDefault()
              closeCtxMenu(true)
            } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length > 0) {
              e.preventDefault()
              const idx = items.indexOf(document.activeElement as HTMLElement)
              const next = e.key === 'ArrowDown'
                ? (idx + 1) % items.length
                : (idx - 1 + items.length) % items.length
              items[next].focus()
            }
          }}
          onBlur={(e) => {
            // Tab ra khỏi menu → đóng
            if (!menuRef.current?.contains(e.relatedTarget as Node | null)) setCtxMenu(null)
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setRelMapDelivery({ id: ctxMenu.delivery.id, docNum: ctxMenu.delivery.docNum }); setCtxMenu(null) }}
          >
            <Network size={16} /> Sơ đồ liên kết
          </button>
        </div>
      )}

      {/* Modal Relationship Map — chỉ mở khi right-click phiếu (đã gỡ khỏi hiển thị inline) */}
      <RelMapModal
        orderId={null}
        orderDocNum={null}
        deliveryId={relMapDelivery?.id ?? null}
        deliveryDocNum={relMapDelivery?.docNum ?? null}
        onClose={() => setRelMapDelivery(null)}
        onGoOrder={(id) => onGoOrderDetail(id)}
        onGoDelivery={(id) => onGoDetail(id)}
      />
    </div>
  )
}
