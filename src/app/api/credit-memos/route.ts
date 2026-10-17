import { NextRequest } from 'next/server'
import { CREDIT_MEMO_CFG, salesDocCreate, salesDocList } from '@/lib/sales-ar'

// ---------- GET /api/credit-memos : danh sách phiếu ghi có + filter + phân trang ----------
// Khi đã cấu hình SAP B1 → gộp phiếu ghi có live từ Service Layer (GET /CreditNotes)
// với phiếu local chưa đẩy (khử trùng theo DocEntry) — xem @/lib/sales-ar.
export async function GET(req: NextRequest) {
  return salesDocList(req, CREDIT_MEMO_CFG)
}

// ---------- POST /api/credit-memos : tạo phiếu ghi có mới ----------
// docNum cấp từ dãy riêng (DocNumSequence 'creditMemo'), totals tính qua
// @/lib/order-calc. Phase 1 chỉ lưu local (sapSyncStatus='none').
export async function POST(req: NextRequest) {
  return salesDocCreate(req, CREDIT_MEMO_CFG)
}
