'use client'

// FORM tạo/sửa Hóa đơn bán hàng (hỗ trợ tạo từ Báo giá / Đơn hàng bán / Phiếu giao hàng)
import SalesDocFormView from './sales-doc-form-view'
import { INVOICE_CONFIG } from './sales-doc-shared'

interface Props {
  initialId?: string
  sourceType?: string
  sourceId?: string
  onBack: () => void
  onSaved: (id: string) => void
  userId?: string
}

export default function InvoiceFormView(props: Props) {
  return <SalesDocFormView config={INVOICE_CONFIG} {...props} />
}
