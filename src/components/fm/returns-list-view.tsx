'use client'

// DANH SÁCH Phiếu trả hàng bán — wrapper mỏng trên view dùng chung
import type { SessionUser } from '@/lib/fm-shared'
import SalesDocListView from './sales-doc-list-view'
import { RETURN_CONFIG } from './sales-doc-shared'

interface Props {
  user?: SessionUser
  onGoDetail: (id: string) => void
  onGoNew: () => void
  refreshKey?: number
}

export default function ReturnsListView(props: Props) {
  return <SalesDocListView config={RETURN_CONFIG} {...props} />
}
