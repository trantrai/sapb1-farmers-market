import { NextRequest } from 'next/server'
import { INVOICE_CFG, salesDocDelete, salesDocDetail, salesDocUpdate } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- GET /api/invoices/[id] : chi tiết hóa đơn (kèm lines) ----------
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocDetail(req, id, INVOICE_CFG)
}

// ---------- PATCH /api/invoices/[id] : sửa toàn bộ (khi Open) hoặc đóng/mở/hủy nhanh ----------
// body sửa: { ..., lines, version } | body đổi trạng thái: { status, version }
// Optimistic locking: version bắt buộc, sai → 409 VERSION_CONFLICT.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocUpdate(req, id, INVOICE_CFG)
}

// ---------- DELETE /api/invoices/[id] ----------
// Không xóa hóa đơn đã/đang đồng bộ SAP hoặc đã đóng (Closed).
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocDelete(req, id, INVOICE_CFG)
}
