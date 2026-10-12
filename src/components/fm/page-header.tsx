'use client'

import type { ReactNode } from 'react'
import { Home } from 'lucide-react'

interface PageHeaderProps {
  breadcrumb: string[]
  title: string
  badge?: string
  actions?: ReactNode
}

/**
 * Page header theo thiết kế Stitch: breadcrumb + H1 + badge "Cập nhật tức thời" + nút action
 */
export default function PageHeader({ breadcrumb, title, badge, actions }: PageHeaderProps) {
  return (
    <div className="fm-pageheader">
      <div>
        <nav className="fm-breadcrumb" aria-label="Breadcrumb">
          <Home size={14} className="fm-breadcrumb__icon" />
          {breadcrumb.map((crumb, i) => (
            <span key={i} className="fm-breadcrumb__item">
              {i > 0 && <span className="fm-breadcrumb__sep">›</span>}
              <span
                className={i === breadcrumb.length - 1 ? 'fm-breadcrumb__current' : ''}
                aria-current={i === breadcrumb.length - 1 ? 'page' : undefined}
              >
                {crumb}
              </span>
            </span>
          ))}
        </nav>
        <div className="fm-pageheader__title-row">
          <h1 className="fm-pageheader__title">{title}</h1>
          {badge && (
            <span className="fm-live-badge">
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
