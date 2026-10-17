import { NextRequest } from 'next/server'
import { RETURN_CFG, SOURCE_DELIVERY, SOURCE_INVOICE, salesDocFromSource } from '@/lib/sales-ar'

// POST /api/returns/from-source — tạo Phiếu trả hàng bán bằng cách sao chép
// từ chứng từ nguồn (copy-to chuẩn SAP B1).
// body: { sourceType: 'delivery' | 'invoice', sourceId: string }
// Copy toàn bộ dòng, gắn sourceLineId từng dòng và FK nguồn
// (sourceDeliveryId/sourceInvoiceId). Chống bấm đúp — xem @/lib/sales-ar.
export async function POST(req: NextRequest) {
  return salesDocFromSource(req, RETURN_CFG, [SOURCE_DELIVERY, SOURCE_INVOICE])
}
