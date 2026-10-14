'use client'

// ============================================================
// MODAL RELATIONSHIP MAP — mở khi right-click vào dòng SO.
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
  onClose: () => void
  onGoOrder: (id: string) => void
  onGoDelivery: (id: string) => void
}

export default function RelMapModal({ orderId, orderDocNum, onClose, onGoOrder, onGoDelivery }: Props) {
  const [nodes, setNodes] = useState<RelNode[] | null>(null)
  const [error, setError] = useState('')
  const trapRef = useFocusTrap<HTMLDivElement>(!!orderId, onClose)

  useEffect(() => {
    if (!orderId) return
    let cancelled = false
    api(`/api/orders/${orderId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (cancelled) return
        const o = j.order
        if (!o) throw new Error('Không tìm thấy đơn hàng')
        const list: RelNode[] = [
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
        ]
        setNodes(list)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Lỗi tải dữ liệu')
      })
    return () => { cancelled = true }
  }, [orderId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!orderId) return null

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div
        ref={trapRef}
        className="fm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Sơ đồ liên kết đơn hàng #${orderDocNum}`}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 640 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 className="fm-modal__title">Sơ đồ liên kết — Đơn #{orderDocNum}</h3>
          <button className="fm-icon-btn" onClick={onClose} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>
        {error && <div className="fm-alert fm-alert--error" role="alert">{error}</div>}
        {!nodes && !error && (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--fm-text-2)' }}>
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
