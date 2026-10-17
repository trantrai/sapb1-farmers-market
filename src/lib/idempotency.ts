// ============================================================
// DEDUPE REQUEST IN-MEMORY — chống bấm đúp / gửi trùng request.
// - key: fingerprint của request (user + tham số).
// - Request trùng key trong TTL_MS nhận lại KẾT QUẢ của lượt đầu
//   (không chạy lại logic tạo dữ liệu).
// - Request thứ 2 tới khi lượt đầu CHƯA xong sẽ đợi chung promise
//   của lượt đầu (không tạo trùng do read-then-act).
// - In-memory + globalThis (sống sót hot-reload); entry tự hết hạn
//   sau TTL để lượt bấm sau (có chủ ý tạo thêm) được chạy mới.
// - Đây KHÔNG thay thế idempotency-key phía DB/client cho các hệ
//   phân tán — chỉ chống double-click trên cùng 1 instance.
// ============================================================
// GIỚI HẠN MULTI-INSTANCE:
// dedupeRequest, acquireOrderLock/releaseOrderLock và rate-limit
// in-memory trong file này CHỈ có hiệu lực trên single-instance
// (một process Node duy nhất).
// Khi deploy multi-instance — PM2 cluster, nhiều container, Vercel
// lambda — mỗi instance có một bộ nhớ riêng: lock/dedupe không thấy
// nhau, nên có thể xảy ra tạo TRÙNG delivery từ cùng 1 đơn (vượt
// OpenQty) hoặc ĐẨY TRÙNG chứng từ sang SAP B1.
// Khi đó cần chuyển sang lock phân tán dùng chung (Redis SET NX với
// TTL, hoặc hàng khóa trong DB), và giữ idempotency-key phía client/DB.
// ============================================================

const TTL_MS = 30_000
const MAX_ENTRIES = 1000

interface Entry {
  promise: Promise<unknown>
  expiresAt: number
}

const g = globalThis as unknown as { __fmIdemDedupe?: Map<string, Entry> }
const store: Map<string, Entry> = (g.__fmIdemDedupe ??= new Map())

function sweep(now: number) {
  if (store.size <= MAX_ENTRIES) return
  for (const [k, e] of store) {
    if (now >= e.expiresAt) store.delete(k)
    if (store.size <= MAX_ENTRIES) break
  }
}

/**
 * Chạy work() tối đa 1 lần cho mỗi key trong TTL.
 * Trả { result, replayed } — replayed=true khi đây là lượt bấm trùng
 * và kết quả được tái sử dụng từ lượt đầu.
 */
export async function dedupeRequest<T>(
  key: string,
  work: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const now = Date.now()
  sweep(now)
  const hit = store.get(key)
  if (hit && now < hit.expiresAt) {
    const result = (await hit.promise) as T
    return { result, replayed: true }
  }
  const promise = work()
  store.set(key, { promise, expiresAt: now + TTL_MS })
  // Không xóa ngay khi xong: bấm đúp sau khi lượt đầu hoàn tất
  // (vài giây) vẫn nhận kết quả cũ thay vì tạo trùng.
  promise.catch(() => {}).finally(() => {
    setTimeout(() => {
      if (store.get(key)?.promise === promise) store.delete(key)
    }, TTL_MS)
  })
  const result = await promise
  return { result, replayed: false }
}

/**
 * Lock per-order cho from-order: chỉ 1 lượt tạo delivery từ 1 đơn
 * được chạy tại 1 thời điểm (chống 2 tab vượt OpenQty).
 * Lượt thứ 2 nhận lỗi 409 thay vì chạy song song.
 */
const orderLocks = new Map<string, number>()
const LOCK_TTL_MS = 60_000 // Lock tự hết hạn sau 60s — chống kẹt khi request crash giữa chừng

export function acquireOrderLock(orderId: string): boolean {
  const now = Date.now()
  const held = orderLocks.get(orderId)
  // Lock đã hết hạn → coi như đã release, cho phép acquire lại
  if (held !== undefined && now - held < LOCK_TTL_MS) return false
  orderLocks.set(orderId, now)
  return true
}

export function releaseOrderLock(orderId: string): void {
  orderLocks.delete(orderId)
}
