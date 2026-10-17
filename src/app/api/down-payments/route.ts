import { NextRequest } from 'next/server'
import { DOWN_PAYMENT_CFG, salesDocCreate, salesDocList } from '@/lib/sales-ar'

// ---------- GET /api/down-payments : danh sách hóa đơn đặt cọc + filter + phân trang ----------
// Khi đã cấu hình SAP B1 → gộp đặt cọc live từ Service Layer (GET /DownPayments)
// với đặt cọc local chưa đẩy (khử trùng theo DocEntry) — xem @/lib/sales-ar.
// Filter nháp: ?isDraft=true | ?isDraft=false
export async function GET(req: NextRequest) {
  return salesDocList(req, DOWN_PAYMENT_CFG)
}

// ---------- POST /api/down-payments : tạo hóa đơn đặt cọc mới ----------
// docNum cấp từ dãy riêng (DocNumSequence 'downPayment'), totals tính qua
// @/lib/order-calc, remainingAmount khởi tạo = grandTotal.
// ?draft=true → lưu nháp (isDraft=true, docNum=null, không đẩy SAP).
// Tạo từ Báo giá/Đơn hàng: POST /api/down-payments/from-source
export async function POST(req: NextRequest) {
  return salesDocCreate(req, DOWN_PAYMENT_CFG)
}
