'use client'

// ============================================================
// NHÓM NÚT "SAO CHÉP SANG …" — dùng chung cho mọi màn chi tiết chứng từ.
// ≥2 đích → 1 nút "Sao chép sang ▾" mở menu (↑↓ di chuyển, Esc/click ngoài đóng);
// 1 đích → nút thường (khỏi bấm 2 lần); 0 đích → không hiện.
// ============================================================

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Copy, FileMinus, HandCoins, Receipt, ShoppingCart, Truck, Undo2 } from 'lucide-react'

export interface CopyToItem {
  key: string
  /** Tên chứng từ đích, viết hoa chữ đầu — vd "Phiếu giao hàng" */
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  /** Lý do / mô tả (tooltip) — vd "Đơn đã giao hết" */
  hint?: string
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** "Sao chép sang phiếu ghi có phải thu" → "Phiếu ghi có phải thu" (nhãn mục trong menu) */
export function copyTargetName(label: string): string {
  const s = label.replace(/^Sao chép sang\s+/i, '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Icon theo loại chứng từ đích (CopyTarget) */
export function copyTargetIcon(target: string): ReactNode {
  const p = { size: 16 }
  switch (target) {
    case 'order': return <ShoppingCart {...p} />
    case 'delivery': return <Truck {...p} />
    case 'invoice': return <Receipt {...p} />
    case 'downPayment': return <HandCoins {...p} />
    case 'creditMemo': return <FileMinus {...p} />
    case 'return': return <Undo2 {...p} />
    default: return <Copy {...p} />
  }
}

export default function CopyToMenu({ items, disabled }: { items: CopyToItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus()
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  if (items.length === 0) return null

  if (items.length === 1) {
    const it = items[0]
    return (
      <button type="button" className="fm-btn fm-btn--secondary" onClick={it.onSelect} disabled={disabled || it.disabled} title={it.hint}>
        {it.icon ?? <Copy size={16} aria-hidden />} Sao chép sang {lowerFirst(it.label)}
      </button>
    )
  }

  const close = (focusBtn = true) => {
    setOpen(false)
    if (focusBtn) btnRef.current?.focus()
  }

  const onKey = (e: React.KeyboardEvent) => {
    const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [])]
    if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'Tab') close(false)
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') && els.length) {
      e.preventDefault()
      const i = els.indexOf(document.activeElement as HTMLElement)
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % els.length : (i - 1 + els.length) % els.length
      els[next].focus()
    }
  }

  return (
    <div className="fm-menu" ref={wrapRef} onKeyDown={open ? onKey : undefined}>
      <button
        ref={btnRef}
        type="button"
        className="fm-btn fm-btn--secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) } }}
        disabled={disabled}
      >
        <Copy size={16} aria-hidden /> Sao chép sang <ChevronDown size={14} aria-hidden className={open ? 'fm-menu__caret is-open' : 'fm-menu__caret'} />
      </button>
      {open && (
        <div ref={listRef} className="fm-menu__list" role="menu" aria-label="Sao chép sang chứng từ">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className="fm-menu__item"
              aria-disabled={it.disabled || undefined}
              title={it.hint}
              onClick={() => {
                if (it.disabled) return
                close(false)
                it.onSelect()
              }}
            >
              {it.icon && <span className="fm-menu__icon" aria-hidden>{it.icon}</span>}
              <span className="fm-menu__text">
                {it.label}
                {it.disabled && it.hint && <small>{it.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
