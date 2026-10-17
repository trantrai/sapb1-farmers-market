import { NextRequest } from 'next/server'
import { DOWN_PAYMENT_CFG, salesDocDelete, salesDocDetail, salesDocUpdate } from '@/lib/sales-ar'

type Ctx = { params: Promise<{ id: string }> }

// ---------- GET /api/down-payments/[id] : chi tiết hóa đơn đặt cọc (kèm lines) ----------
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocDetail(req, id, DOWN_PAYMENT_CFG)
}

// ---------- PATCH /api/down-payments/[id] : sửa toàn bộ (khi Open) hoặc đóng/mở/hủy nhanh ----------
// body sửa: { ..., lines, version } | body đổi trạng thái: { status, version }
// Optimistic locking: version bắt buộc, sai → 409 VERSION_CONFLICT.
// Sửa toàn bộ tính lại remainingAmount = tổng mới − tổng đã khấu trừ;
// tổng mới nhỏ hơn số đã khấu trừ → 400.
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocUpdate(req, id, DOWN_PAYMENT_CFG)
}

// ---------- DELETE /api/down-payments/[id] ----------
// Không xóa đặt cọc đã/đang đồng bộ SAP, đã đóng (Closed),
// hoặc đã bị hóa đơn bán hàng khấu trừ.
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return salesDocDelete(req, id, DOWN_PAYMENT_CFG)
}
