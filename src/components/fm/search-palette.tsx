'use client'

import { useEffect, useRef, useState } from 'react'
import { Search, ClipboardList, Boxes, Contact, CornerDownLeft, Loader2 } from 'lucide-react'
import { api } from '@/lib/fm-client'

// ---------- Kiểu dữ liệu kết quả tìm kiếm ----------
export interface SearchOrderHit {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  status: string
  grandTotal: number
}
export interface SearchItemHit {
  id: string
  itemCode: string
  itemName: string
  price: number
  uom: string
}
export interface SearchPartnerHit {
  id: string
  cardCode: string
  cardName: string
  groupType: string
}
interface SearchResponse {
  ok: boolean
  orders: SearchOrderHit[]
  items: SearchItemHit[]
  partners: SearchPartnerHit[]
}

type Entry =
  | { kind: 'order'; order: SearchOrderHit }
  | { kind: 'item'; item: SearchItemHit }
  | { kind: 'partner'; partner: SearchPartnerHit }

interface Props {
  open: boolean
  onClose: () => void
  onSelectOrder: (orderId: string) => void
  onSelectItem: (itemCode: string) => void
  onSelectPartner: (cardCode: string) => void
}

function formatVND(n: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(n)) + ' ₫'
}
function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('vi-VN')
}

export default function SearchPalette({ open, onClose, onSelectOrder, onSelectItem, onSelectPartner }: Props) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SearchResponse | null>(null)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Focus input mỗi khi mở palette
  useEffect(() => {
    if (open) {
      setQuery('')
      setResult(null)
      setActiveIdx(0)
      setLoading(false)
      // Đợi modal mount xong mới focus
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open ])

  // Debounce 300ms gọi API tìm kiếm
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) {
      setResult(null)
      setLoading(false)
      setActiveIdx(0)
      return
    }
    setLoading(true)
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await api(`/api/search?q=${encodeURIComponent(q)}`)
        const json: SearchResponse = await res.json().catch(() => ({ ok: false, orders: [], items: [], partners: [] }))
        if (!cancelled) {
          setResult(json.ok ? json : { ok: false, orders: [], items: [], partners: [] })
          setActiveIdx(0)
        }
      } catch {
        if (!cancelled) setResult({ ok: false, orders: [], items: [], partners: [] })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, open])

  // Danh sách phẳng để điều hướng bằng phím ↑↓
  const entries: Entry[] = [
    ...(result?.orders ?? []).map((order): Entry => ({ kind: 'order', order })),
    ...(result?.items ?? []).map((item): Entry => ({ kind: 'item', item })),
    ...(result?.partners ?? []).map((partner): Entry => ({ kind: 'partner', partner })),
  ]

  const choose = (entry: Entry | undefined) => {
    if (!entry) return
    if (entry.kind === 'order') onSelectOrder(entry.order.id)
    else if (entry.kind === 'item') onSelectItem(entry.item.itemCode)
    else onSelectPartner(entry.partner.cardCode)
  }

  // Điều hướng bàn phím: Esc đóng, ↑↓ di chuyển, Enter chọn
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => (entries.length ? (i + 1) % entries.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => (entries.length ? (i - 1 + entries.length) % entries.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(entries[activeIdx])
    }
  }

  // Cuộn mục đang active vào tầm nhìn
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-entry-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  if (!open) return null

  const q = query.trim()
  const hasResults = entries.length > 0
  let lastKind: Entry['kind'] | '' = ''

  return (
    <div className="fm-backdrop" onClick={onClose} role="presentation">
      <div
        className="fm-modal fm-search-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Tìm kiếm toàn văn"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="fm-sp__searchbox">
          <Search size={18} className="fm-sp__searchicon" />
          <input
            ref={inputRef}
            className="fm-sp__input"
            placeholder="Tìm đơn hàng, mặt hàng, khách hàng…"
            aria-label="Từ khóa tìm kiếm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <Loader2 size={16} className="fm-spin fm-sp__loading" />}
          <kbd className="fm-search__kbd">ESC</kbd>
        </div>

        <div ref={listRef} className="fm-sp__list" role="listbox" aria-label="Kết quả tìm kiếm">
          {q.length < 2 && (
            <div className="fm-sp__empty">
              Nhập tối thiểu <b>2 ký tự</b> để tìm kiếm đơn hàng, mặt hàng, khách hàng.
            </div>
          )}
          {q.length >= 2 && loading && !hasResults && (
            <div className="fm-sp__empty">Đang tìm kiếm…</div>
          )}
          {q.length >= 2 && !loading && !hasResults && (
            <div className="fm-sp__empty">
              Không tìm thấy kết quả cho “<b>{q}</b>”.
            </div>
          )}
          {entries.map((entry, idx) => {
            const showGroup = entry.kind !== lastKind
            lastKind = entry.kind
            const isActive = idx === activeIdx
            return (
              <div key={`${entry.kind}-${idx}`}>
                {showGroup && (
                  <div className="fm-sp__group">
                    {entry.kind === 'order' && <><ClipboardList size={13} /> Đơn hàng</>}
                    {entry.kind === 'item' && <><Boxes size={13} /> Mặt hàng</>}
                    {entry.kind === 'partner' && <><Contact size={13} /> Khách hàng</>}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={isActive}
                  data-entry-idx={idx}
                  className={`fm-sp__item${isActive ? ' is-active' : ''}`}
                  onClick={() => choose(entry)}
                  onMouseEnter={() => setActiveIdx(idx)}
                >
                  {entry.kind === 'order' && (
                    <>
                      <span className="fm-sp__icon fm-sp__icon--order"><ClipboardList size={16} /></span>
                      <span className="fm-sp__main">
                        <b>SO #{entry.order.docNum}</b>
                        <small>{entry.order.cardName} ({entry.order.cardCode})</small>
                      </span>
                      <span className="fm-sp__meta">
                        <small>{formatDate(entry.order.docDate)}</small>
                        <b>{formatVND(entry.order.grandTotal)}</b>
                      </span>
                    </>
                  )}
                  {entry.kind === 'item' && (
                    <>
                      <span className="fm-sp__icon fm-sp__icon--item"><Boxes size={16} /></span>
                      <span className="fm-sp__main">
                        <b>{entry.item.itemCode}</b>
                        <small>{entry.item.itemName}</small>
                      </span>
                      <span className="fm-sp__meta">
                        <b>{formatVND(entry.item.price)}</b>
                      </span>
                    </>
                  )}
                  {entry.kind === 'partner' && (
                    <>
                      <span className="fm-sp__icon fm-sp__icon--partner"><Contact size={16} /></span>
                      <span className="fm-sp__main">
                        <b>{entry.partner.cardCode}</b>
                        <small>{entry.partner.cardName}</small>
                      </span>
                      {isActive && <CornerDownLeft size={14} className="fm-sp__enter" />}
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="fm-sp__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> điều hướng</span>
          <span><kbd>Enter</kbd> mở</span>
          <span><kbd>ESC</kbd> đóng</span>
        </div>
      </div>
    </div>
  )
}
