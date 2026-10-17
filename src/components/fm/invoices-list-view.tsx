'use client'

// DANH SÁCH Hóa đơn bán hàng — wrapper mỏng trên view dùng chung
import type { SessionUser } from '@/lib/fm-shared'
import SalesDocListView from './sales-doc-list-view'
import { INVOICE_CONFIG } from './sales-doc-shared'

interface Props {
  user?: SessionUser
  onGoDetail: (id: string) => void
  onGoNew: () => void
  refreshKey?: number
}

export default function InvoicesListView(props: Props) {
  return <SalesDocListView config={INVOICE_CONFIG} {...props} />
}
