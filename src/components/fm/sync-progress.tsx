'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/fm-client'

// ============================================================
// THANH TIẾN TRÌNH ĐỒNG BỘ DỮ LIỆU CHỦ (dùng chung 3 màn:
// Mặt hàng / Nhóm thuế / Khách hàng)
// - POST /api/xxx/sync trả 202 → hook poll GET 2s/lần đọc
//   status.progress → vẽ thanh tiến trình thật theo phase.
// - Quay lại màn giữa chừng: load() thấy progress.running=true
//   → tự tiếp tục polling (tiến trình vẫn chạy trên server).
// ============================================================

export interface SyncProgress {
  running: boolean
  phase: 'idle' | 'connect' | 'fetch' | 'save' | 'cleanup' | 'done'
  message: string
  fetched: number
  processed: number
  total: number
  error: string
  startedAt: string
  finishedAt: string
}

/** Poll progress từ GET {url} (json.status.progress) mỗi 2 giây khi đang chạy */
export function useSyncProgress(url: string, onDone: (p: SyncProgress) => void) {
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone })

  const stop = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    try {
      const res = await api(url)
      if (!res.ok) return
      const json = await res.json().catch(() => ({}))
      const p: SyncProgress | undefined = json.status?.progress
      if (!p) return
      setProgress(p)
      if (!p.running) {
        stop()
        if (p.phase === 'done') doneRef.current(p)
      }
    } catch {
      /* mất kết nối tạm thời — lần poll sau thử lại */
    }
  }, [url, stop])

  const startPolling = useCallback(() => {
    if (pollRef.current) return // đã poll rồi
    pollRef.current = setInterval(poll, 2000)
    void poll()
  }, [poll, stop])

  // Dọn interval khi rời màn hình
  useEffect(() => () => stop(), [stop])

  return { progress, setProgress, startPolling, stop, running: Boolean(progress?.running) }
}

/** Thẻ thanh tiến trình — chỉ render khi đang chạy (phase save có total → % xác định) */
export function SyncProgressCard({ progress }: { progress: SyncProgress | null }) {
  if (!progress?.running) return null
  const determinate = progress.total > 0
  const pct = determinate ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0
  const elapsedSec = progress.startedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(progress.startedAt).getTime()) / 1000))
    : 0
  return (
    <div className="fm-card" style={{ marginBottom: 16, borderColor: 'var(--fm-green)' }} data-testid="sync-progress">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <RefreshCw size={15} style={{ animation: 'fm-spin 1s linear infinite', color: 'var(--fm-green)' }} />
        <b>Đang đồng bộ từ SAP B1</b>
        <span className="fm-chip fm-chip--role" style={{ marginLeft: 'auto' }}>Đã chạy {elapsedSec}s</span>
      </div>
      <div
        className={`fm-syncbar${determinate ? '' : ' fm-syncbar--indet'}`}
        role="progressbar"
        aria-valuenow={determinate ? pct : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="fm-syncbar__fill" style={determinate ? { width: `${pct}%` } : undefined} />
      </div>
      <div className="fm-hint" style={{ marginTop: 6 }}>
        {progress.message}
        {determinate ? ` — ${pct}%` : ''}
        {progress.phase === 'fetch' && progress.fetched > 0 ? ` · đã nhận ${progress.fetched.toLocaleString('vi-VN')}` : ''}
      </div>
      <div className="fm-hint" style={{ marginTop: 4, opacity: 0.75 }}>
        Đồng bộ chạy nền trên máy chủ — bạn có thể chuyển sang trang khác và quay lại, tiến trình vẫn tiếp diễn.
      </div>
    </div>
  )
}
