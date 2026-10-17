import { NextRequest } from 'next/server'
import { QUOTATION_CFG, salesDocCreate, salesDocList } from '@/lib/sales-ar'

// ---------- GET /api/quotations : danh sách báo giá + filter + phân trang ----------
// Khi đã cấu hình SAP B1 → gộp báo giá live từ Service Layer (GET /Quotations)
// với báo giá local chưa đẩy (khử trùng theo DocEntry) — xem @/lib/sales-ar.
export async function GET(req: NextRequest) {
  return salesDocList(req, QUOTATION_CFG)
}

// ---------- POST /api/quotations : tạo báo giá mới ----------
// docNum cấp từ dãy riêng (DocNumSequence 'quotation'), totals tính qua
// @/lib/order-calc. Phase 1 chỉ lưu local (sapSyncStatus='none').
export async function POST(req: NextRequest) {
  return salesDocCreate(req, QUOTATION_CFG)
}
