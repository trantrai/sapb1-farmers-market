'use client'

// CHI TIẾT Phiếu trả hàng bán — wrapper mỏng trên view dùng chung
import SalesDocDetailView from './sales-doc-detail-view'
import { RETURN_CONFIG, type CopyTarget } from './sales-doc-shared'

interface Props {
  id: string
  onBack: () => void
  onEdit: (id: string) => void
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}

export default function ReturnDetailView(props: Props) {
  return <SalesDocDetailView config={RETURN_CONFIG} {...props} />
}
