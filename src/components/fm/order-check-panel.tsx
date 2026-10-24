'use client'

// ============================================================
// KIỂM TRA ĐƠN TRỰC TIẾP — thay hộp xác nhận trước khi lưu:
// - OrderCheckPanel: vùng liệt kê lỗi/cảnh báo, cập nhật theo form;
//   bấm mục → nhảy tới dòng; cảnh báo có "Bỏ qua"; đơn trùng có "Mở đơn"
// - LineIssueBadge: dấu ⛔/⚠ ngay trên dòng hàng
// - CheckStatusChip: tóm tắt ở thanh thao tác dính đáy
// - CheckNotices: thông báo nổi (không chặn) khi VỪA phát hiện cảnh báo
//   quan trọng (đơn trùng, SL bất thường, giá lệch)
// ============================================================

import { AlertOctagon, AlertTriangle, CheckCircle2, ClipboardCheck, ExternalLink, Loader2, X } from 'lucide-react'
import type { PrecheckIssue } from '@/lib/order-precheck'

export const CHECK_PANEL_ID = 'fm-order-check'

/** Cuộn tới dòng hàng (tr[data-line-key]) và focus ô số lượng */
export function focusLineByKey(key: number) {
  const tr = document.querySelector<HTMLTableRowElement>(`.fm-line-table tr[data-line-key="${key}"]`)
  if (!tr) return
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' })
  tr.classList.add('is-flash')
  window.setTimeout(() => tr.classList.remove('is-flash'), 1600)
  tr.querySelector<HTMLInputElement>('td[data-label="Số lượng"] input')?.focus()
}

/** Cuộn tới vùng Kiểm tra đơn và nháy mục (nếu có) */
export function revealCheckPanel(issueKey?: string) {
  const panel = document.getElementById(CHECK_PANEL_ID)
  if (!panel) return
  panel.scrollIntoView({ block: 'center', behavior: 'smooth' })
  const el = issueKey ? panel.querySelector<HTMLElement>(`[data-issue-key="${CSS.escape(issueKey)}"]`) : panel
  if (!el) return
  el.classList.add('is-flash')
  window.setTimeout(() => el.classList.remove('is-flash'), 1600)
}

const Icon = ({ level, size = 15 }: { level: PrecheckIssue['level']; size?: number }) =>
  level === 'error' ? <AlertOctagon size={size} aria-hidden /> : <AlertTriangle size={size} aria-hidden />

export function OrderCheckPanel({ issues, dismissedCount, checking, warningsOff, onDismiss, onRestore, onOpenOrder }: {
  /** Đã lọc bỏ cảnh báo người dùng bỏ qua */
  issues: PrecheckIssue[]
  dismissedCount: number
  /** Đang tải lịch sử khách (đơn trùng, SL, giá) */
  checking: boolean
  /** Cảnh báo bị tắt hết trong Cài đặt — chỉ còn kiểm lỗi */
  warningsOff?: boolean
  onDismiss: (key: string) => void
  onRestore: () => void
  onOpenOrder?: (orderId: string) => void
}) {
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.length - errors
  const state = errors ? 'is-error' : warnings ? 'is-warning' : 'is-ok'
  return (
    <section id={CHECK_PANEL_ID} className={`fm-ordercheck ${state}`} aria-labelledby="fm-check-title">
      <header className="fm-ordercheck__head">
        <h3 id="fm-check-title" className="fm-ordercheck__title">
          <ClipboardCheck size={16} aria-hidden /> Kiểm tra đơn
        </h3>
        {checking && (
          <span className="fm-ordercheck__busy" role="status"><Loader2 size={13} className="fm-spin" aria-hidden /> Đang đối chiếu lịch sử khách…</span>
        )}
        <span className="fm-ordercheck__counts" aria-live="polite">
          {errors > 0 && <span className="fm-ordercheck__count is-error"><AlertOctagon size={13} aria-hidden /> {errors} lỗi</span>}
          {warnings > 0 && <span className="fm-ordercheck__count is-warning"><AlertTriangle size={13} aria-hidden /> {warnings} cảnh báo</span>}
        </span>
      </header>
      {issues.length === 0 ? (
        <p className="fm-ordercheck__ok"><CheckCircle2 size={15} aria-hidden /> {warningsOff ? 'Không có lỗi (cảnh báo đang tắt trong Cài đặt)' : 'Đơn hợp lệ — không có lỗi hay cảnh báo'}</p>
      ) : (
        <ul className="fm-ordercheck__list">
          {issues.map((i) => (
            <li key={i.key} data-issue-key={i.key} className={`fm-ordercheck__item is-${i.level}`}>
              <Icon level={i.level} />
              {i.lineKey != null ? (
                <button type="button" className="fm-ordercheck__msg fm-link" onClick={() => focusLineByKey(i.lineKey!)} title="Tới dòng hàng">
                  {i.message}
                </button>
              ) : <span className="fm-ordercheck__msg">{i.message}</span>}
              <span className="fm-ordercheck__acts">
                {i.orderId && onOpenOrder && (
                  <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => onOpenOrder(i.orderId!)}>
                    <ExternalLink size={13} aria-hidden /> Mở đơn
                  </button>
                )}
                {i.level === 'warning' && (
                  <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => onDismiss(i.key)} aria-label={`Bỏ qua cảnh báo: ${i.message}`}>
                    Bỏ qua
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <footer className="fm-ordercheck__foot">
        <span>{errors > 0 ? 'Sửa hết lỗi để lưu đơn.' : warnings > 0 ? 'Cảnh báo không chặn lưu — kiểm tra lại hoặc bấm Bỏ qua.' : ''}</span>
        {dismissedCount > 0 && (
          <button type="button" className="fm-link" onClick={onRestore}>Hiện lại {dismissedCount} cảnh báo đã bỏ qua</button>
        )}
      </footer>
    </section>
  )
}

/** Dấu báo trên dòng hàng — bấm để xem lý do ở vùng Kiểm tra đơn */
export function LineIssueBadge({ issues }: { issues: PrecheckIssue[] }) {
  if (issues.length === 0) return null
  const level = issues.some((i) => i.level === 'error') ? 'error' : 'warning'
  const text = issues.map((i) => i.message).join('\n')
  return (
    <button
      type="button"
      className={`fm-line-issue is-${level}`}
      title={text}
      aria-label={`${level === 'error' ? 'Lỗi' : 'Cảnh báo'} dòng: ${text}`}
      onClick={() => revealCheckPanel(issues[0].key)}
    >
      <Icon level={level} size={14} />
    </button>
  )
}

/** Tóm tắt trên thanh thao tác — bấm để tới vùng Kiểm tra đơn */
export function CheckStatusChip({ errors, warnings }: { errors: number; warnings: number }) {
  if (errors === 0 && warnings === 0) {
    return <span className="fm-check-chip is-ok"><CheckCircle2 size={14} aria-hidden /> Đơn hợp lệ</span>
  }
  return (
    <button type="button" className={`fm-check-chip ${errors ? 'is-error' : 'is-warning'}`} onClick={() => revealCheckPanel()}>
      {errors > 0 && <span><AlertOctagon size={14} aria-hidden /> {errors} lỗi</span>}
      {warnings > 0 && <span><AlertTriangle size={14} aria-hidden /> {warnings} cảnh báo</span>}
    </button>
  )
}

export interface CheckNotice {
  key: string
  message: string
  lineKey?: number
}

/** Thông báo nổi góc dưới — tự ẩn (form quản lý thời gian), không chặn thao tác */
export function CheckNotices({ notices, onClose }: { notices: CheckNotice[]; onClose: (key: string) => void }) {
  return (
    <div className="fm-check-notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.key} className="fm-check-notice">
          <AlertTriangle size={16} aria-hidden />
          <button
            type="button"
            className="fm-check-notice__msg"
            onClick={() => { onClose(n.key); if (n.lineKey != null) focusLineByKey(n.lineKey); else revealCheckPanel(n.key) }}
          >
            {n.message}
          </button>
          <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" aria-label="Đóng thông báo" onClick={() => onClose(n.key)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
