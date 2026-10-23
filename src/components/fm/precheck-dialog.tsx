'use client'

// ============================================================
// BẢNG KIỂM TRA TRƯỚC KHI LƯU — liệt kê mọi lỗi + cảnh báo 1 lần.
// Có lỗi → chỉ "Quay lại sửa"; chỉ có cảnh báo → thêm "Vẫn lưu".
// Bấm 1 mục có dòng liên quan → đóng bảng và nhảy tới dòng đó.
// ============================================================

import { AlertOctagon, AlertTriangle, ClipboardCheck } from 'lucide-react'
import { useFocusTrap } from './use-focus-trap'
import type { PrecheckIssue } from '@/lib/order-precheck'

/** Cuộn tới dòng hàng (tr[data-line-key]) và focus ô số lượng */
export function focusLineByKey(key: number) {
  const tr = document.querySelector<HTMLTableRowElement>(`.fm-line-table tr[data-line-key="${key}"]`)
  if (!tr) return
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' })
  tr.classList.add('is-flash')
  window.setTimeout(() => tr.classList.remove('is-flash'), 1600)
  tr.querySelector<HTMLInputElement>('td[data-label="Số lượng"] input')?.focus()
}

export default function PrecheckDialog({ issues, onProceed, onClose }: {
  issues: PrecheckIssue[]
  onProceed: () => void
  onClose: () => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  const errors = issues.filter((i) => i.level === 'error')
  const warnings = issues.filter((i) => i.level === 'warning')
  const item = (i: PrecheckIssue, idx: number) => (
    <li key={idx} className={`fm-precheck__item is-${i.level}`}>
      {i.level === 'error' ? <AlertOctagon size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
      {i.lineKey != null ? (
        <button type="button" className="fm-link" onClick={() => { onClose(); focusLineByKey(i.lineKey!) }}>{i.message}</button>
      ) : <span>{i.message}</span>}
    </li>
  )
  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div
        ref={trapRef}
        className="fm-modal fm-precheck"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fm-precheck-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="fm-precheck-title" className="fm-modal__title"><ClipboardCheck size={18} aria-hidden /> Kiểm tra trước khi lưu</h3>
        {errors.length > 0 && (
          <>
            <p className="fm-precheck__group is-error">{errors.length} lỗi cần sửa trước khi lưu</p>
            <ul className="fm-precheck__list">{errors.map(item)}</ul>
          </>
        )}
        {warnings.length > 0 && (
          <>
            <p className="fm-precheck__group is-warning">{warnings.length} cảnh báo — kiểm tra lại hoặc vẫn lưu</p>
            <ul className="fm-precheck__list">{warnings.map(item)}</ul>
          </>
        )}
        <div className="fm-bom-swap__foot">
          <button type="button" className="fm-btn fm-btn--secondary" onClick={onClose} autoFocus>Quay lại sửa</button>
          {errors.length === 0 && (
            <button type="button" className="fm-btn fm-btn--primary" onClick={onProceed}>Vẫn lưu</button>
          )}
        </div>
      </div>
    </div>
  )
}
