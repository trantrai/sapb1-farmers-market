// ============================================================
// KHÓA ĐẨY ĐƠN SANG SAP B1 (theo từng đơn hàng)
// Mỗi đơn chỉ có 1 lượt đẩy tại 1 thời điểm — chống 2 request
// "Đẩy lại" đồng thời tạo trùng chứng từ trên SAP (read-then-act).
// In-memory + globalThis (sống sót hot-reload); stale lock tự hết
// hạn sau 10 phút để không kẹt vĩnh viễn nếu tiến trình crash.
// ============================================================

const STALE_MS = 10 * 60 * 1000

const g = globalThis as unknown as { __fmOrderPushLocks?: Map<string, number> }
const locks: Map<string, number> = (g.__fmOrderPushLocks ??= new Map())

/** Giành khóa đẩy cho đơn. Trả false nếu đang có lượt đẩy khác (chưa stale). */
export function acquireOrderPushLock(orderId: string): boolean {
  const at = locks.get(orderId)
  if (at !== undefined && Date.now() - at < STALE_MS) return false
  locks.set(orderId, Date.now())
  return true
}

/** Nhả khóa sau khi đẩy xong (thành công hay thất bại). */
export function releaseOrderPushLock(orderId: string): void {
  locks.delete(orderId)
}
