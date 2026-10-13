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

/**
 * Giành khóa đẩy theo phạm vi (scope: 'order' | 'delivery' | ...).
 * Mỗi id chỉ có 1 lượt đẩy tại 1 thời điểm — chống 2 request "Đẩy"
 * đồng thời tạo trùng chứng từ trên SAP (read-then-act).
 * Trả false nếu đang có lượt đẩy khác (chưa stale).
 */
export function acquirePushLock(scope: string, id: string): boolean {
  const key = `${scope}:${id}`
  const at = locks.get(key)
  if (at !== undefined && Date.now() - at < STALE_MS) return false
  locks.set(key, Date.now())
  return true
}

/** Nhả khóa sau khi đẩy xong (thành công hay thất bại). */
export function releasePushLock(scope: string, id: string): void {
  locks.delete(`${scope}:${id}`)
}

/** Giành khóa đẩy cho đơn. Trả false nếu đang có lượt đẩy khác (chưa stale). */
export function acquireOrderPushLock(orderId: string): boolean {
  return acquirePushLock('order', orderId)
}

/** Nhả khóa sau khi đẩy xong (thành công hay thất bại). */
export function releaseOrderPushLock(orderId: string): void {
  releasePushLock('order', orderId)
}
