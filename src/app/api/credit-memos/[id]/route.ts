import { NextRequest } from 'next/server'
import { CREDIT_MEMO_CFG, salesDocDelete, salesDocDetail, salesDocUpdate } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- GET /api/credit-memos/[id] : chi tiết phiếu ghi có (kèm lines) ----------
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocDetail(req, id, CREDIT_MEMO_CFG)
}

// ---------- PATCH /api/credit-memos/[id] : sửa toàn bộ (khi Open) hoặc đóng/mở/hủy nhanh ----------
// body sửa: { ..., lines, version } | body đổi trạng thái: { status, version }
// Optimistic locking: version bắt buộc, sai → 409 VERSION_CONFLICT.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocUpdate(req, id, CREDIT_MEMO_CFG)
}

// ---------- DELETE /api/credit-memos/[id] ----------
// Không xóa phiếu ghi có đã/đang đồng bộ SAP hoặc đã đóng (Closed).
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocDelete(req, id, CREDIT_MEMO_CFG)
}
