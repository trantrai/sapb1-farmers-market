'use client'

// ============================================================
// "ĐẶT LẠI ĐƠN GẦN NHẤT" — sau khi chọn khách hàng trên form tạo đơn,
// hiện N đơn gần nhất của khách; "Dùng lại" thay toàn bộ dòng hàng,
// "Thêm vào" nối thêm. Form tự tính lại giá/thuế/ATP theo dữ liệu hiện tại.
// ============================================================

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, History, ListPlus, RotateCcw } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { formatDateVN, formatVND } from '@/lib/fm-shared'
import type { ACOption } from './autocomplete'

export interface RecentOrderLine {
  itemCode: string
  itemName: string
  quantity: number
  uom?: string | null
  warehouseCode?: string | null
  available: boolean
  price?: number | null
  taxCode?: string | null
  vatRate?: number | null
  barcode?: string | null
}

export interface RecentOrder {
  id: string
  docNum: number | null
  docDate: string
  grandTotal: number
  status: string
  lines: RecentOrderLine[]
}

/** Dòng của đơn cũ → mặt hàng cho form (giá/thuế theo danh mục HIỆN TẠI) */
export function recentLineToOption(l: RecentOrderLine): ACOption {
  return {
    code: l.itemCode,
    name: l.itemName,
    uom: l.uom ?? '',
    price: typeof l.price === 'number' && l.price > 0 ? l.price : undefined,
    taxCode: l.taxCode ?? '',
    vatRate: typeof l.vatRate === 'number' ? l.vatRate : undefined,
    barcode: l.barcode ?? '',
  }
}

export default function RecentOrdersPanel({ cardCode, disabled, onUse }: {
  cardCode: string | null | undefined
  disabled?: boolean
  onUse: (order: RecentOrder, mode: 'replace' | 'append') => void
}) {
  const code = cardCode?.trim() || ''
  const [loaded, setLoaded] = useState<{ code: string; rows: RecentOrder[] } | null>(null)
  const [open, setOpen] = useState(true)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    api(`/api/orders/recent?cardCode=${encodeURIComponent(code)}&limit=3`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setLoaded({ code, rows: Array.isArray(j?.data) ? j.data : [] }) })
      .catch(() => { if (!cancelled) setLoaded({ code, rows: [] }) })
    return () => { cancelled = true }
  }, [code])

  const rows = loaded?.code === code ? loaded.rows : []
  if (!code || rows.length === 0) return null

  return (
    <section className="fm-recent" aria-labelledby="fm-recent-title">
      <button
        type="button"
        className="fm-collapse-toggle"
        aria-expanded={open}
        aria-controls="fm-recent-list"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <History size={14} aria-hidden />
        <span id="fm-recent-title">Đặt lại đơn gần nhất của khách hàng ({rows.length})</span>
      </button>
      {open && (
        <div className="fm-recent__list" id="fm-recent-list">
          {rows.map((o) => {
            const avail = o.lines.filter((l) => l.available).length
            const preview = o.lines.slice(0, 3).map((l) => `${l.itemName} ×${l.quantity}`).join(', ')
            return (
              <article key={o.id} className="fm-recent__card">
                <div className="fm-recent__head">
                  <b>#{o.docNum ?? '—'}</b>
                  <span>{formatDateVN(o.docDate)}</span>
                  <span className="fm-recent__total">{formatVND(o.grandTotal)}</span>
                </div>
                <div className="fm-recent__items" title={o.lines.map((l) => `${l.itemCode} — ${l.itemName} ×${l.quantity}`).join('\n')}>
                  {o.lines.length} mặt hàng: {preview}{o.lines.length > 3 ? '…' : ''}
                </div>
                {avail < o.lines.length && (
                  <div className="fm-recent__warn">{o.lines.length - avail} mặt hàng không còn trong danh mục bán — sẽ bỏ qua</div>
                )}
                <div className="fm-recent__actions">
                  <button
                    type="button"
                    className="fm-btn fm-btn--primary fm-btn--sm"
                    onClick={() => onUse(o, 'replace')}
                    disabled={disabled || avail === 0}
                    aria-label={`Dùng lại đơn #${o.docNum ?? ''} (thay các dòng hiện tại)`}
                  >
                    <RotateCcw size={14} aria-hidden /> Dùng lại
                  </button>
                  <button
                    type="button"
                    className="fm-btn fm-btn--secondary fm-btn--sm"
                    onClick={() => onUse(o, 'append')}
                    disabled={disabled || avail === 0}
                    aria-label={`Thêm vào: các dòng của đơn #${o.docNum ?? ''} nối vào đơn đang lập`}
                  >
                    <ListPlus size={14} aria-hidden /> Thêm vào
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
      <p className="fm-hint fm-mt-1">Giá, thuế và tồn kho được tính lại theo dữ liệu hiện tại; mặt hàng BOM bung theo công thức hiện hành.</p>
    </section>
  )
}
