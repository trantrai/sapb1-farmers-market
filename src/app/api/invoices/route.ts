import { NextRequest } from 'next/server'
import { INVOICE_CFG, salesDocCreate, salesDocList } from '@/lib/sales-ar'

// ---------- GET /api/invoices : danh sách hóa đơn + filter + phân trang ----------
// Khi đã cấu hình SAP B1 → gộp hóa đơn live từ Service Layer (GET /Invoices)
// với hóa đơn local chưa đẩy (khử trùng theo DocEntry) — xem @/lib/sales-ar.
export async function GET(req: NextRequest) {
  return salesDocList(req, INVOICE_CFG)
}

// ---------- POST /api/invoices : tạo hóa đơn mới ----------
// docNum cấp từ dãy riêng (DocNumSequence 'invoice'), totals tính qua
// @/lib/order-calc. Phase 1 chỉ lưu local (sapSyncStatus='none').
export async function POST(req: NextRequest) {
  return salesDocCreate(req, INVOICE_CFG)
}
