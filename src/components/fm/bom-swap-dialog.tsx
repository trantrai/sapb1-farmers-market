'use client'

// ============================================================
// HOÁN ĐỔI THÀNH PHẦN BOM TEMPLATE
// Popup danh sách mặt hàng: lọc theo mã hàng / tên hàng / barcode → chọn 1
// mặt hàng → "Xác nhận" → form thay mã thành phần cũ bằng mã mới và nạp lại
// thông tin liên quan (tên, ĐVT, mã thuế, thuế suất, barcode). SL, định mức,
// giá 0 và U_BOMID (mã cha) của dòng con giữ nguyên.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, X } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { useFocusTrap } from './use-focus-trap'
import type { ACOption } from './autocomplete'

interface Props {
  open: boolean
  /** Thành phần đang được hoán đổi */
  component: { code: string; name: string } | null
  /** Mã mặt hàng cha BOM — không cho chọn chính nó làm thành phần */
  parentCode?: string
  onConfirm: (item: ACOption) => void
  onCancel: () => void
}

interface ItemRow {
  itemCode: string
  itemName: string
  uom?: string | null
  price?: number | null
  taxCode?: string | null
  vatRate?: number | null
  barcode?: string | null
}

const toOption = (r: ItemRow): ACOption => ({
  code: r.itemCode,
  name: r.itemName || r.itemCode,
  uom: r.uom ?? '',
  taxCode: r.taxCode ?? '',
  vatRate: typeof r.vatRate === 'number' ? r.vatRate : undefined,
  barcode: r.barcode ?? '',
  price: typeof r.price === 'number' && r.price > 0 ? r.price : undefined,
})

export default function BomSwapDialog({ open, component, parentCode, onConfirm, onCancel }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(open, onCancel)
  const inputRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  const [result, setResult] = useState<{ q: string; rows: ItemRow[]; error: string } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Tìm trực tiếp (debounce 300ms, tối thiểu 2 ký tự) — API khớp mã hàng, tên hàng, barcode
  const qq = q.trim()
  useEffect(() => {
    if (!open || qq.length < 2) return
    let cancelled = false
    const timer = setTimeout(() => {
      api(`/api/items?q=${encodeURIComponent(qq)}`)
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return
          const rows = (Array.isArray(j?.data) ? j.data : []) as ItemRow[]
          setResult({ q: qq, rows, error: typeof j?.error === 'string' ? j.error : '' })
        })
        .catch(() => { if (!cancelled) setResult({ q: qq, rows: [], error: 'Không kết nối được máy chủ' }) })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [qq, open])

  if (!open || !component) return null

  const loading = qq.length >= 2 && result?.q !== qq
  const rows = qq.length >= 2 && result?.q === qq
    ? result.rows.filter((r) => r.itemCode !== component.code && r.itemCode !== parentCode)
    : []
  const selIdx = rows.findIndex((r) => r.itemCode === selected)
  const pickedRow = selIdx >= 0 ? rows[selIdx] : null
  const confirm = () => { if (pickedRow) onConfirm(toOption(pickedRow)) }

  return (
    <div className="fm-backdrop" onClick={onCancel}>
      <div
        ref={trapRef}
        className="fm-modal fm-bom-swap"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fm-bom-swap-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fm-bom-swap__head">
          <h3 id="fm-bom-swap-title" className="fm-modal__title">
            <ArrowLeftRight size={18} aria-hidden /> Hoán đổi thành phần BOM
          </h3>
          <button type="button" className="fm-icon-btn" aria-label="Đóng" onClick={onCancel}><X size={16} /></button>
        </div>
        <p className="fm-bom-swap__current">
          Thành phần hiện tại: <b>{component.code}</b> — {component.name}
          {parentCode ? <> · BOM: <b>{parentCode}</b></> : null}
        </p>
        <label className="fm-label" htmlFor="fm-bom-swap-q">Tìm mặt hàng thay thế</label>
        <input
          id="fm-bom-swap-q"
          ref={inputRef}
          className="fm-input"
          placeholder="Lọc theo mã hàng, tên hàng hoặc barcode (tối thiểu 2 ký tự)…"
          value={q}
          autoComplete="off"
          onChange={(e) => { setQ(e.target.value); setSelected(null) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && rows.length) { e.preventDefault(); setSelected(rows[Math.min(selIdx + 1, rows.length - 1)].itemCode) }
            else if (e.key === 'ArrowUp' && rows.length) { e.preventDefault(); setSelected(rows[Math.max(selIdx - 1, 0)].itemCode) }
            else if (e.key === 'Enter' && pickedRow) { e.preventDefault(); confirm() }
          }}
          aria-controls="fm-bom-swap-list"
        />
        <div className="fm-bom-swap__list fm-scroll" id="fm-bom-swap-list" role="radiogroup" aria-label="Danh sách mặt hàng">
          {qq.length < 2 ? (
            <div className="fm-hint">Nhập tối thiểu 2 ký tự để tìm mặt hàng.</div>
          ) : loading ? (
            <div className="fm-hint" role="status">Đang tìm…</div>
          ) : result?.error ? (
            <div className="fm-error-text" role="alert">{result.error}</div>
          ) : rows.length === 0 ? (
            <div className="fm-hint">Không có mặt hàng nào khớp “{qq}”.</div>
          ) : (
            <table className="fm-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><span className="fm-sr-only">Chọn</span></th>
                  <th>Mã hàng</th>
                  <th>Tên hàng</th>
                  <th>Barcode</th>
                  <th>ĐVT</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const on = r.itemCode === selected
                  return (
                    <tr
                      key={r.itemCode}
                      className={on ? 'is-selected' : undefined}
                      onClick={() => setSelected(r.itemCode)}
                      onDoubleClick={() => onConfirm(toOption(r))}
                    >
                      <td>
                        <input
                          type="radio"
                          name="fm-bom-swap-item"
                          checked={on}
                          onChange={() => setSelected(r.itemCode)}
                          aria-label={`Chọn ${r.itemCode} — ${r.itemName}`}
                        />
                      </td>
                      <td><b>{r.itemCode}</b></td>
                      <td>{r.itemName}</td>
                      <td className="fm-bom-swap__barcode">{r.barcode || '—'}</td>
                      <td>{r.uom || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="fm-bom-swap__foot">
          <span className="fm-hint">
            {pickedRow ? <>Đổi <b>{component.code}</b> → <b>{pickedRow.itemCode}</b> (giữ SL, định mức, giá 0)</> : 'Chọn 1 mặt hàng trong danh sách'}
          </span>
          <button type="button" className="fm-btn fm-btn--secondary" onClick={onCancel}>Hủy bỏ</button>
          <button type="button" className="fm-btn fm-btn--primary" onClick={confirm} disabled={!pickedRow}>Xác nhận</button>
        </div>
      </div>
    </div>
  )
}
