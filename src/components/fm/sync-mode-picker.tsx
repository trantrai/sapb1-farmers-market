'use client'

// ============================================================
// CHỌN CHẾ ĐỘ ĐỒNG BỘ master data từ SAP B1:
//  · auto (mặc định) — gia tăng nếu đã có mốc thay đổi, ngược lại toàn phần.
//  · incremental — chỉ tải bản ghi thay đổi kể từ mốc (UpdateDate, UpdateTime)
//    đã lưu: nhanh, nhẹ; không phát hiện bản ghi bị XÓA trên SAP.
//  · full — tải toàn bộ danh mục, thay mới mirror: chậm hơn nhưng khớp hẳn,
//    nên chạy định kỳ (vd mỗi tuần).
// ============================================================

export type SyncMode = 'auto' | 'incremental' | 'full'

export default function SyncModePicker({
  mode,
  onChange,
  disabled,
  hasWatermark,
}: {
  mode: SyncMode
  onChange: (m: SyncMode) => void
  disabled?: boolean
  hasWatermark: boolean
}) {
  return (
    <label className="fm-hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      Chế độ:
      <select
        className="fm-input"
        value={mode}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as SyncMode)}
        style={{ width: 'auto', padding: '4px 8px', fontSize: 12.5 }}
        title="Tăng dần: chỉ tải bản ghi thay đổi kể từ mốc đã lưu (nhanh). Toàn phần: tải lại toàn bộ danh mục (chậm hơn, khớp hẳn kể cả bản ghi bị xóa trên SAP)."
      >
        <option value="auto">Tự động {hasWatermark ? '(sẽ chạy tăng dần)' : '(sẽ chạy toàn phần)'}</option>
        <option value="incremental" disabled={!hasWatermark}>Tăng dần — chỉ tải thay đổi</option>
        <option value="full">Toàn phần — tải lại hết</option>
      </select>
    </label>
  )
}

/** Định dạng mốc watermark để hiển thị: date 'YYYY-MM-DD' + time HHMMSS */
export function fmtWatermark(date: string | null, time: number | null): string {
  if (!date) return 'chưa có'
  const [y, m, d] = date.split('-')
  let hm = ''
  if (time != null && time > 0) {
    const t = String(time).padStart(6, '0')
    hm = ` ${t.slice(0, 2)}:${t.slice(2, 4)}`
  }
  return `${d}/${m}/${y}${hm}`
}
