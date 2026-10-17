import { NextRequest } from 'next/server'
import { RETURN_CFG, salesDocFinalize } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- PATCH /api/returns/[id]/finalize : duyệt nháp thành phiếu trả hàng chính thức ----------
// body: { version } — cấp docNum thật từ dãy 'return', set isDraft=false,
// rồi đẩy SAP B1 (POST /Returns) như khi tạo mới.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocFinalize(req, id, RETURN_CFG)
}
