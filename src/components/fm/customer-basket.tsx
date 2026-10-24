'use client'

// ============================================================
// "GIỎ HÀNG QUEN" — lưới mặt hàng khách hay mua (theo lịch sử đơn):
// gõ SL cho nhiều mặt hàng (Enter → dòng dưới), hoặc điền nhanh SL lần
// trước / SL trung bình → "Thêm N mặt hàng" vào đơn 1 lượt. Form tự tính
// lại giá/thuế/ATP theo dữ liệu hiện tại và bung BOM theo công thức hiện hành.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Eraser, ListPlus, ShoppingBag } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { formatDateVN, formatVND } from '@/lib/fm-shared'
import type { BasketAgg } from '@/lib/order-basket'
import { recentLineToOption } from './recent-orders'
import type { ACOption } from './autocomplete'

export interface BasketItem extends Omit<BasketAgg, 'uom' | 'taxCode'> {
  uom?: string | null
  taxCode?: string | null
  available: boolean
  price?: number | null
  vatRate?: number | null
  barcode?: string | null
}

export interface BasketEntry { item: ACOption; quantity: number; warehouseCode?: string | null }

const fmtQty = (n: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(n)
const parseQty = (v: string) => {
  const n = Number(v.trim().replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export default function CustomerBasket({ cardCode, disabled, inOrder, onAdd }: {
  cardCode: string | null | undefined
  disabled?: boolean
  /** Mã mặt hàng đã có trong đơn — đánh dấu để tránh thêm trùng */
  inOrder: Set<string>
  onAdd: (entries: BasketEntry[]) => void
}) {
  const code = cardCode?.trim() || ''
  const [loaded, setLoaded] = useState<{ code: string; rows: BasketItem[]; days: number } | null>(null)
  const [qty, setQty] = useState<{ code: string; map: Record<string, string> }>({ code: '', map: {} })
  const [open, setOpen] = useState(true)
  const addRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    api(`/api/orders/suggest-items?cardCode=${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setLoaded({ code, rows: Array.isArray(j?.data) ? j.data : [], days: Number(j?.historyDays) || 90 }) })
      .catch(() => { if (!cancelled) setLoaded({ code, rows: [], days: 90 }) })
    return () => { cancelled = true }
  }, [code])

  const rows = loaded?.code === code ? loaded.rows : []
  // SL đã gõ gắn với khách hàng — đổi khách thì bắt đầu lại
  const qtyMap = qty.code === code ? qty.map : {}
  if (!code || rows.length === 0) return null

  const setOne = (itemCode: string, v: string) => setQty({ code, map: { ...qtyMap, [itemCode]: v } })
  const fillAll = (pick: (r: BasketItem) => number) =>
    setQty({ code, map: Object.fromEntries(rows.filter((r) => r.available).map((r) => [r.itemCode, String(pick(r))])) })
  const picked = rows.filter((r) => r.available && parseQty(qtyMap[r.itemCode] ?? '') > 0)

  const submit = () => {
    if (picked.length === 0) return
    onAdd(picked.map((r) => ({
      item: recentLineToOption({ ...r, quantity: 0 }),
      quantity: parseQty(qtyMap[r.itemCode]),
      warehouseCode: r.warehouseCode,
    })))
    setQty({ code, map: {} })
  }

  /** Enter → ô SL dòng dưới; dòng cuối → nút Thêm */
  const onQtyKey = (e: React.KeyboardEvent<HTMLInputElement>, idx: number) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    const inputs = [...(e.currentTarget.closest('tbody')?.querySelectorAll<HTMLInputElement>('input:not([disabled])') ?? [])]
    const next = inputs[inputs.indexOf(e.currentTarget) + (e.shiftKey ? -1 : 1)]
    if (next) { next.focus(); next.select() } else if (!e.shiftKey && idx >= 0) addRef.current?.focus()
  }

  return (
    <section className="fm-basket" aria-labelledby="fm-basket-title">
      <button
        type="button"
        className="fm-collapse-toggle"
        aria-expanded={open}
        aria-controls="fm-basket-body"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <ShoppingBag size={14} aria-hidden />
        <span id="fm-basket-title">Giỏ hàng quen của khách ({rows.length} mặt hàng · {loaded?.days ?? 90} ngày gần nhất)</span>
      </button>
      {open && (
        <div id="fm-basket-body">
          <div className="fm-basket__tools">
            <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => fillAll((r) => r.lastQty)} disabled={disabled}>
              Điền SL lần trước
            </button>
            <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => fillAll((r) => r.avgQty)} disabled={disabled}>
              Điền SL trung bình
            </button>
            <button
              type="button"
              className="fm-btn fm-btn--ghost fm-btn--sm"
              onClick={() => setQty({ code, map: {} })}
              disabled={disabled || Object.keys(qtyMap).length === 0}
            >
              <Eraser size={14} aria-hidden /> Xóa SL
            </button>
          </div>
          <div className="fm-basket__wrap fm-scroll">
            <table className="fm-table fm-stack-table fm-basket__table">
              <thead>
                <tr>
                  <th>Mặt hàng</th>
                  <th className="fm-num">Đã mua</th>
                  <th className="fm-num">SL lần trước</th>
                  <th className="fm-num">SL TB/đơn</th>
                  <th className="fm-num">Giá hiện tại</th>
                  <th className="fm-num fm-basket__col-qty">Đặt lần này</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={r.itemCode} className={!r.available ? 'is-unavailable' : undefined}>
                    <td data-label="Mặt hàng" data-full>
                      <div className="fm-basket__name">
                        <b>{r.itemCode}</b> — {r.itemName}
                        {inOrder.has(r.itemCode) && <span className="fm-chip fm-chip--role fm-basket__in">đã có trong đơn</span>}
                      </div>
                      <div className="fm-basket__sub">
                        {r.available ? <>Lần cuối {formatDateVN(r.lastDate)}{r.uom ? ` · ${r.uom}` : ''}</> : 'Không còn trong danh mục bán'}
                      </div>
                    </td>
                    <td data-label="Đã mua" className="fm-num">{r.orderCount} đơn</td>
                    <td data-label="SL lần trước" className="fm-num">{fmtQty(r.lastQty)}</td>
                    <td data-label="SL TB/đơn" className="fm-num">{fmtQty(r.avgQty)}</td>
                    <td data-label="Giá hiện tại" className="fm-num">
                      {typeof r.price === 'number' && r.price > 0 ? formatVND(r.price) : '—'}
                    </td>
                    <td data-label="Đặt lần này" className="fm-num">
                      <input
                        type="text"
                        inputMode="decimal"
                        className="fm-line-input fm-basket__qty"
                        placeholder={r.available ? fmtQty(r.lastQty) : ''}
                        value={qtyMap[r.itemCode] ?? ''}
                        onChange={(e) => setOne(r.itemCode, e.target.value)}
                        onKeyDown={(e) => onQtyKey(e, idx)}
                        disabled={disabled || !r.available}
                        aria-label={`Số lượng đặt ${r.itemCode} — ${r.itemName}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fm-basket__foot">
            <span className="fm-hint">Giá, thuế, tồn kho tính lại theo dữ liệu hiện tại khi thêm vào đơn.</span>
            <button ref={addRef} type="button" className="fm-btn fm-btn--primary fm-btn--sm" onClick={submit} disabled={disabled || picked.length === 0}>
              <ListPlus size={14} aria-hidden /> Thêm {picked.length} mặt hàng vào đơn
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
