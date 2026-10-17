'use client'

// FORM tạo/sửa Phiếu trả hàng bán (hỗ trợ tạo từ Phiếu giao hàng / Hóa đơn bán hàng)
import SalesDocFormView from './sales-doc-form-view'
import { RETURN_CONFIG } from './sales-doc-shared'

interface Props {
  initialId?: string
  sourceType?: string
  sourceId?: string
  onBack: () => void
  onSaved: (id: string) => void
  userId?: string
}

export default function ReturnFormView(props: Props) {
  return <SalesDocFormView config={RETURN_CONFIG} {...props} />
}
