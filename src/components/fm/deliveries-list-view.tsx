'use client'

// ============================================================
// DANH SÁCH DELIVERY (phiếu giao hàng)
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, Truck, Trash2, CloudUpload, Eye, RefreshCw } from 'lucide-react'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import PageHeader from './page-header'

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
  /** id bản ghi local tương ứng (nếu phiếu SAP có bản ghi local) */
  localId?: string | null
  sourceOrder?: { id: string; docNum: number } | null
  lines: DeliveryLine[]
}

interface Props {
  onGoDetail: (id: string) => void
  onGoOrderDetail: (orderId: string) => void
  refreshKey?: number
}

const STATUS_LABEL: Record<string, string> = {
  Open: 'Mở',
  Closed: 'Đóng',
  Cancelled: 'Hủy',
}

export default function DeliveriesListView({ onGoDetail, onGoOrderDetail, refreshKey }: Props) {
  const [rows, setRows] = useState<Delivery[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(10)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [sapWarn, setSapWarn] = useState('')

  // Scroll tới alert khi có thông báo mới (mobile không bỏ sót thông báo)
  const alertRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (alert) alertRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [alert])

  const load = useCallback(async (fresh = false) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (q.trim()) p.set('q', q.trim())
      if (status) p.set('status', status)
      // fresh = bỏ qua cache 45s phía server, tải mới trực tiếp từ SAP B1
      if (fresh) p.set('fresh', '1')
      const r = await api(`/api/deliveries?${p}`)
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
      setAlert({ type: 'error', msg: 'Không kết nối được máy chủ' })
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, q, status])

  useEffect(() => { void load() }, [load, refreshKey])

  const doDelete = async (d: Delivery) => {
    if (!window.confirm(`Xóa phiếu giao hàng #${d.docNum}?`)) return
    setBusyId(d.id)
    try {
      const r = await api(`/api/deliveries/${d.id}`, { method: 'DELETE' })
      const j = await r.json().catch(() => ({}))
      if (r.ok) {
        setAlert({ type: 'success', msg: `Đã xóa phiếu #${d.docNum}` })
        void load()
      } else {
        setAlert({ type: 'error', msg: j.error ?? 'Xóa thất bại' })
      }
    } catch {
      setAlert({ type: 'error', msg: 'Không kết nối được máy chủ' })
    } finally {
      setBusyId(null)
    }
  }

  const doPush = async (d: Delivery) => {
    // Đẩy SAP tạo chứng từ THẬT — xác nhận trước khi gọi API
    if (!window.confirm(`Đẩy phiếu #${d.docNum} sang SAP B1? Thao tác sẽ tạo chứng từ thật trên SAP.`)) return
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

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Giao hàng']}
        title="Quản lý giao hàng"
        actions={<>
          <button className="fm-btn fm-btn--secondary" onClick={() => void load(true)}><RefreshCw size={14} /> Tải lại</button>
          <span className="fm-hint">{total} phiếu{source === 'sap' ? ' · từ SAP B1' : ''}</span>
        </>}
      />

      {sapWarn && (
        <div className="fm-hint" style={{ color: 'var(--fm-red)', marginBottom: 8 }} role="alert">⚠ {sapWarn}</div>
      )}

      {alert && (
        <div ref={alertRef} className={`fm-alert fm-alert--${alert.type === 'success' ? 'success' : 'error'}`} role="alert" style={{ marginBottom: 12 }}>
          {alert.msg}
        </div>
      )}

      <div className="fm-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="fm-search" style={{ flex: '1 1 220px' }}>
          <Search size={15} className="fm-search__icon" />
          <input
            className="fm-search__input"
            placeholder="Tìm mã KH, tên KH, số phiếu…"
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
          <option value="Closed">Đóng</option>
          <option value="Cancelled">Hủy</option>
        </select>
      </div>

      <div className="fm-card">
        <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
          <table className="fm-table">
            <thead>
              <tr>
                <th>Số phiếu</th>
                <th>Ngày</th>
                <th>Khách hàng</th>
                <th>Đơn nguồn</th>
                <th>Trạng thái</th>
                <th>SAP</th>
                <th className="fm-num">Tổng tiền</th>
                <th><span className="fm-sr-only">Thao tác</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 24 }}>Đang tải…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8}><div className="fm-empty"><Truck />Chưa có phiếu giao hàng nào. Tạo phiếu giao hàng từ chi tiết đơn hàng (nút “Copy sang Delivery”).</div></td></tr>
              ) : rows.map((d) => (
                <tr key={d.id}>
                  <th scope="row"><b>#{d.docNum}</b></th>
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
                        onClick={() => onGoOrderDetail(d.sourceOrder!.id)}
                        title={`Xem Sale Order #${d.sourceOrder.docNum}`}
                      >
                        SO #{d.sourceOrder.docNum}
                      </button>
                    ) : '—'}
                  </td>
                  <td>
                    <span className={`fm-chip fm-chip--${d.status.toLowerCase()}`}>{STATUS_LABEL[d.status] ?? d.status}</span>
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
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {d.source !== 'sap' ? (
                        <button
                          type="button"
                          className="fm-btn fm-btn--ghost fm-btn--sm"
                          onClick={() => onGoDetail(d.id)}
                          title="Xem chi tiết"
                          aria-label={`Xem chi tiết phiếu ${d.docNum}`}
                        >
                          <Eye size={15} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="fm-btn fm-btn--ghost fm-btn--sm"
                          disabled
                          title="Phiếu từ SAP B1 — chỉ xem trên danh sách"
                          aria-label={`Phiếu ${d.docNum} từ SAP B1`}
                        >
                          <Eye size={15} />
                        </button>
                      )}
                      {d.sapSyncStatus !== 'synced' && d.status !== 'Cancelled' && (
                        <button
                          type="button"
                          className="fm-btn fm-btn--ghost fm-btn--sm"
                          onClick={() => void doPush(d)}
                          disabled={busyId === d.id}
                          title="Đẩy sang SAP B1"
                          aria-label={`Đẩy phiếu ${d.docNum} sang SAP`}
                        >
                          <CloudUpload size={15} />
                        </button>
                      )}
                      {d.source !== 'sap' && (
                        <button
                          type="button"
                          className="fm-btn fm-btn--ghost fm-btn--sm"
                          onClick={() => void doDelete(d)}
                          disabled={busyId === d.id}
                          title="Xóa"
                          aria-label={`Xóa phiếu ${d.docNum}`}
                        >
                          <Trash2 size={15} />
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
            <p className="fm-hint" style={{ padding: '16px 4px' }}>Đang tải…</p>
          ) : rows.length === 0 ? (
            <div className="fm-empty"><Truck />Chưa có phiếu giao hàng nào. Tạo phiếu giao hàng từ chi tiết đơn hàng (nút “Copy sang Delivery”).</div>
          ) : rows.map((d) => (
            <div
              key={d.id}
              className="fm-ocard"
              role="button"
              tabIndex={0}
              aria-label={`Xem chi tiết phiếu giao hàng #${d.docNum} — ${d.cardName}`}
              onClick={() => d.source !== 'sap' && onGoDetail(d.id)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && d.source !== 'sap') {
                  e.preventDefault()
                  onGoDetail(d.id)
                }
              }}
            >
              <div className="fm-ocard__top">
                <span className="fm-ocard__num">#{d.docNum}</span>
                <span className={`fm-chip fm-chip--${d.status.toLowerCase()}`}>{STATUS_LABEL[d.status] ?? d.status}</span>
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
                Ngày {formatDateVN(d.docDate)}
                {d.sourceOrder ? ` · Đơn nguồn SO #${d.sourceOrder.docNum}` : ''}
              </div>
              <div className="fm-ocard__bottom">
                <span className="fm-ocard__total">{formatVND(d.grandTotal)}</span>
                <span style={{ display: 'flex', gap: 4 }}>
                  {d.source !== 'sap' && (
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
                  )}
                  {d.sapSyncStatus !== 'synced' && d.status !== 'Cancelled' && (
                    <button
                      type="button"
                      className="fm-ocard__push"
                      title="Đẩy sang SAP B1"
                      aria-label={`Đẩy phiếu ${d.docNum} sang SAP`}
                      onClick={(e) => { e.stopPropagation(); void doPush(d) }}
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
                      onClick={(e) => { e.stopPropagation(); void doDelete(d) }}
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
    </div>
  )
}
