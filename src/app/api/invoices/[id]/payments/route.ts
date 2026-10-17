import { NextRequest } from 'next/server'
import { INVOICE_PAYMENT_CFG, paymentCreateHandler, paymentListHandler } from '@/lib/payment-records'

type Ctx = { params: Promise<{ id: string }> }

// ---------- GET /api/invoices/[id]/payments : lịch sử thanh toán của hóa đơn ----------
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return paymentListHandler(req, id, INVOICE_PAYMENT_CFG)
}

// ---------- POST /api/invoices/[id]/payments : ghi nhận 1 lần thanh toán ----------
// body: { amount: number, payDate?: string (ISO, mặc định now), remarks?: string }
// Validate: amount > 0 và ≤ còn lại (grandTotal − paidAmount) → 400 nếu sai.
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  return paymentCreateHandler(req, id, INVOICE_PAYMENT_CFG)
}
