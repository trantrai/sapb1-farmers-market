'use client'

// ============================================================
// PHÍM TẮT FORM CHỨNG TỪ (đơn hàng, giao hàng, báo giá/hóa đơn/ghi có/
// trả hàng/đặt cọc) — nhập đơn không cần chuột:
//   Alt+N            → ô thêm dòng          Alt+K → ô khách hàng
//   Ctrl+Enter       → Lưu chứng từ         Ctrl+Shift+Enter → Lưu nháp
//   Enter/Shift+Enter trong ô SL/giá/CK → ô cùng cột dòng dưới/trên
//   Ctrl+Delete      → xóa dòng đang đứng   ?  → bảng phím tắt
// ============================================================

import { useEffect, useEffectEvent, useState } from 'react'
import { Keyboard, X } from 'lucide-react'
import { useFocusTrap } from './use-focus-trap'

const isTyping = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)

/** Đang mở hộp thoại khác (popup BOM, dán danh sách, xác nhận…) → không bắt phím tắt form */
const dialogOpen = () => !!document.querySelector('[aria-modal="true"]')

function focusAddLine() {
  const el = document.querySelector<HTMLInputElement>('.fm-page .fm-line-add input[role="combobox"]')
  el?.focus()
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function focusCustomer() {
  // Ô khách hàng = combobox đầu tiên của form (trước bảng dòng hàng)
  const el = [...document.querySelectorAll<HTMLInputElement>('.fm-page input[role="combobox"]')]
    .find((i) => !i.closest('.fm-line-table') && !i.closest('.fm-line-add') && !i.disabled)
  el?.focus()
  el?.select()
}

/** Enter/Shift+Enter trong ô nhập của bảng dòng hàng → ô cùng cột dòng dưới/trên */
function moveInLineTable(input: HTMLInputElement, dir: 1 | -1): boolean {
  const td = input.closest('td')
  const tr = input.closest('tr')
  const tbody = tr?.parentElement
  if (!td || !tr || !tbody) return false
  const label = td.getAttribute('data-label')
  const rows = [...tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr:not(.fm-line-detail)')]
  for (let i = rows.indexOf(tr) + dir; i >= 0 && i < rows.length; i += dir) {
    const target = rows[i].querySelector<HTMLInputElement>(`td[data-label="${label}"] input:not([disabled])`)
    if (target) { target.focus(); target.select(); return true }
  }
  if (dir === 1) { focusAddLine(); return true }
  return false
}

export function useFormShortcuts({ onSave, onSaveDraft, disabled }: {
  onSave: () => void
  onSaveDraft?: () => void
  disabled?: boolean
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || dialogOpen()) return
    const t = e.target as HTMLElement | null
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (disabled) return
      if (e.shiftKey) onSaveDraft?.()
      else onSave()
      return
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'n' || e.code === 'KeyN') { e.preventDefault(); focusAddLine(); return }
      if (k === 'k' || e.code === 'KeyK') { e.preventDefault(); focusCustomer(); return }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Delete' && t?.closest('.fm-line-table tbody tr')) {
      const del = t.closest('tr')?.querySelector<HTMLButtonElement>('.fm-row-del:not(:disabled)')
      if (del) { e.preventDefault(); del.click(); focusAddLine() }
      return
    }
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && t instanceof HTMLInputElement
      && t.classList.contains('fm-line-input') && t.closest('.fm-line-table tbody')) {
      if (moveInLineTable(t, e.shiftKey ? -1 : 1)) e.preventDefault()
      return
    }
    if (e.key === '?' && !isTyping(t)) { e.preventDefault(); setHelpOpen(true) }
  })
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  return { helpOpen, openHelp: () => setHelpOpen(true), closeHelp: () => setHelpOpen(false) }
}

const SHORTCUTS: [string, string][] = [
  ['Alt + N', 'Tới ô thêm dòng hàng (tìm mã / tên / quét barcode)'],
  ['Alt + K', 'Tới ô khách hàng'],
  ['Ctrl + Enter', 'Lưu chứng từ'],
  ['Ctrl + Shift + Enter', 'Lưu nháp (khi tạo mới)'],
  ['Enter / Shift + Enter', 'Trong ô SL, đơn giá, CK: sang ô cùng cột dòng dưới / dòng trên'],
  ['Ctrl + Delete', 'Xóa dòng hàng đang đứng'],
  ['Ctrl + V', 'Dán danh sách nhiều dòng vào ô thêm dòng'],
  ['↑ ↓ + Enter', 'Chọn mặt hàng trong danh sách gợi ý'],
  ['?', 'Mở bảng phím tắt này'],
]

/** Nút nhỏ "Phím tắt" + bảng phím tắt (Esc để đóng) */
export function ShortcutHelp({ open, onOpen, onClose }: { open: boolean; onOpen: () => void; onClose: () => void }) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose)
  return (
    <>
      <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={onOpen} title="Phím tắt nhập liệu (?)">
        <Keyboard size={14} aria-hidden /> Phím tắt
      </button>
      {open && (
        <div className="fm-backdrop" onClick={onClose}>
          <div
            ref={trapRef}
            className="fm-modal fm-shortcuts"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fm-shortcuts-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fm-bom-swap__head">
              <h3 id="fm-shortcuts-title" className="fm-modal__title"><Keyboard size={18} aria-hidden /> Phím tắt nhập liệu</h3>
              <button type="button" className="fm-icon-btn" aria-label="Đóng" onClick={onClose} autoFocus><X size={16} /></button>
            </div>
            <dl className="fm-shortcuts__list">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} className="fm-shortcuts__row">
                  <dt>{k.split(' + ').map((p, i) => <span key={i}>{i > 0 && ' + '}<kbd>{p}</kbd></span>)}</dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </>
  )
}
