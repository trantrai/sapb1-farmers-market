// ============================================================
// RATE LIMITER đơn giản trong bộ nhớ (theo key: IP, user…)
// Dùng cho các endpoint nhạy cảm (đăng nhập) để chống brute-force.
// Lưu ý: reset khi restart server; đủ dùng cho 1 instance.
// ============================================================

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 5000

function sweep(now: number) {
  if (buckets.size <= MAX_BUCKETS) return
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(k)
    if (buckets.size <= MAX_BUCKETS) break
  }
}

/**
 * Trả về { ok:false, retryAfterSec } khi vượt quá max lần trong windowMs.
 * Mỗi lần gọi (kể cả lần đầu) đều tính 1 lượt.
 */
export function rateLimit(
  key: string,
  max: number,
  windowMs: number,
): { ok: boolean; retryAfterSec: number } {
  const now = Date.now()
  sweep(now)
  const b = buckets.get(key)
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSec: 0 }
  }
  b.count += 1
  if (b.count > max) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) }
  }
  return { ok: true, retryAfterSec: 0 }
}
