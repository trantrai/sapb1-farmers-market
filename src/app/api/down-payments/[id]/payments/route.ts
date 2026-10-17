import { NextRequest } from 'next/server'
import { DOWN_PAYMENT_PAYMENT_CFG, paymentCreateHandler, paymentListHandler } from '@/lib/payment-records'

type Ctx = { params: Promise<{ id: string }> }

// ---------- GET /api/down-payments/[id]/payments : lịch sử thanh toán của hóa đơn đặt cọc ----------
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return paymentListHandler(req, id, DOWN_PAYMENT_PAYMENT_CFG)
}

// ---------- POST /api/down-payments/[id]/payments : ghi nhận 1 lần thanh toán ----------
// body: { amount: number, payDate?: string (ISO, mặc định now), remarks?: string }
// Validate: amount > 0 và ≤ còn lại (grandTotal − paidAmount) → 400 nếu sai.
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return paymentCreateHandler(req, id, DOWN_PAYMENT_PAYMENT_CFG)
}
