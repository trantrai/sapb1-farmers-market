'use client'

// CHI TIẾT Hóa đơn bán hàng — wrapper mỏng trên view dùng chung
import SalesDocDetailView from './sales-doc-detail-view'
import { INVOICE_CONFIG, type CopyTarget } from './sales-doc-shared'

interface Props {
  id: string
  onBack: () => void
  onEdit: (id: string) => void
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}

export default function InvoiceDetailView(props: Props) {
  return <SalesDocDetailView config={INVOICE_CONFIG} {...props} />
}
