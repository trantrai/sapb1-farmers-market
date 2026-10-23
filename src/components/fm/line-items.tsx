'use client'

// ============================================================
// DÒNG HÀNG CHỨNG TỪ — khối dùng chung cho form Đơn hàng, Giao hàng và form
// chứng từ bán hàng (báo giá, hóa đơn, ghi có, trả hàng, đặt cọc):
//  - Bảng gọn: chỉ cột hay sửa (Hàng hóa, SL, Đơn giá, CK, Thành tiền)
//  - LineExpandButton + LineDetailRow: trường ít dùng (ĐVT, Kho, Thuế, Lô…)
//    mở theo từng dòng
//  - LineQuickAdd: thêm dòng kiểu SAP — tìm mặt hàng + SL → Enter → dòng được
//    thêm, con trỏ quay lại ô tìm để nhập tiếp
// ============================================================

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import Autocomplete, { type ACOption } from './autocomplete'

/** Trạng thái mở rộng chi tiết theo key dòng */
export function useExpandedLines() {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set())
  return {
    isOpen: (key: number) => open.has(key),
    toggle: (key: number) =>
      setOpen((cur) => {
        const next = new Set(cur)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    /** Mở sẵn chi tiết (vd dòng mới cần nhập trường bắt buộc) */
    openLine: (key: number) => setOpen((cur) => (cur.has(key) ? cur : new Set(cur).add(key))),
  }
}

/** Nút ▸/▾ mở chi tiết dòng (đặt ở ô # cùng số thứ tự) */
export function LineExpandButton({ expanded, onToggle, lineNo, controls, hasIssue, hideNo }: {
  expanded: boolean
  onToggle: () => void
  lineNo: number
  /** Dòng thành phần BOM: không hiện số thứ tự (dùng số của dòng cha) */
  hideNo?: boolean
  /** id của LineDetailRow (aria-controls) */
  controls: string
  /** Chi tiết có trường cần chú ý (vd thiếu thông tin) → chấm báo */
  hasIssue?: boolean
}) {
  return (
    <button
      type="button"
      className={`fm-line-expand${hasIssue ? ' has-issue' : ''}`}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-label={`${expanded ? 'Ẩn' : 'Xem'} chi tiết dòng ${lineNo}${hideNo ? ' (thành phần BOM)' : ''}`}
      title={expanded ? 'Ẩn chi tiết dòng' : 'Chi tiết dòng: đơn vị tính, kho, thuế…'}
      onClick={onToggle}
    >
      {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      {!hideNo && <span className="fm-line-expand__no">{lineNo}</span>}
    </button>
  )
}

/** Hàng chi tiết của 1 dòng — hiện ngay dưới dòng chính, trải hết bề ngang bảng */
export function LineDetailRow({ id, colSpan, children, className }: {
  id: string
  colSpan: number
  children: ReactNode
  className?: string
}) {
  return (
    <tr className={`fm-line-detail${className ? ` ${className}` : ''}`} id={id}>
      <td colSpan={colSpan}>
        <div className="fm-line-detail__grid">{children}</div>
      </td>
    </tr>
  )
}

/** 1 trường trong LineDetailRow (nhãn luôn hiển thị) */
export function LineDetailField({ label, htmlFor, title, children }: {
  label: string
  htmlFor?: string
  title?: string
  children: ReactNode
}) {
  return (
    <div className="fm-line-detail__field">
      {htmlFor ? (
        <label className="fm-line-detail__label" htmlFor={htmlFor} title={title}>{label}</label>
      ) : (
        <span className="fm-line-detail__label" title={title}>{label}</span>
      )}
      {children}
    </div>
  )
}

/**
 * Ô thêm dòng nhanh dưới bảng: chọn mặt hàng (Enter / click) → gọi onAdd(item, qty)
 * → xóa ô tìm và đặt con trỏ lại để nhập dòng tiếp theo.
 */
export function LineQuickAdd({ onAdd, disabled, hint }: {
  onAdd: (item: ACOption, quantity: number) => void
  disabled?: boolean
  hint?: string
}) {
  const [qty, setQty] = useState(1)
  // Đổi key → Autocomplete mount lại với ô tìm trống sau mỗi lần thêm
  const [resetKey, setResetKey] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (resetKey === 0) return
    boxRef.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus()
  }, [resetKey])

  return (
    <div className="fm-line-add" ref={boxRef}>
      <span className="fm-line-add__icon" aria-hidden><Plus size={16} /></span>
      <div className="fm-line-add__item">
        <Autocomplete
          key={resetKey}
          label="Thêm mặt hàng"
          hideLabel
          placeholder="Thêm dòng: gõ mã hoặc tên mặt hàng (tối thiểu 2 ký tự)…"
          fetchUrl="/api/items"
          minChars={2}
          minCharsHint="Nhập tối thiểu 2 ký tự để tìm mặt hàng (chỉ MẶT HÀNG BÁN ĐƯỢC)…"
          value={null}
          disabled={disabled}
          onChange={(v) => {
            if (!v) return
            onAdd(v, qty > 0 ? qty : 1)
            setQty(1)
            setResetKey((k) => k + 1)
          }}
        />
      </div>
      <label className="fm-line-add__qty">
        <span>SL</span>
        <input
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          className="fm-line-input"
          value={qty || ''}
          disabled={disabled}
          aria-label="Số lượng dòng thêm mới"
          onChange={(e) => setQty(Number(e.target.value) || 0)}
        />
      </label>
      <span className="fm-line-add__hint">{hint ?? 'Chọn mặt hàng (↑↓ + Enter) để thêm dòng'}</span>
    </div>
  )
}
