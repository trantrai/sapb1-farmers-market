'use client'

import { useEffect, useRef } from 'react'
import { AlertTriangle, AlertOctagon, Info, X } from 'lucide-react'
import { useFocusTrap } from './use-focus-trap'

export type ConfirmTone = 'danger' | 'warning' | 'primary'

interface ConfirmDialogProps {
  /** Hiện/ẩn dialog */
  open: boolean
  /** Tiêu đề */
  title: string
  /** Nội dung (hỗ trợ \n xuống dòng) */
  message: string
  /** Nhãn nút xác nhận — mặc định "Đồng ý" */
  confirmLabel?: string
  /** Nhãn nút hủy — mặc định "Hủy bỏ" */
  cancelLabel?: string
  /** Tông màu: danger (coral) | warning (gold) | primary (navy) */
  tone?: ConfirmTone
  /** Gọi khi bấm xác nhận */
  onConfirm: () => void
  /** Gọi khi bấm hủy / Escape / click backdrop */
  onCancel: () => void
}

const TONE_STYLE: Record<ConfirmTone, { icon: typeof Info; color: string; border: string; btnClass: string }> = {
  danger: { icon: AlertOctagon, color: 'var(--fm-coral-deep)', border: 'var(--fm-coral)', btnClass: 'fm-btn--danger' },
  warning: { icon: AlertTriangle, color: 'var(--fm-gold-ink)', border: 'var(--fm-gold)', btnClass: 'fm-btn--primary' },
  primary: { icon: Info, color: 'var(--fm-navy)', border: 'var(--fm-navy)', btnClass: 'fm-btn--primary' },
}

/**
 * Dialog xác nhận thay thế window.confirm():
 * - Focus vào nút Hủy mặc định (an toàn), Enter = xác nhận, Escape/backdrop = hủy
 * - Dùng chung .fm-backdrop/.fm-modal và hook useFocusTrap của app
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Đồng ý',
  cancelLabel = 'Hủy bỏ',
  tone = 'primary',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onCancel)
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null)

  // Focus vào nút Hủy khi mở dialog (an toàn: thao tác nguy hiểm không được focus trước)
  useEffect(() => {
    if (open) cancelBtnRef.current?.focus()
  }, [open ])

  if (!open) return null

  const t = TONE_STYLE[tone]
  const Icon = t.icon

  return (
    <div className="fm-backdrop" onClick={onCancel}>
      <div
        ref={trapRef}
        className="fm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fm-confirm-title"
        aria-describedby="fm-confirm-msg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 440, borderTopColor: t.border }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <h3
            id="fm-confirm-title"
            className="fm-modal__title"
            style={{ display: 'flex', alignItems: 'center', gap: 8, color: t.color }}
          >
            <Icon size={18} aria-hidden />
            {title}
          </h3>
          <button type="button" className="fm-icon-btn" onClick={onCancel} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>

        <p id="fm-confirm-msg" style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.6, color: 'var(--fm-text-2)', whiteSpace: 'pre-line' }}>
          {message}
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            ref={cancelBtnRef}
            type="button"
            className="fm-btn fm-btn--secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`fm-btn ${t.btnClass}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
