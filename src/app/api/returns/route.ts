import { NextRequest } from 'next/server'
import { RETURN_CFG, salesDocCreate, salesDocList } from '@/lib/sales-ar'

// ---------- GET /api/returns : danh sách phiếu trả hàng + filter + phân trang ----------
// Khi đã cấu hình SAP B1 → gộp phiếu trả hàng live từ Service Layer (GET /Returns)
// với phiếu local chưa đẩy (khử trùng theo DocEntry) — xem @/lib/sales-ar.
export async function GET(req: NextRequest) {
  return salesDocList(req, RETURN_CFG)
}

// ---------- POST /api/returns : tạo phiếu trả hàng mới ----------
// docNum cấp từ dãy riêng (DocNumSequence 'return'), totals tính qua
// @/lib/order-calc. Phase 1 chỉ lưu local (sapSyncStatus='none').
export async function POST(req: NextRequest) {
  return salesDocCreate(req, RETURN_CFG)
}
