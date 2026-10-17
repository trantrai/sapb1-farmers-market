import { NextRequest } from 'next/server'
import { DOWN_PAYMENT_CFG, salesDocFinalize } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- PATCH /api/down-payments/[id]/finalize : duyệt nháp thành chứng từ chính thức ----------
// body: { version } — cấp docNum thật từ dãy 'downPayment', set isDraft=false,
// rồi đẩy SAP B1 (POST /DownPayments) như khi tạo mới.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocFinalize(req, id, DOWN_PAYMENT_CFG)
}
