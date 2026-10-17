'use client'

// CHI TIẾT Báo giá bán hàng — wrapper mỏng trên view dùng chung
import SalesDocDetailView from './sales-doc-detail-view'
import { QUOTATION_CONFIG, type CopyTarget } from './sales-doc-shared'

interface Props {
  id: string
  onBack: () => void
  onEdit: (id: string) => void
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}

export default function QuotationDetailView(props: Props) {
  return <SalesDocDetailView config={QUOTATION_CONFIG} {...props} />
}
