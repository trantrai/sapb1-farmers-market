import { NextRequest } from 'next/server'
import { CREDIT_MEMO_CFG, SOURCE_INVOICE, SOURCE_RETURN, salesDocFromSource } from '@/lib/sales-ar'

// POST /api/credit-memos/from-source — tạo Phiếu ghi có phải thu bằng cách
// sao chép từ chứng từ nguồn (copy-to chuẩn SAP B1).
// body: { sourceType: 'invoice' | 'return', sourceId: string }
// Copy toàn bộ dòng, gắn sourceLineId từng dòng và FK nguồn
// (sourceInvoiceId/sourceReturnId). Chống bấm đúp — xem @/lib/sales-ar.
export async function POST(req: NextRequest) {
  return salesDocFromSource(req, CREDIT_MEMO_CFG, [SOURCE_INVOICE, SOURCE_RETURN])
}
