// ============================================================
// JOB NỀN: TỰ THỬ LẠI ĐƠN CHƯA ĐẨY ĐƯỢC SANG SAP B1
// Chạy mỗi 2 phút (khởi động từ src/instrumentation.ts). Mỗi lượt lấy tối đa
// 10 đơn đến hạn (sapNextRetryAt ≤ now), đẩy LẦN LƯỢT qua syncOrderToSap
// (cùng khoá với nút "Đẩy lại"). Chỉ đơn có lỗi loại safe/unknown mới được
// đặt lịch (xem sap-sync-retry) — lỗi nghiệp vụ / cần đối chiếu không tự thử.
// Tắt được trong Cài đặt (AppSettings.sapAutoRetry).
// ============================================================

import { db as prisma } from './db'
import { syncOrderToSap } from './order-sap-sync'
import { clearSapOrdersCache } from './sap-orders'

const INTERVAL_MS = Math.max(30_000, Number(process.env.SAP_RETRY_INTERVAL_MS) || 120_000)
const BATCH = 10

const g = globalThis as unknown as { __fmSapRetryTimer?: ReturnType<typeof setInterval>; __fmSapRetryRunning?: boolean }

/** Một lượt quét. Trả số đơn đã thử và số đơn lên SAP thành công. */
export async function runSapRetryOnce(now: Date = new Date()): Promise<{ tried: number; synced: number }> {
  if (g.__fmSapRetryRunning) return { tried: 0, synced: 0 }
  g.__fmSapRetryRunning = true
  try {
    const settings = await prisma.appSettings.findUnique({ where: { id: 'main' }, select: { sapAutoRetry: true } })
    if (settings && !settings.sapAutoRetry) return { tried: 0, synced: 0 }
    const due = await prisma.salesOrder.findMany({
      where: {
        sapSyncStatus: { in: ['pending', 'error'] },
        isDraft: false,
        status: { not: 'Cancelled' },
        sapSyncErrorKind: { in: ['safe', 'unknown'] },
        sapNextRetryAt: { lte: now },
      },
      orderBy: { sapNextRetryAt: 'asc' },
      take: BATCH,
      select: { id: true },
    })
    let synced = 0
    for (const o of due) {
      try {
        const r = await syncOrderToSap(o.id, { auto: true })
        if (r.kind === 'done' && r.ok) synced++
      } catch (e) {
        console.error('[sap-retry] order', o.id, e instanceof Error ? e.message : e)
      }
    }
    if (synced > 0) clearSapOrdersCache()
    return { tried: due.length, synced }
  } finally {
    g.__fmSapRetryRunning = false
  }
}

/** Khởi động job (idempotent — hot-reload / gọi lại không tạo thêm timer) */
export function startSapRetryWorker(): void {
  if (g.__fmSapRetryTimer || process.env.SAP_RETRY_DISABLED === '1') return
  g.__fmSapRetryTimer = setInterval(() => {
    runSapRetryOnce().catch((e) => console.error('[sap-retry]', e instanceof Error ? e.message : e))
  }, INTERVAL_MS)
  g.__fmSapRetryTimer.unref?.()
}
