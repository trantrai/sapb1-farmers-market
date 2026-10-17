'use client'

// DANH SÁCH Phiếu ghi có phải thu — wrapper mỏng trên view dùng chung
import type { SessionUser } from '@/lib/fm-shared'
import SalesDocListView from './sales-doc-list-view'
import { CREDIT_MEMO_CONFIG } from './sales-doc-shared'

interface Props {
  user?: SessionUser
  onGoDetail: (id: string) => void
  onGoNew: () => void
  refreshKey?: number
}

export default function CreditMemosListView(props: Props) {
  return <SalesDocListView config={CREDIT_MEMO_CONFIG} {...props} />
}
