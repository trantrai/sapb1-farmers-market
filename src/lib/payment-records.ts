// ============================================================
// GHI NHẬN THANH TOÁN (MỤC 11) — handlers dùng chung cho 3 route:
//   GET  /api/invoices/[id]/payments      — lịch sử thanh toán
//   POST /api/invoices/[id]/payments      — ghi nhận 1 lần thanh toán
//   GET/POST /api/credit-memos/[id]/payments
//   GET/POST /api/down-payments/[id]/payments
//
// Quy ước: RBAC theo module (view cho GET, edit cho POST), cách ly
// theo sapDatabaseId (404 khi sai DB), rate limit cho POST,
// ghi nguyên tử (transaction): tạo PaymentRecord + cập nhật
// paidAmount/paymentStatus của chứng từ.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import type { ModuleKey } from '@/lib/fm-shared'
import { rateLimit } from '@/lib/rate-limit'
import {
  applyPayment,
  validatePaymentAmount,
  type PaymentDocType,
  type PaymentStatus,
} from './payments'

export interface PaymentDocConfig {
  /** Loại chứng từ (PaymentRecord.docType) */
  docType: PaymentDocType
  /** RBAC module key: user.permissions[<permModule>] */
  permModule: ModuleKey
  /** Tên ngắn dùng trong câu lỗi: 'hóa đơn' / 'phiếu ghi có' / 'hóa đơn đặt cọc' */
  short: string
  /** Prisma delegate (đọc ngoài transaction): prisma.arInvoice… */
  model: any
  /** Key delegate trong transaction: 'arInvoice' | 'arCreditMemo' | 'arDownPayment' */
  modelKey: 'arInvoice' | 'arCreditMemo' | 'arDownPayment'
}

export const INVOICE_PAYMENT_CFG: PaymentDocConfig = {
  docType: 'invoice',
  permModule: 'invoices',
  short: 'hóa đơn',
  model: prisma.arInvoice,
  modelKey: 'arInvoice',
}

export const CREDIT_MEMO_PAYMENT_CFG: PaymentDocConfig = {
  docType: 'creditMemo',
  permModule: 'creditMemos',
  short: 'phiếu ghi có',
  model: prisma.arCreditMemo,
  modelKey: 'arCreditMemo',
}

export const DOWN_PAYMENT_PAYMENT_CFG: PaymentDocConfig = {
  docType: 'downPayment',
  permModule: 'downPayments',
  short: 'hóa đơn đặt cọc',
  model: prisma.arDownPayment,
  modelKey: 'arDownPayment',
}

/** Tìm chứng từ theo id — trả null khi không có hoặc thuộc DB khác */
async function findDoc(cfg: PaymentDocConfig, id: string, databaseId: string | null | undefined) {
  const doc = await cfg.model.findUnique({ where: { id } })
  if (!doc) return null
  // B1: cách ly DB — không cho thao tác trên chứng từ của database khác
  if (databaseId && doc.sapDatabaseId !== databaseId) return null
  return doc
}

// ---------- GET: lịch sử thanh toán của chứng từ ----------
export async function paymentListHandler(
  req: NextRequest,
  id: string,
  cfg: PaymentDocConfig,
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.view) {
    return NextResponse.json({ error: `Bạn không có quyền xem ${cfg.short}` }, { status: 403 })
  }
  const doc = await findDoc(cfg, id, user.databaseId)
  if (!doc) return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })

  const payments = await prisma.paymentRecord.findMany({
    where: { docType: cfg.docType, docId: id },
    orderBy: [{ payDate: 'desc' }, { createdAt: 'desc' }],
  })
  return NextResponse.json({ ok: true, payments })
}

// ---------- POST: ghi nhận 1 lần thanh toán ----------
// body: { amount: number, payDate?: string (ISO, mặc định now), remarks?: string }
export async function paymentCreateHandler(
  req: NextRequest,
  id: string,
  cfg: PaymentDocConfig,
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.edit) {
    return NextResponse.json(
      { error: `Bạn không có quyền ghi nhận thanh toán cho ${cfg.short}` },
      { status: 403 },
    )
  }
  const rl = rateLimit(`payment:${cfg.docType}:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Thao tác quá nhanh — vui lòng thử lại sau' },
      { status: 429 },
    )
  }

  const doc = await findDoc(cfg, id, user.databaseId)
  if (!doc) return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })

  const body = (await req.json().catch(() => null)) as {
    amount?: unknown
    payDate?: unknown
    remarks?: unknown
  } | null
  const amount = Number(body?.amount)
  const err = validatePaymentAmount(body?.amount, Number(doc.paidAmount), Number(doc.grandTotal))
  if (err) return NextResponse.json({ error: err }, { status: 400 })

  let payDate: Date | undefined
  const rawDate = body?.payDate
  if (rawDate !== undefined && rawDate !== null && String(rawDate).trim() !== '') {
    const d = new Date(String(rawDate))
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: 'Ngày thanh toán không hợp lệ' }, { status: 400 })
    }
    payDate = d
  }
  const remarks = String(body?.remarks ?? '').trim()

  const next: { paidAmount: number; paymentStatus: PaymentStatus } = applyPayment(
    Number(doc.paidAmount),
    Number(doc.grandTotal),
    amount,
  )

  // Ghi nguyên tử: tạo PaymentRecord + cập nhật paidAmount/paymentStatus
  const payment = await prisma.$transaction(async (tx: any) => {
    const created = await tx.paymentRecord.create({
      data: {
        docType: cfg.docType,
        docId: id,
        amount,
        payDate: payDate ?? new Date(),
        remarks: remarks || null,
        createdBy: user.id,
      },
    })
    await tx[cfg.modelKey].update({
      where: { id },
      data: { paidAmount: next.paidAmount, paymentStatus: next.paymentStatus },
    })
    return created
  })

  return NextResponse.json({
    ok: true,
    payment,
    paidAmount: next.paidAmount,
    paymentStatus: next.paymentStatus,
  })
}
