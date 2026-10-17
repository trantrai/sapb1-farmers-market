import { NextRequest } from 'next/server'
import {
  INVOICE_CFG,
  SOURCE_DELIVERY,
  SOURCE_ORDER,
  SOURCE_QUOTATION,
  salesDocFromSource,
} from '@/lib/sales-ar'

// POST /api/invoices/from-source — tạo Hóa đơn bán hàng bằng cách sao chép
// từ chứng từ nguồn (copy-to chuẩn SAP B1).
// body: { sourceType: 'quotation' | 'order' | 'delivery', sourceId: string }
// Copy toàn bộ dòng (giữ giá/CK/thuế/kho + cấu trúc BOM), gắn sourceLineId
// từng dòng và FK nguồn (sourceQuotationId/sourceOrderId/sourceDeliveryId).
// Chống bấm đúp: order lock + dedupeRequest — xem @/lib/sales-ar.
export async function POST(req: NextRequest) {
  return salesDocFromSource(req, INVOICE_CFG, [SOURCE_QUOTATION, SOURCE_ORDER, SOURCE_DELIVERY])
}
