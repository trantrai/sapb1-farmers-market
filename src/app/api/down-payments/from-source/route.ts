import { NextRequest } from 'next/server'
import {
  DOWN_PAYMENT_CFG,
  SOURCE_ORDER,
  SOURCE_QUOTATION,
  salesDocFromSource,
} from '@/lib/sales-ar'

// POST /api/down-payments/from-source — tạo Hóa đơn đặt cọc phải thu bằng
// cách sao chép từ chứng từ nguồn (copy-to chuẩn SAP B1).
// body: { sourceType: 'quotation' | 'order', sourceId: string }
// Copy toàn bộ dòng (giữ giá/CK/thuế/kho + cấu trúc BOM), gắn sourceLineId
// từng dòng và FK nguồn (sourceQuotationId/sourceOrderId).
// remainingAmount khởi tạo = grandTotal.
// ?draft=true → tạo bản nháp (chưa cấp số, không đẩy SAP).
// Chống bấm đúp: order lock + dedupeRequest — xem @/lib/sales-ar.
export async function POST(req: NextRequest) {
  return salesDocFromSource(req, DOWN_PAYMENT_CFG, [SOURCE_QUOTATION, SOURCE_ORDER])
}
