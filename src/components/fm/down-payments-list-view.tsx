'use client'

// DANH SÁCH Hóa đơn đặt cọc phải thu (Phase 2) — wrapper mỏng trên view dùng chung
// Backend (contract): GET /api/down-payments — do WORKER A triển khai.
import type { SessionUser } from '@/lib/fm-shared'
import SalesDocListView from './sales-doc-list-view'
import { DOWN_PAYMENT_CONFIG } from './sales-doc-shared'

interface Props {
  user?: SessionUser
  onGoDetail: (id: string) => void
  onGoNew: () => void
  refreshKey?: number
}

export default function DownPaymentsListView(props: Props) {
  return <SalesDocListView config={DOWN_PAYMENT_CONFIG} {...props} />
}
