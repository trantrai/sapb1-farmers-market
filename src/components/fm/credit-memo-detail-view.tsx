'use client'

// CHI TIẾT Phiếu ghi có phải thu — wrapper mỏng trên view dùng chung
// (cuối luồng — không có nút Sao chép sang)
import SalesDocDetailView from './sales-doc-detail-view'
import { CREDIT_MEMO_CONFIG, type CopyTarget } from './sales-doc-shared'

interface Props {
  id: string
  onBack: () => void
  onEdit: (id: string) => void
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}

export default function CreditMemoDetailView(props: Props) {
  return <SalesDocDetailView config={CREDIT_MEMO_CONFIG} {...props} />
}
