'use client'

// FORM tạo/sửa Hóa đơn đặt cọc phải thu (Phase 2) — wrapper mỏng trên form dùng chung
// Hỗ trợ tạo từ Báo giá bán hàng / Đơn hàng bán qua from-source
// (POST /api/down-payments/from-source — do WORKER A triển khai).
import SalesDocFormView from './sales-doc-form-view'
import { DOWN_PAYMENT_CONFIG } from './sales-doc-shared'

interface Props {
  initialId?: string
  /** Tạo từ chứng từ nguồn: 'quotation' | 'order' */
  sourceType?: string
  sourceId?: string
  onBack: () => void
  onSaved: (id: string) => void
  userId?: string
}

export default function DownPaymentFormView(props: Props) {
  return <SalesDocFormView config={DOWN_PAYMENT_CONFIG} {...props} />
}
