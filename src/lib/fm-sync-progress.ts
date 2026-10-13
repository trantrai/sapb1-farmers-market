// ============================================================
// TIẾN TRÌNH ĐỒNG BỘ DỮ LIỆU CHỦ (Mặt hàng · Nhóm thuế · Khách hàng)
// - POST /api/xxx/sync trả 202 NGAY, tác vụ chạy NỀN trên server.
// - Progress lưu in-memory theo thực thể; view poll GET 2s/lần để vẽ
//   thanh tiến trình (phase connect → fetch → save → cleanup → done).
// - Khóa chống song song: 1 thực thể chỉ chạy 1 lượt đồng bộ.
// - Lưu trên globalThis để sống sót qua hot-reload của Next dev.
// ============================================================

export type SyncPhase = 'idle' | 'connect' | 'fetch' | 'save' | 'cleanup' | 'done'

export interface SyncProgress {
  running: boolean
  phase: SyncPhase
  message: string
  /** Số bản ghi đã tải được từ SAP (phase fetch — hiển thị phụ) */
  fetched: number
  /** Số dòng đã ghi CSDL / tổng (phase save — thanh % xác định) */
  processed: number
  total: number
  /** Lỗi (khi phase done + running=false) */
  error: string
  startedAt: string
  finishedAt: string
}

const EMPTY: SyncProgress = {
  running: false,
  phase: 'idle',
  message: '',
  fetched: 0,
  processed: 0,
  total: 0,
  error: '',
  startedAt: '',
  finishedAt: '',
}

// Tên thực thể dùng chung routes + views
export type SyncEntity = 'items' | 'vatgroups' | 'partners'

/** Trạng thái nội bộ: thêm cờ cancel so với dữ liệu trả cho client */
interface SyncState extends SyncProgress {
  cancelRequested?: boolean
}

const g = globalThis as unknown as { __fmSyncProgress?: Partial<Record<SyncEntity, SyncState>> }
const store: Partial<Record<SyncEntity, SyncState>> = (g.__fmSyncProgress ??= {})

export function getProgress(entity: SyncEntity): SyncProgress {
  return store[entity] ?? EMPTY
}

/** Bắt đầu lượt đồng bộ mới. Trả false nếu lượt trước vẫn đang chạy (khóa chống song song). */
export function startSync(entity: SyncEntity): boolean {
  const cur = store[entity]
  if (cur?.running) return false
  store[entity] = { ...EMPTY, running: true, phase: 'connect', message: 'Đang kết nối Service Layer…', startedAt: new Date().toISOString() }
  return true
}

export function updateSync(entity: SyncEntity, p: Partial<Omit<SyncProgress, 'running' | 'startedAt'>>): void {
  const cur = store[entity]
  if (!cur) return
  store[entity] = { ...cur, ...p }
}

/** Callback truyền vào loader (fm-items / fm-master) — dạng gọn cho các mốc tiến trình */
export type ProgressCb = (p: { phase: SyncPhase; message: string; fetched?: number; processed?: number; total?: number }) => void

export function endSync(entity: SyncEntity, opts: { message: string; error?: string; processed?: number }): void {
  const cur = store[entity]
  store[entity] = {
    ...(cur ?? EMPTY),
    running: false,
    phase: 'done',
    message: opts.error ? `Đồng bộ thất bại: ${opts.error}` : opts.message,
    error: opts.error ?? '',
    processed: opts.processed ?? cur?.processed ?? 0,
    finishedAt: new Date().toISOString(),
    cancelRequested: false,
  }
}

/**
 * Yêu cầu DỪNG lượt đồng bộ đang chạy của thực thể (hợp tác — cooperative).
 * Trả true khi đã đặt cờ (lượt chạy nền tự dừng ở checkpoint tiếp theo),
 * false khi không có lượt nào đang chạy. Dùng cho nút "Dừng" trên UI.
 */
export function requestSyncCancel(entity: SyncEntity): boolean {
  const cur = store[entity]
  if (!cur?.running) return false
  cur.cancelRequested = true
  updateSync(entity, { message: 'Đang dừng đồng bộ theo yêu cầu người dùng…' })
  return true
}

/** Lượt chạy nền kiểm tra ở các checkpoint (sau mỗi trang fetch, mỗi lô lưu). */
export function isSyncCancelRequested(entity: SyncEntity): boolean {
  return store[entity]?.running === true && store[entity]?.cancelRequested === true
}
