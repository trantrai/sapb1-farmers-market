'use client'

// ============================================================
// MODAL RELATIONSHIP MAP — mở khi right-click vào dòng SO / phiếu giao hàng.
// Hiển thị sơ đồ: Sale Order → Delivery (click node để nhảy chi tiết).
// ============================================================

import { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { api } from '@/lib/fm-client'
import RelationshipMap, { type RelNode } from './relationship-map'
import { useFocusTrap } from './use-focus-trap'

interface Props {
  orderId: string | null
  orderDocNum: number | null
  /** Mode phiếu giao hàng: right-click phiếu → sơ đồ đơn nguồn → phiếu */
  deliveryId?: string | null
  deliveryDocNum?: number | null
  onClose: () => void
  onGoOrder: (id: string) => void
  onGoDelivery: (id: string) => void
}

export default function RelMapModal({ orderId, orderDocNum, deliveryId = null, deliveryDocNum = null, onClose, onGoOrder, onGoDelivery }: Props) {
  // nodes/error gắn với id đã tải → đổi mode (đơn ↔ phiếu) không flash dữ liệu cũ
  const [data, setData] = useState<{ id: string; nodes: RelNode[] } | null>(null)
  const [loadError, setLoadError] = useState<{ id: string; message: string } | null>(null)
  const activeId = orderId ?? deliveryId
  const trapRef = useFocusTrap<HTMLDivElement>(!!activeId, onClose)

  // setState chỉ nằm trong callback .then/.catch (bất đồng bộ) để qua rule react-hooks/set-state-in-effect
  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    const id = activeId
    const onOk = (list: RelNode[]) => { if (!cancelled) setData({ id, nodes: list }) }
    const onError = (e: unknown) => {
      if (!cancelled) setLoadError({ id, message: e instanceof Error ? e.message : 'Lỗi tải dữ liệu' })
    }
    if (orderId) {
      api(`/api/orders/${orderId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
          const o = j.order
          if (!o) throw new Error('Không tìm thấy đơn hàng')
          onOk([
            {
              kind: 'order',
              id: o.id,
              docNum: o.docNum,
              docDate: o.docDate,
              status: o.sapSyncStatus === 'synced' ? 'synced' : o.status,
              current: true,
            },
            ...(o.deliveries ?? []).map((d: { id: string; docNum: number; docDate: string; status: string; sapSyncStatus: string }) => ({
              kind: 'delivery' as const,
              id: d.id,
              docNum: d.docNum,
              docDate: d.docDate,
              status: d.sapSyncStatus === 'synced' ? 'synced' : d.status,
            })),
          ])
        })
        .catch(onError)
    } else if (deliveryId) {
      api(`/api/deliveries/${deliveryId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
          const d = j.delivery
          if (!d) throw new Error('Không tìm thấy phiếu giao hàng')
          onOk([
            ...(d.sourceOrder ? [{
              kind: 'order' as const,
              id: d.sourceOrder.id,
              docNum: d.sourceOrder.docNum,
              docDate: d.sourceOrder.docDate,
              status: d.sourceOrder.status ?? 'Open',
            }] : []),
            {
              kind: 'delivery' as const,
              id: d.id,
              docNum: d.docNum,
              docDate: d.docDate,
              status: d.sapSyncStatus === 'synced' ? 'synced' : d.status,
              current: true,
            },
          ])
        })
        .catch(onError)
    }
    return () => { cancelled = true }
  }, [orderId, deliveryId, activeId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!activeId) return null

  const isDeliveryMode = !orderId && !!deliveryId
  const title = isDeliveryMode ? `Sơ đồ liên kết — Phiếu #${deliveryDocNum}` : `Sơ đồ liên kết — Đơn #${orderDocNum}`
  const nodes = data && data.id === activeId ? data.nodes : null
  const error = loadError && loadError.id === activeId ? loadError.message : ''

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div
        ref={trapRef}
        className="fm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 640 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 className="fm-modal__title">{title}</h3>
          <button className="fm-icon-btn" onClick={onClose} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>
        {error && <div className="fm-alert fm-alert--error" role="alert">{error}</div>}
        {!nodes && !error && (
          <div style={{ padding: 32, color: 'var(--fm-text-2)' }}>
            <Loader2 size={18} className="fm-spin" /> Đang tải sơ đồ…
          </div>
        )}
        {nodes && (
          <RelationshipMap
            nodes={nodes}
            onGoOrder={(id) => { onClose(); onGoOrder(id) }}
            onGoDelivery={(id) => { onClose(); onGoDelivery(id) }}
          />
        )}
        <p style={{ fontSize: 12, color: 'var(--fm-text-2)', marginTop: 12, marginBottom: 0 }}>
          Bấm vào từng nút để xem chi tiết chứng từ.
        </p>
      </div>
    </div>
  )
}
