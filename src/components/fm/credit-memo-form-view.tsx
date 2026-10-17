'use client'

// FORM tạo/sửa Phiếu ghi có phải thu (hỗ trợ tạo từ Hóa đơn bán hàng / Phiếu trả hàng bán)
import SalesDocFormView from './sales-doc-form-view'
import { CREDIT_MEMO_CONFIG } from './sales-doc-shared'

interface Props {
  initialId?: string
  sourceType?: string
  sourceId?: string
  onBack: () => void
  onSaved: (id: string) => void
  userId?: string
}

export default function CreditMemoFormView(props: Props) {
  return <SalesDocFormView config={CREDIT_MEMO_CONFIG} {...props} />
}
