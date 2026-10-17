import { NextRequest } from 'next/server'
import { CREDIT_MEMO_CFG, salesDocFinalize } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- PATCH /api/credit-memos/[id]/finalize : duyệt nháp thành phiếu ghi có chính thức ----------
// body: { version } — cấp docNum thật từ dãy 'creditMemo', set isDraft=false,
// rồi đẩy SAP B1 (POST /CreditNotes) như khi tạo mới.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocFinalize(req, id, CREDIT_MEMO_CFG)
}
