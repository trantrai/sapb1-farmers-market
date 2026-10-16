'use client'

import type { ReactNode } from 'react'
import { Home } from 'lucide-react'

/** Một mục breadcrumb: string thuần (text trang trí) hoặc object có onNavigate để điều hướng */
export interface BreadcrumbItem {
  label: string
  /** Hàm điều hướng khi bấm mục — không có thì item chỉ là text */
  onNavigate?: () => void
}

interface PageHeaderProps {
  breadcrumb: (string | BreadcrumbItem)[]
  title: string
  badge?: string
  /** Tooltip giải thích đúng bản chất của badge (vd: "Dữ liệu cache 45s") */
  badgeHint?: string
  actions?: ReactNode
}

/**
 * Page header theo thiết kế Stitch: breadcrumb + H1 + badge + nút action
 *
 * Breadcrumb: các mục không phải cuối có onNavigate sẽ render dạng button/link
 * để điều hướng thật; mục cuối luôn là trang hiện tại (aria-current="page").
 * string[] cũ vẫn dùng được như trước (tương thích ngược).
 */
export default function PageHeader({ breadcrumb, title, badge, badgeHint, actions }: PageHeaderProps) {
  return (
    <div className="fm-pageheader">
      <div>
        <nav className="fm-breadcrumb" aria-label="Breadcrumb">
          <Home size={14} className="fm-breadcrumb__icon" aria-hidden="true" />
          {breadcrumb.map((crumb, i) => {
            const label = typeof crumb === 'string' ? crumb : crumb.label
            const onNavigate = typeof crumb === 'string' ? undefined : crumb.onNavigate
            const isLast = i === breadcrumb.length - 1
            return (
              <span key={i} className="fm-breadcrumb__item">
                {i > 0 && <span className="fm-breadcrumb__sep" aria-hidden="true">›</span>}
                {isLast ? (
                  <span className="fm-breadcrumb__current" aria-current="page">
                    {label}
                  </span>
                ) : onNavigate ? (
                  <button
                    type="button"
                    className="fm-link"
                    onClick={onNavigate}
                    aria-label={`Về trang ${label}`}
                  >
                    {label}
                  </button>
                ) : (
                  <span>{label}</span>
                )}
              </span>
            )
          })}
        </nav>
        <div className="fm-pageheader__title-row">
          <h1 className="fm-pageheader__title">{title}</h1>
          {badge && (
            <span className="fm-live-badge" title={badgeHint}>
              <span className="fm-live-badge__dot" />
              {badge}
            </span>
          )}
        </div>
      </div>
      {actions && <div className="fm-pageheader__actions">{actions}</div>}
    </div>
  )
}
