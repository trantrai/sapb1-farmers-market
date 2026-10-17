import { NextRequest } from 'next/server'
import { QUOTATION_CFG, salesDocFinalize } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- PATCH /api/quotations/[id]/finalize : duyệt nháp thành báo giá chính thức ----------
// body: { version } — cấp docNum thật từ dãy 'quotation', set isDraft=false,
// rồi đẩy SAP B1 (POST /Quotations) như khi tạo mới.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocFinalize(req, id, QUOTATION_CFG)
}
