'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Filter, Plus, RotateCcw, Trash2, LockOpen, Search, Inbox, RefreshCw, Pencil, Download } from 'lucide-react'
import { formatVND, formatDateVN, formatNum, isOverdue } from '@/lib/fm-shared'
import type { SessionUser } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import type { EditOrderData } from './order-form-view'
import PageHeader from './page-header'

interface Line {
  id: string
  lineNum: number
  itemCode: string
  itemName: string
  uom: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  lineTotal: number
  discPct: number
  discAmt: number
  vatPct: number
  vatAmt: number
  grandTotal: number
  taxCode?: string
}
interface Order {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks: string | null
  totalBeforeDisc: number
  discountAmt: number
  /** Chiết khấu ĐẦU CHỨNG TỪ (% + tiền sau phân bổ) — đơn local lưu sẵn, đơn SAP tự tính */
  headerDiscPct?: number
  headerDiscAmt?: number
  vatAmt: number
  grandTotal: number
  createdBy: string
  // Đồng bộ SAP B1 (POST /Orders)
  sapDocEntry?: number | null
  sapDocNum?: number | null
  sapSyncStatus?: string // none | pending | synced
  sapSyncError?: string | null
  sapSyncedAt?: string | null
  /** 'sap' = lấy trực tiếp từ SAP B1 (không xóa/đóng được), 'local' = đơn local */
  source?: string
  /** id bản ghi local tương ứng (đơn SAP có bản ghi local → SỬA được) */
  localId?: string | null
  lines: Line[]
}

interface Props {
  user: SessionUser
  onGoCreate: () => void
  /** Mở form SỬA đơn đang Open */
  onGoEdit: (data: EditOrderData) => void
  /** Mở trang chi tiết đơn */
  onGoDetail: (orderId: string) => void
  refreshKey: number
}

/** Chip trạng thái đẩy đơn sang SAP B1 — đơn 'pending' bấm vào là đẩy lại */
function sapChip(o: Order, canSync: boolean, syncing: boolean, onSync: () => void) {
  if (o.sapSyncStatus === 'synced') {
    return (
      <span
        className="fm-chip fm-chip--sap"
        title={`DocEntry ${o.sapDocEntry ?? '—'}${o.sapSyncedAt ? ` · đồng bộ lúc ${formatDateVN(o.sapSyncedAt)}` : ''}`}
      >
        SAP #{o.sapDocNum ?? '?'}
      </span>
    )
  }
  if (o.sapSyncStatus === 'pending') {
    if (!canSync) {
      return (
        <span className="fm-chip fm-chip--pending" title={o.sapSyncError ?? 'Chưa đẩy được sang SAP B1'}>
          Chưa đẩy
        </span>
      )
    }
    return (
      <button
        type="button"
        className="fm-chip fm-chip--pending fm-chip--btn"
        title={o.sapSyncError ? `Đẩy lại sang SAP B1 — lỗi trước đó: ${o.sapSyncError}` : 'Đẩy lại sang SAP B1'}
        disabled={syncing}
        onClick={(e) => {
          e.stopPropagation()
          onSync()
        }}
      >
        <RefreshCw size={11} style={{ flex: 'none' }} />
        {syncing ? 'Đang đẩy…' : 'Chưa đẩy'}
      </button>
    )
  }
  return (
    <span className="fm-chip fm-chip--closed" title="Chưa cấu hình SAP B1 — đơn chỉ lưu local">
      —
    </span>
  )
}

export default function OrdersListView({ user, onGoCreate, onGoEdit, onGoDetail, refreshKey }: Props) {
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(8)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)

  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [detail, setDetail] = useState<Order | null>(null)
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [source, setSource] = useState('')
  const [sapWarn, setSapWarn] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailPartner, setDetailPartner] = useState<{ address?: string | null; contactPerson?: string | null; contactPhone?: string | null } | null>(null)
  const [detailError, setDetailError] = useState('')
  const [detailRetryTick, setDetailRetryTick] = useState(0)
  const modalRef = useRef<HTMLDivElement>(null)

  // Modal chi tiết: đưa focus vào modal khi mở + đóng bằng Escape
  useEffect(() => {
    if (!detail) return
    modalRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetail(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detail])

  const load = useCallback(async () => {
    try {
      const sp = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (q) sp.set('q', q)
      if (status) sp.set('status', status)
      if (from) sp.set('from', from)
      if (to) sp.set('to', to)
      const res = await api(`/api/orders?${sp.toString()}`)
      if (res.status === 401) { window.location.reload(); return }
      const json = await res.json()
      setOrders(json.data ?? [])
      setTotal(json.total ?? 0)
      setTotalPages(json.totalPages ?? 1)
      setSource(json.source ?? '')
      setSapWarn(json.warning ?? '')
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, q, status, from, to])

  useEffect(() => { load() }, [load, refreshKey])

  // Đơn lấy trực tiếp từ SAP B1 chưa có dòng hàng → tải khi mở modal chi tiết.
  // Đơn local thiếu dòng (hiếm) → tải từ /api/orders/[id].
  useEffect(() => {
    if (!detail || detail.lines.length > 0 || detailLoading) return
    const isSap = detail.source === 'sap' && !!detail.sapDocEntry
    const isLocal = detail.source !== 'sap'
    if (!isSap && !isLocal) return
    const url = isSap ? `/api/orders?docEntry=${detail.sapDocEntry}` : `/api/orders/${detail.id}`
    let cancelled = false
    api(url)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.ok) throw new Error(json.error ?? `Lỗi HTTP ${res.status}`)
        const loaded = json.order
        if (!cancelled && loaded) setDetail((d) => (d && d.id === loaded.id ? { ...d, ...loaded, source: d.source } : d))
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Lỗi không rõ'
          setDetailError(msg)
          setAlert({ type: 'error', msg: `Không lấy được dòng hàng: ${msg}` })
        }
      })
      .finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [detail, detailRetryTick])

  const resetFilter = () => { setQ(''); setStatus(''); setFrom(''); setTo(''); setPage(1) }

  const openDetail = (o: Order) => {
    setDetailError('')
    setDetail(o)
    setDetailPartner(null)
    // Đơn chưa có dòng hàng → effect sẽ tải, bật loading trước
    if (o.lines.length === 0) setDetailLoading(true)
    if (o.cardCode) {
      fetch(`/api/partners?q=${encodeURIComponent(o.cardCode)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const p = j?.items?.find((x: any) => x.cardCode === o.cardCode) ?? j?.items?.[0]
          if (p) setDetailPartner({ address: p.address ?? null, contactPerson: p.contactPerson ?? null, contactPhone: p.contactPhone ?? null })
        })
        .catch(() => {})
    }
  }

  const retryDetailLines = () => {
    setDetail((d) => (d ? { ...d, lines: [] } : d))
    setDetailRetryTick((t) => t + 1)
  }

  const [closingId, setClosingId] = useState<string | null>(null)
  const closeOrder = async (o: Order) => {
    if (closingId) return // chống bấm đúp gửi 2 request
    setClosingId(o.id)
    try {
      const next = o.status === 'Open' ? 'Closed' : 'Open'
      const res = await api(`/api/orders/${o.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      const json = await res.json()
      if (!res.ok) {
        setAlert({ type: 'error', msg: json.error ?? 'Không thể cập nhật trạng thái' })
        return
      }
      setAlert({ type: 'success', msg: `Đã ${next === 'Closed' ? 'đóng' : 'mở lại'} đơn hàng #${o.docNum}` })
      load()
      setDetail((d) => (d && d.id === o.id ? { ...d, status: next } : d))
    } finally {
      setClosingId(null)
    }
  }

  const deleteOrder = async (o: Order) => {
    if (!window.confirm(`Xóa đơn hàng #${o.docNum} — ${o.cardName}? Hành động không thể hoàn tác.`)) return
    const res = await api(`/api/orders/${o.id}`, { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setAlert({ type: 'error', msg: json.error ?? 'Không thể xóa đơn hàng' })
      return
    }
    setAlert({ type: 'success', msg: `Đã xóa đơn hàng #${o.docNum}` })
    setDetail(null)
    load()
  }

  const canEdit = user.permissions.orders?.edit
  const canDelete = user.permissions.orders?.delete
  const canCreate = user.permissions.ordersNew?.create
  const [syncingId, setSyncingId] = useState<string | null>(null)

  /** Đơn này SỬA được không? — mọi đơn Open:
   *  - đơn local → sửa local (+ PATCH SAP nếu đã synced);
   *  - đơn lấy trực tiếp từ SAP B1 → sửa thẳng chứng từ trên SL (PATCH /Orders),
   *    KHÔNG cần bản ghi local tương ứng nữa. Điều kiện: đã tải được dòng hàng. */
  const editable = (o: Order): boolean =>
    Boolean(canEdit && o.status === 'Open' && o.lines.length > 0 && (o.source !== 'sap' || o.sapDocEntry != null))

  /** Đơn trong modal → dữ liệu cho form sửa */
  const toEditData = (o: Order): EditOrderData => ({
    id: o.source === 'sap' ? o.localId ?? o.id : o.id,
    docNum: o.docNum,
    cardCode: o.cardCode,
    cardName: o.cardName,
    docDate: o.docDate,
    docDueDate: o.docDueDate,
    status: o.status,
    remarks: o.remarks,
    warehouseCode: (o as { warehouseCode?: string | null }).warehouseCode ?? null,
    headerDiscPct: o.headerDiscPct ?? 0,
    sapSyncStatus: o.sapSyncStatus ?? (o.source === 'sap' ? 'synced' : 'none'),
    lines: o.lines.map((l) => ({
      dbId: o.source === 'sap' ? undefined : l.id,
      sapLineNum: o.source === 'sap' ? l.lineNum : undefined,
      itemCode: l.itemCode,
      itemName: l.itemName,
      uom: l.uom,
      warehouseCode: l.warehouseCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct,
      vatPct: l.vatPct,
      taxCode: l.taxCode,
    })),
  })

  // Đẩy lại đơn sang SAP B1 (đơn đang 'pending' sau khi lưu)
  const syncOrder = async (o: Order) => {
    setSyncingId(o.id)
    try {
      const res = await api(`/api/orders/${o.id}/sync`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        setAlert({ type: 'error', msg: json.error ?? json.sap?.error ?? 'Không thể đẩy đơn sang SAP B1' })
      } else {
        setAlert({ type: 'success', msg: `Đã đẩy đơn #${o.docNum} sang SAP B1 — DocNum ${json.order?.sapDocNum}` })
      }
      load()
      setDetail((d) => (d && d.id === o.id && json.order ? { ...d, ...json.order } : d))
    } finally {
      setSyncingId(null)
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Danh sách đơn hàng']}
        title="Danh Sách Sale Order"
        badge="Cập nhật tức thời"
        actions={<>
          <button className="fm-btn fm-btn--secondary"><RefreshCw size={14} /> Đồng bộ lại</button>
          <button className="fm-btn fm-btn--secondary"><Download size={14} /> Xuất Excel</button>
        </>}
      />
      {alert && (
        <div className={`fm-alert ${alert.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={alert.type === 'error' ? 'alert' : 'status'}>
          <div><b>{alert.type === 'success' ? 'Thành công' : 'Lỗi'}</b>{alert.msg}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <div className="fm-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h2 className="fm-card__title">Danh sách Sale Order</h2>
            <p className="fm-card__desc">
              {source === 'sap'
                ? 'Truy vấn trực tiếp từ SAP B1 (ORDR/RDR1) qua Service Layer, gộp với các đơn local chưa đẩy.'
                : 'Dữ liệu đồng bộ theo cấu trúc SAP B1 — ORDR / RDR1.'}{' '}
              Tổng {total} chứng từ.
            </p>
          </div>
          {canCreate && (
            <button className="fm-btn fm-btn--primary" onClick={onGoCreate}>
              <Plus size={15} style={{ verticalAlign: -2, marginRight: 4 }} /> Tạo đơn hàng
            </button>
          )}
        </div>

        {/* Thanh lọc */}
        <div className="fm-filterbar">
          <div style={{ position: 'relative' }} data-search>
            <input
              className="fm-input"
              style={{ paddingLeft: 32 }}
              placeholder="Số CT, mã/N tên khách hàng…"
              aria-label="Tìm kiếm đơn hàng theo số chứng từ, mã hoặc tên khách hàng"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1) }}
            />
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} />
          </div>
          <select className="fm-select" aria-label="Lọc theo trạng thái đơn hàng" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">Tất cả trạng thái</option>
            <option value="Open">Open</option>
            <option value="Closed">Closed</option>
          </select>
          <input type="date" className="fm-datepicker" title="Từ ngày" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} />
          <input type="date" className="fm-datepicker" title="Đến ngày" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} />
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={resetFilter}>
            <RotateCcw size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Đặt lại
          </button>
          <div className="fm-filterbar__spacer" />
          <span className="fm-chip fm-chip--role"><Filter size={11} style={{ verticalAlign: -1, marginRight: 3 }} />{total} kết quả</span>
        </div>

        {/* Cảnh báo SAP lỗi khi load danh sách */}
        {sapWarn && (
          <div className="fm-hint" style={{ color: 'var(--fm-red)', marginBottom: 8 }}>⚠ {sapWarn}</div>
        )}

        {/* Bảng dữ liệu */}
        {loading ? (
          <div aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="fm-skeleton fm-skeleton--row" />
            ))}
          </div>
        ) : orders.length === 0 ? (
          <div className="fm-empty">
            <Inbox />
            Không có đơn hàng phù hợp bộ lọc
          </div>
        ) : (
          <>
            {/* Bảng (desktop) */}
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Số CT</th>
                    <th>Mã KH</th>
                    <th>Khách hàng</th>
                    <th>Ngày CT</th>
                    <th>Hạn giao</th>
                    <th>Trạng thái</th>
                    <th>SAP B1</th>
                    <th className="fm-num">Tổng trước VAT</th>
                    <th className="fm-num">Tổng tiền</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      style={{ cursor: 'pointer' }}
                      title="Bấm để xem chi tiết"
                      tabIndex={0}
                      aria-label={`Xem chi tiết đơn hàng #${o.docNum} — ${o.cardName}`}
                      onClick={() => openDetail(o)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openDetail(o)
                        }
                      }}
                    >
                      <td><b>#{o.docNum}</b></td>
                      <td>{o.cardCode}</td>
                      <td>{o.cardName}</td>
                      <td>{formatDateVN(o.docDate)}</td>
                      <td>{formatDateVN(o.docDueDate)}</td>
                      <td>
                        {isOverdue(o.docDueDate, o.status) ? (
                          <span className="fm-chip fm-chip--overdue">Quá hạn</span>
                        ) : o.status === 'Open' ? (
                          <span className="fm-chip fm-chip--open">Open</span>
                        ) : (
                          <span className="fm-chip fm-chip--closed">Closed</span>
                        )}
                      </td>
                      <td>{sapChip(o, canCreate, syncingId === o.id, () => syncOrder(o))}</td>
                      <td className="fm-num">{formatVND(o.totalBeforeDisc - o.discountAmt - (o.headerDiscAmt ?? 0))}</td>
                      <td className="fm-num"><b>{formatVND(o.grandTotal)}</b></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {canDelete && o.source !== 'sap' && (
                          <button className="fm-row-del" title="Xóa đơn hàng" onClick={() => deleteOrder(o)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Danh sách card (mobile) */}
            <div className="fm-only-mobile">
              {orders.map((o) => (
                <div
                  key={o.id}
                  className="fm-ocard"
                  role="button"
                  tabIndex={0}
                  aria-label={`Xem chi tiết đơn hàng #${o.docNum} — ${o.cardName}`}
                  onClick={() => openDetail(o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail(o)
                    }
                  }}
                >
                  <div className="fm-ocard__top">
                    <span className="fm-ocard__num">#{o.docNum}</span>
                    {isOverdue(o.docDueDate, o.status) ? (
                      <span className="fm-chip fm-chip--overdue">Quá hạn</span>
                    ) : o.status === 'Open' ? (
                      <span className="fm-chip fm-chip--open">Open</span>
                    ) : (
                      <span className="fm-chip fm-chip--closed">Closed</span>
                    )}
                    {sapChip(o, canCreate, syncingId === o.id, () => syncOrder(o))}
                  </div>
                  <div>
                    <div className="fm-ocard__name">{o.cardName}</div>
                    <div className="fm-ocard__meta">{o.cardCode}</div>
                  </div>
                  <div className="fm-ocard__meta">
                    Ngày CT {formatDateVN(o.docDate)} · Hạn giao {formatDateVN(o.docDueDate)}
                  </div>
                  <div className="fm-ocard__bottom">
                    <span className="fm-ocard__total">{formatVND(o.grandTotal)}</span>
                    {canDelete && o.source !== 'sap' && (
                      <button
                        className="fm-ocard__del"
                        title="Xóa đơn hàng"
                        aria-label={`Xóa đơn hàng ${o.docNum}`}
                        onClick={(e) => { e.stopPropagation(); deleteOrder(o) }}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Phân trang */}
            <div className="fm-pagination">
              <span style={{ color: 'var(--fm-text-2)', marginRight: 8 }}>
                Trang {page}/{totalPages}
              </span>
              <button className="fm-page-btn" aria-label="Về trang đầu" disabled={page <= 1} onClick={() => setPage(1)}>«</button>
              <button className="fm-page-btn" aria-label="Trang trước" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => Math.abs(p - page) <= 1 || p === 1 || p === totalPages)
                .map((p) => (
                  <button key={p} className={`fm-page-btn${p === page ? ' is-active' : ''}`} aria-label={`Trang ${p}`} aria-current={p === page ? 'page' : undefined} onClick={() => setPage(p)}>
                    {p}
                  </button>
                ))}
              <button className="fm-page-btn" aria-label="Trang sau" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>›</button>
              <button className="fm-page-btn" aria-label="Đến trang cuối" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>»</button>
            </div>
          </>
        )}
      </div>

      {/* Modal chi tiết */}
      {detail && (
        <div className="fm-backdrop" onClick={() => setDetail(null)}>
          <div ref={modalRef} tabIndex={-1} className="fm-modal fm-modal--wide fm-scroll" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Chi tiết Sale Order #${detail.docNum}`}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, color: 'var(--fm-navy)', fontSize: 20 }}>
                Sale Order #{detail.docNum}{' '}
                {isOverdue(detail.docDueDate, detail.status) ? (
                  <span className="fm-chip fm-chip--overdue">Quá hạn</span>
                ) : detail.status === 'Open' ? (
                  <span className="fm-chip fm-chip--open">Open</span>
                ) : (
                  <span className="fm-chip fm-chip--closed">Closed</span>
                )}
              </h3>
              <button className="fm-btn fm-btn--ghost fm-btn--sm" aria-label="Đóng chi tiết đơn hàng" onClick={() => setDetail(null)}>✕</button>
            </div>

            <dl className="fm-view-detail">
              <div><dt>Mã khách hàng</dt><dd>{detail.cardCode}</dd></div>
              <div><dt>Tên khách hàng</dt><dd>{detail.cardName}</dd></div>
              <div><dt>Địa chỉ</dt><dd>{detailPartner?.address || '—'}</dd></div>
              <div><dt>Người liên hệ</dt><dd>{detailPartner?.contactPerson ? `${detailPartner.contactPerson}${detailPartner.contactPhone ? ` · ${detailPartner.contactPhone}` : ''}` : '—'}</dd></div>
              <div><dt>Ngày chứng từ</dt><dd>{formatDateVN(detail.docDate)}</dd></div>
              <div><dt>Ngày giao hàng</dt><dd>{formatDateVN(detail.docDueDate)}</dd></div>
              <div><dt>Người tạo</dt><dd>{detail.source === 'sap' ? 'SAP B1 (chứng từ gốc)' : detail.createdBy}</dd></div>
              <div><dt>Ghi chú</dt><dd>{detail.remarks || '—'}</dd></div>
              <div>
                <dt>SAP B1</dt>
                <dd>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {sapChip(detail, canCreate, syncingId === detail.id, () => syncOrder(detail))}
                    {detail.sapSyncStatus === 'pending' && detail.sapSyncError && (
                      <small style={{ color: 'var(--fm-red)' }}>{detail.sapSyncError}</small>
                    )}
                    {detail.sapSyncStatus === 'synced' && detail.sapSyncedAt && (
                      <small style={{ color: 'var(--fm-text-3)' }}>
                        DocEntry {detail.sapDocEntry ?? '—'} · đồng bộ lúc {formatDateVN(detail.sapSyncedAt)}
                      </small>
                    )}
                  </span>
                </dd>
              </div>
            </dl>

            {/* Bảng 11 cột — chỉ desktop; mobile dùng card fm-lcard bên dưới */}
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto', marginBottom: 14 }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Mã hàng</th>
                    <th>Tên hàng</th>
                    <th className="fm-num">SL</th>
                    <th>DVT</th>
                    <th>Kho</th>
                    <th className="fm-num">Đơn giá</th>
                    <th className="fm-num">CK (%)</th>
                    <th className="fm-num">Thành tiền sau CK</th>
                    <th className="fm-num">VAT (%)</th>
                    <th className="fm-num">Tiền dòng (sau VAT)</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.length === 0 ? (
                    <tr>
                      <td colSpan={11} style={{ textAlign: 'center', padding: 18 }}>
                        {detailLoading ? (
                          <span style={{ color: 'var(--fm-text-2)' }}>
                            {detail.source === 'sap' ? 'Đang tải dòng hàng từ SAP B1…' : 'Đang tải dòng hàng…'}
                          </span>
                        ) : detailError ? (
                          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                            <span style={{ color: 'var(--fm-red)' }}>⚠ Không tải được dòng hàng — {detailError}</span>
                            <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={retryDetailLines}>
                              <RotateCcw size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Thử lại
                            </button>
                          </span>
                        ) : (
                          <span style={{ color: 'var(--fm-text-2)' }}>Không có dòng hàng nào</span>
                        )}
                      </td>
                    </tr>
                  ) : (
                    detail.lines.map((l) => {
                    const afterDisc = l.lineTotal - (l.discAmt || 0)
                    return (
                      <tr key={l.id}>
                        <td>{l.lineNum}</td>
                        <td>{l.itemCode}</td>
                        <td>{l.itemName}</td>
                        <td className="fm-num">{formatNum(l.quantity)}</td>
                        <td>{l.uom}</td>
                        <td>{l.warehouseCode || '—'}</td>
                        <td className="fm-num">{formatVND(l.unitPrice)}</td>
                        <td className="fm-num">{formatNum(l.discPct || 0)}%</td>
                        <td className="fm-num">{formatVND(afterDisc)}</td>
                        <td className="fm-num">{formatNum(l.vatPct ?? 0)}%</td>
                        <td className="fm-num"><b>{formatVND(l.grandTotal || afterDisc)}</b></td>
                      </tr>
                    )
                    })
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8}>Tổng trước chiết khấu</td>
                    <td className="fm-num">{formatVND(detail.totalBeforeDisc)}</td>
                    <td colSpan={2}></td>
                  </tr>
                  <tr>
                    <td colSpan={8}>Chiết khấu các dòng</td>
                    <td className="fm-num">{detail.discountAmt > 0 ? `−${formatVND(detail.discountAmt)}` : formatVND(0)}</td>
                    <td colSpan={2}></td>
                  </tr>
                  {(detail.headerDiscAmt ?? 0) > 0 && (
                    <tr>
                      <td colSpan={8}>Chiết khấu đầu chứng từ ({detail.headerDiscPct ?? 0}%)</td>
                      <td className="fm-num">−{formatVND(detail.headerDiscAmt ?? 0)}</td>
                      <td colSpan={2}></td>
                    </tr>
                  )}
                  <tr>
                    <td colSpan={8}>Thuế VAT các dòng</td>
                    <td className="fm-num">{formatVND(detail.vatAmt ?? 0)}</td>
                    <td colSpan={2}></td>
                  </tr>
                  <tr>
                    <td colSpan={10}>TỔNG CỘNG</td>
                    <td className="fm-num"><b>{formatVND(detail.grandTotal)}</b></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Card dòng hàng (mobile) — thay bảng 11 cột cuộn ngang trong bottom-sheet */}
            <div className="fm-only-mobile" style={{ marginBottom: 14 }}>
              {detail.lines.length === 0 ? (
                <div className="fm-empty" style={{ border: '1px dashed var(--fm-line)', borderRadius: 'var(--fm-r-lg)' }}>
                  {detailLoading ? (
                    <span style={{ color: 'var(--fm-text-2)' }}>
                      {detail.source === 'sap' ? 'Đang tải dòng hàng từ SAP B1…' : 'Đang tải dòng hàng…'}
                    </span>
                  ) : detailError ? (
                    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: 'var(--fm-red)' }}>⚠ Không tải được dòng hàng — {detailError}</span>
                      <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={retryDetailLines}>
                        <RotateCcw size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Thử lại
                      </button>
                    </span>
                  ) : (
                    'Không có dòng hàng nào'
                  )}
                </div>
              ) : (
                <>
                  {detail.lines.map((l) => {
                    const afterDiscM = l.lineTotal - (l.discAmt || 0)
                    return (
                      <div key={l.id} className="fm-lcard">
                        <div className="fm-lcard__head">
                          <span className="fm-lcard__num">{l.lineNum}</span>
                          <div style={{ minWidth: 0 }}>
                            <div className="fm-lcard__name">{l.itemName}</div>
                            <div className="fm-lcard__code">{l.itemCode}{l.uom ? ` · ${l.uom}` : ''}</div>
                          </div>
                        </div>
                        <div className="fm-lcard__grid">
                          <div><span className="k">Số lượng</span><span className="v">{formatNum(l.quantity)}</span></div>
                          <div><span className="k">Kho</span><span className="v">{l.warehouseCode || '—'}</span></div>
                          <div><span className="k">Đơn giá</span><span className="v">{formatVND(l.unitPrice)}</span></div>
                          <div><span className="k">CK (%)</span><span className="v">{formatNum(l.discPct || 0)}%</span></div>
                          <div><span className="k">Mã thuế</span><span className="v">{l.taxCode || '—'}</span></div>
                          <div><span className="k">VAT (%)</span><span className="v">{formatNum(l.vatPct ?? 0)}%</span></div>
                          <div><span className="k">Sau CK</span><span className="v">{formatVND(afterDiscM)}</span></div>
                        </div>
                        <div className="fm-lcard__total">
                          <span>Tiền dòng (sau VAT)</span>
                          <b>{formatVND(l.grandTotal || afterDiscM)}</b>
                        </div>
                      </div>
                    )
                  })}
                  <div className="fm-totals fm-totals--card">
                    <div className="fm-totals__row"><span>Tổng trước chiết khấu</span><b>{formatVND(detail.totalBeforeDisc)}</b></div>
                    <div className="fm-totals__row"><span>Chiết khấu các dòng</span><b>{detail.discountAmt > 0 ? `−${formatVND(detail.discountAmt)}` : formatVND(0)}</b></div>
                    {(detail.headerDiscAmt ?? 0) > 0 && (
                      <div className="fm-totals__row"><span>Chiết khấu đầu chứng từ ({detail.headerDiscPct ?? 0}%)</span><b>−{formatVND(detail.headerDiscAmt ?? 0)}</b></div>
                    )}
                    <div className="fm-totals__row"><span>Thuế VAT các dòng</span><b>{formatVND(detail.vatAmt ?? 0)}</b></div>
                    <div className="fm-totals__grand"><span>TỔNG CỘNG</span><span>{formatVND(detail.grandTotal)}</span></div>
                  </div>
                </>
              )}
            </div>

            {canEdit && detail.status === 'Open' && (
              <button
                className="fm-btn fm-btn--primary"
                title={editable(detail) ? 'Sửa nội dung đơn hàng đang Open (cập nhật trực tiếp lên SAP B1)' : 'Không sửa được — chưa tải được dòng hàng của chứng từ'}
                disabled={!editable(detail)}
                onClick={() => onGoEdit(toEditData(detail))}
              >
                <Pencil size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
                Sửa đơn hàng
              </button>
            )}
            {canEdit && detail.source !== 'sap' && (
              <button
                className={`fm-btn ${detail.status === 'Open' ? 'fm-btn--secondary' : 'fm-btn--ghost'}`}
                disabled={closingId === detail.id}
                onClick={() => closeOrder(detail)}
              >
                <LockOpen size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
                {closingId === detail.id ? 'Đang cập nhật…' : detail.status === 'Open' ? 'Đóng đơn hàng (Closed)' : 'Mở lại đơn hàng (Open)'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
