'use client'

// ============================================================
// CHI TIẾT DELIVERY (phiếu giao hàng)
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, CloudUpload, Truck } from 'lucide-react'
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
  sourceOrder?: { id: string; docNum: number; cardCode: string; cardName: string } | null
  lines: DeliveryLine[]
}

interface Props {
  deliveryId: string
  onBack: () => void
  onGoOrder: (orderId: string) => void
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
      docDate: delivery.docDate,
      status: 'Open',
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
            {delivery.sapSyncStatus !== 'synced' && (
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
                  <td><b>{l.itemCode}</b></td>
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
        </div>
      </div>
    </div>
  )
}
