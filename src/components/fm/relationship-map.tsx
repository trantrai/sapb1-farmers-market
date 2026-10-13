'use client'

// ============================================================
// RELATIONSHIP MAP — sơ đồ luồng chứng từ:
//   Sales Order → Delivery → (AR Invoice tương lai)
// Mỗi node: loại, số CT, ngày, trạng thái; click nhảy sang chi tiết.
// ============================================================

import { FileText, Truck, Receipt } from 'lucide-react'
import { formatDateVN } from '@/lib/fm-shared'

export interface RelNode {
  kind: 'order' | 'delivery' | 'invoice'
  id: string
  docNum: number
  docDate: string
  status: string
  /** true = node hiện tại đang xem */
  current?: boolean
}

interface Props {
  nodes: RelNode[]
  onGoOrder: (id: string) => void
  onGoDelivery: (id: string) => void
}

const KIND_META = {
  order: { label: 'Sale Order', icon: FileText, color: 'var(--fm-navy)' },
  delivery: { label: 'Delivery', icon: Truck, color: 'var(--fm-primary-text)' },
  invoice: { label: 'AR Invoice', icon: Receipt, color: 'var(--fm-coral)' },
} as const

const STATUS_LABEL: Record<string, string> = {
  Open: 'Mở',
  Closed: 'Đóng',
  Cancelled: 'Hủy',
  none: 'Chưa đẩy SAP',
  pending: 'Đẩy lỗi',
  synced: 'Đã đẩy SAP',
}

export default function RelationshipMap({ nodes, onGoOrder, onGoDelivery }: Props) {
  if (nodes.length === 0) return null
  return (
    <div className="fm-relmap" role="list" aria-label="Sơ đồ liên kết chứng từ">
      {nodes.map((n, i) => {
        const meta = KIND_META[n.kind]
        const Icon = meta.icon
        const clickable = n.kind !== 'invoice'
        return (
          <div key={`${n.kind}-${n.id}`} className="fm-relmap__step" role="listitem">
            {i > 0 && <div className="fm-relmap__arrow" aria-hidden>→</div>}
            <button
              type="button"
              className={`fm-relmap__node${n.current ? ' is-current' : ''}`}
              style={{ ['--rel-color' as string]: meta.color }}
              disabled={!clickable}
              onClick={() => {
                if (n.kind === 'order') onGoOrder(n.id)
                else if (n.kind === 'delivery') onGoDelivery(n.id)
              }}
              title={clickable ? `Xem ${meta.label} #${n.docNum}` : `${meta.label} #${n.docNum}`}
            >
              <span className="fm-relmap__icon"><Icon size={18} /></span>
              <span className="fm-relmap__kind">{meta.label}</span>
              <span className="fm-relmap__num">#{n.docNum}</span>
              <span className="fm-relmap__date">{formatDateVN(n.docDate)}</span>
              <span className="fm-relmap__status">{STATUS_LABEL[n.status] ?? n.status}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
