'use client'

// DANH SÁCH Báo giá bán hàng — wrapper mỏng trên view dùng chung
import type { SessionUser } from '@/lib/fm-shared'
import SalesDocListView from './sales-doc-list-view'
import { QUOTATION_CONFIG } from './sales-doc-shared'

interface Props {
  user?: SessionUser
  onGoDetail: (id: string) => void
  onGoNew: () => void
  refreshKey?: number
}

export default function QuotationsListView(props: Props) {
  return <SalesDocListView config={QUOTATION_CONFIG} {...props} />
}
