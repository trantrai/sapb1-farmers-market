'use client'

// ============================================================
// CHI TIẾT DELIVERY (phiếu giao hàng)
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useFocusTrap } from './use-focus-trap'
import { ArrowLeft, CloudUpload, Truck, Pencil, Ban, X } from 'lucide-react'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import RelationshipMap, { type RelNode } from './relationship-map'

interface DeliveryLine {
  id: string
  lineNum: number
  itemCode: string
  itemName: string
  quantity: number
  uom: string
  unitPrice: number
  lineTotal: number
  sourceOrderLineId?: string | null
}

interface Delivery {
  id: string
  docNum: number
  docDate: string
  cardCode: string
  cardName: string
  status: string
  remarks?: string | null
  grandTotal: number
  sapDocEntry?: number | null
  sapDocNum?: number | null
  sapSyncStatus?: string
  sapSyncError?: string | null
  sourceOrder?: { id: string; docNum: number; docDate: string; cardCode: string; cardName: string; status: string } | null
  lines: DeliveryLine[]
}

interface Props {
  deliveryId: string
  onBack: () => void
  onGoOrder: (orderId: string) => void
}

interface EditRow {
  id: string
  itemCode: string
  itemName: string
  uom: string
  unitPrice: number
  oldQuantity: number
  maxQty: number // Infinity = không giới hạn (dòng không liên kết đơn nguồn)
  qtyRaw: string
}

const STATUS_LABEL: Record<string, string> = {
  Open: 'Mở',
  Closed: 'Đóng',
  Cancelled: 'Hủy',
}

export default function DeliveryDetailView({ deliveryId, onBack, onGoOrder }: Props) {
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  // Modal sửa SL dòng
  const [showEdit, setShowEdit] = useState(false)
  const [editRows, setEditRows] = useState<EditRow[]>([])
  const [editLoading, setEditLoading] = useState(false)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const editTrapRef = useFocusTrap<HTMLDivElement>(showEdit, () => {
    if (!editBusy) setShowEdit(false)
  })

  // Modal xác nhận hủy phiếu
  const [showCancel, setShowCancel] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const cancelTrapRef = useFocusTrap<HTMLDivElement>(showCancel, () => {
    if (!cancelBusy) setShowCancel(false)
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api(`/api/deliveries/${deliveryId}`)
      const j = await r.json()
      if (r.ok && j.ok) {
        setDelivery(j.delivery)
        setError('')
      } else {
        setError(j.error ?? 'Không tải được chi tiết phiếu giao hàng')
      }
    } catch {
      setError('Không kết nối được máy chủ')
    } finally {
      setLoading(false)
    }
  }, [deliveryId])

  useEffect(() => { void load() }, [load])

  const doPush = async () => {
    if (!delivery) return
    // Đẩy SAP tạo chứng từ THẬT — xác nhận trước 1-click
    if (!window.confirm(`Đẩy phiếu giao hàng #${delivery.docNum} sang SAP B1?\nThao tác tạo chứng từ thật trên SAP và không thể hoàn tác tự động.`)) return
    setActionBusy(true)
    setActionMsg(null)
    try {
      const r = await api(`/api/deliveries/${delivery.id}/push`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setActionMsg({ type: 'success', text: j.message ?? 'Đã đẩy sang SAP B1' })
        void load()
      } else {
        setActionMsg({ type: 'error', text: j.error ?? 'Đẩy thất bại' })
      }
    } catch {
      setActionMsg({ type: 'error', text: 'Không kết nối được máy chủ' })
    } finally {
      setActionBusy(false)
    }
  }

  const canEdit = delivery !== null && delivery.sapSyncStatus !== 'synced' && delivery.status !== 'Cancelled'

  // Mở modal sửa SL: lấy đơn nguồn để tính maxQty từng dòng
  // maxQty = SL đặt của đơn - SL đã giao ở các phiếu khác (không tính phiếu này)
  const openEditModal = async () => {
    if (!delivery || editLoading) return
    setEditLoading(true)
    try {
      const maxQtyByLine = new Map<string, number>()
      if (delivery.sourceOrder?.id) {
        const r = await api(`/api/orders/${delivery.sourceOrder.id}`)
        const j = await r.json().catch(() => null)
        const o = j?.order ?? j
        if (r.ok && o) {
          const delivered = new Map<string, number>()
          for (const d of o.deliveries ?? []) {
            if (d.id === delivery.id || d.status === 'Cancelled') continue
            for (const dl of d.lines ?? []) {
              if (!dl.sourceOrderLineId) continue
              delivered.set(dl.sourceOrderLineId, (delivered.get(dl.sourceOrderLineId) ?? 0) + dl.quantity)
            }
          }
          for (const ol of o.lines ?? []) {
            maxQtyByLine.set(
              ol.id,
              Math.max(0, Math.round((ol.quantity - (delivered.get(ol.id) ?? 0)) * 1000) / 1000),
            )
          }
        }
      }
      setEditRows(delivery.lines.map((l) => ({
        id: l.id,
        itemCode: l.itemCode,
        itemName: l.itemName,
        uom: l.uom,
        unitPrice: l.unitPrice,
        oldQuantity: l.quantity,
        maxQty: l.sourceOrderLineId ? (maxQtyByLine.get(l.sourceOrderLineId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY,
        qtyRaw: String(l.quantity),
      })))
      setEditError(null)
      setShowEdit(true)
    } finally {
      setEditLoading(false)
    }
  }

  const setEditRowQty = (lineId: string, raw: string) => {
    setEditRows((rows) => rows.map((r) => (r.id === lineId ? { ...r, qtyRaw: raw } : r)))
  }

  const doSaveEdit = async () => {
    if (!delivery) return
    const payload: Array<{ id: string; quantity: number }> = []
    for (const r of editRows) {
      const qty = parseFloat(r.qtyRaw)
      if (Number.isNaN(qty) || qty <= 0) {
        setEditError(`SL dòng ${r.itemCode} phải > 0`)
        return
      }
      if (qty > r.maxQty) {
        setEditError(`SL dòng ${r.itemCode} (${qty}) vượt quá SL còn mở (${r.maxQty}) của đơn nguồn`)
        return
      }
      payload.push({ id: r.id, quantity: qty })
    }
    setEditBusy(true)
    setEditError(null)
    try {
      const r = await api(`/api/deliveries/${delivery.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: payload }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setShowEdit(false)
        setActionMsg({ type: 'success', text: `Đã cập nhật số lượng các dòng phiếu #${delivery.docNum}.` })
        void load()
      } else {
        setEditError(j.error ?? 'Lưu thất bại')
      }
    } catch {
      setEditError('Không kết nối được máy chủ')
    } finally {
      setEditBusy(false)
    }
  }

  const doCancel = async () => {
    if (!delivery) return
    setCancelBusy(true)
    try {
      const r = await api(`/api/deliveries/${delivery.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Cancelled' }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setShowCancel(false)
        setActionMsg({ type: 'success', text: `Đã hủy phiếu giao hàng #${delivery.docNum}.` })
        void load()
      } else {
        setActionMsg({ type: 'error', text: j.error ?? 'Hủy phiếu thất bại' })
        setShowCancel(false)
      }
    } catch {
      setActionMsg({ type: 'error', text: 'Không kết nối được máy chủ' })
      setShowCancel(false)
    } finally {
      setCancelBusy(false)
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', 'Giao hàng', 'Chi tiết']} title="Chi tiết phiếu giao hàng" />
        <p className="fm-hint">Đang tải…</p>
      </div>
    )
  }

  if (error || !delivery) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', 'Giao hàng', 'Chi tiết']} title="Chi tiết phiếu giao hàng" />
        <div className="fm-alert fm-alert--error" role="alert">{error || 'Không tìm thấy'}</div>
        <button className="fm-btn fm-btn--secondary" onClick={onBack} style={{ marginTop: 12 }}>
          <ArrowLeft size={15} /> Quay lại
        </button>
      </div>
    )
  }

  const relNodes: RelNode[] = []
  if (delivery.sourceOrder) {
    relNodes.push({
      kind: 'order',
      id: delivery.sourceOrder.id,
      docNum: delivery.sourceOrder.docNum,
      docDate: delivery.sourceOrder.docDate,
      // Trạng thái thật của đơn nguồn (API include sourceOrder.status), không hardcode 'Open'
      status: delivery.sourceOrder.status ?? 'Open',
    })
  }
  relNodes.push({
    kind: 'delivery',
    id: delivery.id,
    docNum: delivery.docNum,
    docDate: delivery.docDate,
    status: delivery.sapSyncStatus === 'synced' ? 'synced' : delivery.status,
    current: true,
  })

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Giao hàng', `Phiếu #${delivery.docNum}`]}
        title={`Phiếu giao hàng #${delivery.docNum}`}
        actions={
          <>
            <button className="fm-btn fm-btn--secondary" onClick={onBack}>
              <ArrowLeft size={15} /> Quay lại
            </button>
            {canEdit && (
              <>
                <button
                  className="fm-btn fm-btn--secondary"
                  onClick={() => void openEditModal()}
                  disabled={actionBusy || editLoading}
                >
                  <Pencil size={15} /> {editLoading ? 'Đang tải…' : 'Sửa'}
                </button>
                <button className="fm-btn fm-btn--secondary" onClick={() => setShowCancel(true)} disabled={actionBusy}>
                  <Ban size={15} /> Hủy phiếu
                </button>
              </>
            )}
            {delivery.sapSyncStatus !== 'synced' && delivery.status !== 'Cancelled' && (
              <button className="fm-btn fm-btn--primary" onClick={() => void doPush()} disabled={actionBusy}>
                <CloudUpload size={15} /> {actionBusy ? 'Đang đẩy…' : 'Đẩy sang SAP B1'}
              </button>
            )}
          </>
        }
      />

      <RelationshipMap
        nodes={relNodes}
        onGoOrder={onGoOrder}
        onGoDelivery={() => {}}
      />

      {actionMsg && (
        <div className={`fm-alert fm-alert--${actionMsg.type === 'success' ? 'success' : 'error'}`} role="alert" style={{ marginBottom: 12 }}>
          {actionMsg.text}
        </div>
      )}

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, padding: 16 }}>
          <div>
            <div className="fm-hint">Khách hàng</div>
            <div><b>{delivery.cardCode}</b> — {delivery.cardName}</div>
          </div>
          <div>
            <div className="fm-hint">Ngày giao</div>
            <div>{formatDateVN(delivery.docDate)}</div>
          </div>
          <div>
            <div className="fm-hint">Trạng thái</div>
            <div><span className={`fm-chip fm-chip--${delivery.status.toLowerCase()}`}>{STATUS_LABEL[delivery.status] ?? delivery.status}</span></div>
          </div>
          <div>
            <div className="fm-hint">SAP B1</div>
            <div>
              {delivery.sapSyncStatus === 'synced' ? (
                <span className="fm-chip fm-chip--synced">Đã đẩy — DocNum {delivery.sapDocNum}</span>
              ) : delivery.sapSyncStatus === 'pending' ? (
                <span className="fm-chip fm-chip--pending" title={delivery.sapSyncError ?? ''}>Đẩy lỗi</span>
              ) : (
                <span className="fm-hint">Chưa đẩy</span>
              )}
            </div>
          </div>
          {delivery.remarks && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="fm-hint">Ghi chú</div>
              <div>{delivery.remarks}</div>
            </div>
          )}
        </div>
      </div>

      <div className="fm-card">
        <div className="fm-table-wrap">
          <table className="fm-table">
            <thead>
              <tr>
                <th>STT</th>
                <th>Mã hàng</th>
                <th>Tên hàng</th>
                <th className="fm-num">SL</th>
                <th>ĐVT</th>
                <th className="fm-num">Đơn giá</th>
                <th className="fm-num">Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              {delivery.lines.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td>
                  <th scope="row"><b>{l.itemCode}</b></th>
                  <td>{l.itemName}</td>
                  <td className="fm-num">{l.quantity}</td>
                  <td>{l.uom}</td>
                  <td className="fm-num">{formatVND(l.unitPrice)}</td>
                  <td className="fm-num"><b>{formatVND(l.lineTotal)}</b></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6} style={{ textAlign: 'right' }}><b>TỔNG CỘNG:</b></td>
                <td className="fm-num"><b>{formatVND(delivery.grandTotal)}</b></td>
              </tr>
            </tfoot>
          </table>
          {/* Mobile (<=640px): card thay cho bảng 7 cột cuộn ngang */}
          <div className="fm-lcard-list">
            {delivery.lines.map((l, i) => (
              <div key={l.id} className="fm-lcard">
                <div className="fm-lcard__head">
                  <span className="fm-lcard__num">{i + 1}</span>
                  <div>
                    <div className="fm-lcard__name">{l.itemName}</div>
                    <div className="fm-lcard__code">{l.itemCode} · {l.uom}</div>
                  </div>
                </div>
                <div className="fm-lcard__grid">
                  <div><span className="k">SL</span><span className="v">{l.quantity}</span></div>
                  <div><span className="k">Đơn giá</span><span className="v">{formatVND(l.unitPrice)}</span></div>
                </div>
                <div className="fm-lcard__total">
                  <span>Thành tiền</span>
                  <b>{formatVND(l.lineTotal)}</b>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Modal sửa số lượng dòng */}
      {showEdit && delivery && (
        <div className="fm-backdrop" onClick={() => { if (!editBusy) setShowEdit(false) }}>
          <div
            ref={editTrapRef}
            className="fm-modal fm-modal--wide"
            role="dialog"
            aria-modal="true"
            aria-label={`Sửa số lượng phiếu ${delivery.docNum}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 640 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pencil size={18} /> Sửa số lượng — Phiếu #{delivery.docNum}
              </h3>
              <button className="fm-icon-btn" onClick={() => setShowEdit(false)} aria-label="Đóng" disabled={editBusy}>
                <X size={16} />
              </button>
            </div>

            <p className="fm-hint" style={{ margin: '0 0 10px' }}>
              SL mới không được vượt quá SL còn mở của đơn nguồn (nếu dòng có liên kết).
            </p>

            <div className="fm-table-wrap" style={{ marginBottom: 12 }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Mã hàng</th>
                    <th>Tên hàng</th>
                    <th className="fm-num">SL cũ</th>
                    <th className="fm-num">SL mới</th>
                  </tr>
                </thead>
                <tbody>
                  {editRows.map((r) => (
                    <tr key={r.id}>
                      <td><b>{r.itemCode}</b></td>
                      <td>{r.itemName}</td>
                      <td className="fm-num">{r.oldQuantity}</td>
                      <td className="fm-num">
                        <input
                          type="number"
                          className="fm-input"
                          style={{ width: 96, textAlign: 'right' }}
                          min={0}
                          step="any"
                          value={r.qtyRaw}
                          onChange={(e) => setEditRowQty(r.id, e.target.value)}
                          aria-label={`SL mới cho ${r.itemCode}${Number.isFinite(r.maxQty) ? ` (tối đa ${r.maxQty})` : ''}`}
                          disabled={editBusy}
                        />
                        {Number.isFinite(r.maxQty) && (
                          <div className="fm-hint" style={{ fontSize: 11 }}>tối đa {r.maxQty}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {editError && (
              <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>
                {editError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowEdit(false)} disabled={editBusy}>
                Hủy
              </button>
              <button className="fm-btn fm-btn--primary" onClick={() => void doSaveEdit()} disabled={editBusy}>
                <Pencil size={15} /> {editBusy ? 'Đang lưu…' : 'Lưu'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal xác nhận hủy phiếu */}
      {showCancel && delivery && (
        <div className="fm-backdrop" onClick={() => { if (!cancelBusy) setShowCancel(false) }}>
          <div
            ref={cancelTrapRef}
            className="fm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Xác nhận hủy phiếu ${delivery.docNum}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Ban size={18} /> Hủy phiếu giao hàng
              </h3>
              <button className="fm-icon-btn" onClick={() => setShowCancel(false)} aria-label="Đóng" disabled={cancelBusy}>
                <X size={16} />
              </button>
            </div>
            <p style={{ margin: '0 0 8px' }}>
              Hủy phiếu giao hàng <b>#{delivery.docNum}</b>? Các dòng đã giao của phiếu này sẽ được trả lại
              thành SL còn mở của đơn nguồn.
            </p>
            <p className="fm-hint" style={{ margin: '0 0 16px' }}>
              Phiếu đã hủy sẽ không thể sửa và không thể đẩy sang SAP. Nếu cần giao tiếp, hãy tạo phiếu mới từ đơn nguồn.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowCancel(false)} disabled={cancelBusy}>
                Giữ phiếu
              </button>
              <button className="fm-btn fm-btn--primary" onClick={() => void doCancel()} disabled={cancelBusy}>
                <Ban size={15} /> {cancelBusy ? 'Đang hủy…' : 'Xác nhận hủy phiếu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
