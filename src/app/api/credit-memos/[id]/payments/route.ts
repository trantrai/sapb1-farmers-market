import { NextRequest } from 'next/server'
import { CREDIT_MEMO_PAYMENT_CFG, paymentCreateHandler, paymentListHandler } from '@/lib/payment-records'

type Ctx = { params: Promise<{ id: string }> }

// ---------- GET /api/credit-memos/[id]/payments : lịch sử thanh toán của phiếu ghi có ----------
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return paymentListHandler(req, id, CREDIT_MEMO_PAYMENT_CFG)
}

// ---------- POST /api/credit-memos/[id]/payments : ghi nhận 1 lần thanh toán ----------
// body: { amount: number, payDate?: string (ISO, mặc định now), remarks?: string }
// Validate: amount > 0 và ≤ còn lại (grandTotal − paidAmount) → 400 nếu sai.
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return paymentCreateHandler(req, id, CREDIT_MEMO_PAYMENT_CFG)
}
