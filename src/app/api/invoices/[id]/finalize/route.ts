import { NextRequest } from 'next/server'
import { INVOICE_CFG, salesDocFinalize } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- PATCH /api/invoices/[id]/finalize : duyệt nháp thành hóa đơn chính thức ----------
// body: { version } — cấp docNum thật từ dãy 'invoice', set isDraft=false,
// rồi đẩy SAP B1 (POST /Invoices, kèm DocType/ReserveInvoice + DownPaymentsToDraw
// nếu hóa đơn có draws) như khi tạo mới.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocFinalize(req, id, INVOICE_CFG)
}
