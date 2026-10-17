// ============================================================
// GHI NHẬN THANH TOÁN (MỤC 11) — helpers thuần (không chạm DB),
// test được bằng vitest. Dùng chung cho 3 chứng từ:
// hóa đơn bán hàng (invoice), phiếu ghi có phải thu (creditMemo),
// hóa đơn đặt cọc phải thu (downPayment).
// ============================================================

/** Dung sai so sánh số tiền Float */
export const PAYMENT_EPS = 1e-6

/** Trạng thái thanh toán lưu trên ArInvoice / ArCreditMemo / ArDownPayment */
export type PaymentStatus = 'unpaid' | 'partial' | 'paid'

/** Loại chứng từ hỗ trợ ghi nhận thanh toán (PaymentRecord.docType) */
export type PaymentDocType = 'invoice' | 'creditMemo' | 'downPayment'

/** Map docType → api base của route /api/{base}/[id]/payments */
export const PAYMENT_API_BASE: Record<PaymentDocType, string> = {
  invoice: 'invoices',
  creditMemo: 'credit-memos',
  downPayment: 'down-payments',
}

/** Nhãn tiếng Việt của trạng thái thanh toán */
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'Chưa thanh toán',
  partial: 'Thanh toán một phần',
  paid: 'Đã thanh toán đủ',
}

function fmtVnd(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(n)
}

/**
 * Validate số tiền ghi nhận. Trả null khi hợp lệ, ngược lại trả thông
 * báo lỗi tiếng Việt để API trả 400.
 * Rule: amount là số hữu hạn > 0 và ≤ số còn phải thu (grandTotal − paidAmount).
 */
export function validatePaymentAmount(
  amount: unknown,
  paidAmount: number,
  grandTotal: number,
): string | null {
  const a = Number(amount)
  if (!Number.isFinite(a)) return 'Số tiền phải là một con số hợp lệ'
  if (a <= 0) return 'Số tiền ghi nhận phải lớn hơn 0'
  const remaining = Number(grandTotal) - Number(paidAmount)
  if (a - remaining > PAYMENT_EPS) {
    return `Số tiền ghi nhận vượt số còn phải thu (${fmtVnd(remaining)} ₫)`
  }
  return null
}

/**
 * Suy paidAmount + paymentStatus mới sau khi ghi nhận thêm `amount`.
 * Gọi SAU khi validatePaymentAmount trả null.
 */
export function applyPayment(
  paidAmount: number,
  grandTotal: number,
  amount: number,
): { paidAmount: number; paymentStatus: PaymentStatus } {
  const next = Number(paidAmount) + Number(amount)
  const total = Number(grandTotal)
  const paymentStatus: PaymentStatus = next >= total - PAYMENT_EPS ? 'paid' : 'partial'
  return { paidAmount: next, paymentStatus }
}

/**
 * Suy trạng thái thanh toán hiện tại từ paidAmount / grandTotal
 * (dùng cho UI khi không có sẵn paymentStatus từ server).
 */
export function derivePaymentStatus(paidAmount: number, grandTotal: number): PaymentStatus {
  const paid = Number(paidAmount)
  const total = Number(grandTotal)
  if (paid >= total - PAYMENT_EPS) return 'paid'
  if (paid > PAYMENT_EPS) return 'partial'
  return 'unpaid'
}
