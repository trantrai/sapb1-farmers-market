'use client'

// CHI TIẾT Hóa đơn đặt cọc phải thu (Phase 2) — wrapper mỏng trên view dùng chung
// Hiển thị thêm "Số dư chưa khấu trừ" (remainingAmount) qua config.showRemaining.
import SalesDocDetailView from './sales-doc-detail-view'
import { DOWN_PAYMENT_CONFIG, type CopyTarget } from './sales-doc-shared'

interface Props {
  id: string
  onBack: () => void
  onEdit: (id: string) => void
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}

export default function DownPaymentDetailView(props: Props) {
  return <SalesDocDetailView config={DOWN_PAYMENT_CONFIG} {...props} />
}
