'use client'

// FORM tạo/sửa Báo giá bán hàng (đầu luồng — không có from-source) — wrapper mỏng trên form dùng chung
import SalesDocFormView from './sales-doc-form-view'
import { QUOTATION_CONFIG } from './sales-doc-shared'

interface Props {
  initialId?: string
  sourceType?: string
  sourceId?: string
  onBack: () => void
  onSaved: (id: string) => void
  userId?: string
}

export default function QuotationFormView(props: Props) {
  return <SalesDocFormView config={QUOTATION_CONFIG} {...props} />
}
