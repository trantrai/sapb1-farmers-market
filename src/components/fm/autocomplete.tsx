'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { api } from '@/lib/fm-client'

export interface ACOption {
  code: string
  name: string
  /** text bên phải: SĐT (khách hàng) hoặc đơn giá (mặt hàng) */
  extra?: string
  /** dòng thông tin phụ bên dưới: địa chỉ / Đơn vị · Mã thuế · Barcode */
  sub?: string
  /** mặt hàng: đơn giá Price List 1, đơn vị, mã thuế, thuế suất, barcode */
  price?: number
  uom?: string
  taxCode?: string
  vatRate?: number
  barcode?: string
}

interface Props {
  label: string
  required?: boolean
  placeholder?: string
  fetchUrl: string
  value: ACOption | null
  onChange: (v: ACOption | null) => void
  error?: string
  /** Chế độ TÌM TRỰC TIẾP: chỉ gọi API khi người dùng nhập tối thiểu N ký tự
   * (mặc định không đặt = tải toàn bộ danh sách 1 lần khi mở dropdown). */
  minChars?: number
  /** Nhãn gợi ý khi chưa nhập đủ ký tự (chế độ minChars) */
  minCharsHint?: string
}

// ============================================================
// TẢI TOÀN BỘ DỮ LIỆU 1 LẦN khi mở dropdown, sau đó lọc ngay trên
// máy khách theo từng phím (không gọi API lại) → danh sách đầy đủ
// và phản hồi tức thì. Cache dùng chung 60s theo fetchUrl nên
// nhiều dòng hàng hóa cũng chỉ tải 1 lần.
// Panel dùng position:fixed để KHÔNG bị lưới/overflow che mất.
// ============================================================
interface CacheEntry {
  ts: number
  options: ACOption[]
  source: string
  error: string
}
const listCache = new Map<string, CacheEntry>()
const CACHE_TTL = 60_000
/** Giới hạn số dòng render để không treo DOM với danh mục rất lớn (dữ liệu vẫn tải đầy đủ) */
const MAX_RENDER = 500

/** Chuẩn hóa để tìm kiếm không phân biệt hoa/thường + dấu tiếng Việt (vd "rau muong" khớp "Rau Muống") */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')

const fmtVND = (n: number) => new Intl.NumberFormat('vi-VN').format(n)

/** Map response /api/partners | /api/items → danh sách option của autocomplete */
function mapResponse(json: { data?: Record<string, string | number>[]; source?: string; error?: string }): { options: ACOption[]; source: string; error: string } {
  const found: ACOption[] = (json.data ?? []).map((d) => {
    const isItem = 'itemCode' in d
    const price = typeof d.price === 'number' ? d.price : 0
    const vat = typeof d.vatRate === 'number' ? d.vatRate : undefined
    const sub = isItem
      ? [
          d.uom ? `Đơn vị: ${d.uom}` : '',
          d.taxCode ? `Mã thuế: ${d.taxCode}${vat !== undefined ? ` (${vat}%)` : ''}` : '',
          d.barcode ? `Barcode: ${d.barcode}` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : (d.address as string) ?? ''
    return {
      code: String(d.cardCode ?? d.itemCode ?? ''),
      name: String(d.cardName ?? d.itemName ?? ''),
      extra: isItem ? (price > 0 ? `${fmtVND(price)} ₫` : '') : ((d.phone as string) ?? ''),
      sub: sub || undefined,
      price: isItem && price > 0 ? price : undefined,
      uom: isItem ? ((d.uom as string) ?? '') : undefined,
      taxCode: isItem ? ((d.taxCode as string) ?? '') : undefined,
      vatRate: vat,
      barcode: isItem ? ((d.barcode as string) ?? '') : undefined,
    }
  })
  return { options: found, source: json.source ?? '', error: json.error ?? '' }
}

/** Autocomplete chọn CardCode / ItemCode (Bước 1 & 2 của form SO) */
export default function Autocomplete({ label, required, placeholder, fetchUrl, value, onChange, error, minChars, minCharsHint }: Props) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState<ACOption[] | null>(null) // toàn bộ danh sách đã tải (hoặc kết quả tìm trực tiếp)
  const [meta, setMeta] = useState<{ source: string; error: string }>({ source: '', error: '' })
  const [open, setOpen] = useState(false)
  const [hl, setHl] = useState(0)
  const [loading, setLoading] = useState(false)
  const [rect, setRect] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // Đặt vị trí panel (fixed) ngay dưới ô nhập — lật lên nếu chạm đáy màn hình
  const place = () => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.min(Math.max(r.width, 380), window.innerWidth - 16)
    const left = Math.min(r.left, Math.max(8, window.innerWidth - width - 8))
    const flip = window.innerHeight - r.bottom < 250 && r.top > 280
    setRect(
      flip
        ? { bottom: window.innerHeight - r.top + 4, left, width }
        : { top: r.bottom + 4, left, width },
    )
  }

  // MỞ DROPDOWN → tải TOÀN BỘ danh sách (cache 60s), không truyền q.
  // Chỉ chạy ở chế độ tải-toàn-bộ (không đặt minChars).
  useEffect(() => {
    if (!open || minChars !== undefined) return
    let cancelled = false

    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)

    const hit = listCache.get(fetchUrl)
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      setAll(hit.options)
      setMeta({ source: hit.source, error: hit.error })
      setLoading(false)
      return () => {
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', place, true)
      }
    }
    setLoading(true)
    api(fetchUrl)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => {
        if (cancelled) return
        const m = mapResponse(json)
        setAll(m.options)
        setMeta({ source: m.source, error: m.error })
        if (!m.error) listCache.set(fetchUrl, { ts: Date.now(), options: m.options, source: m.source, error: '' })
      })
      .catch(() => {
        if (!cancelled) {
          setAll([])
          setMeta({ source: '', error: 'fetch-failed' })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, fetchUrl, minChars])

  // CHẾ ĐỘ TÌM TRỰC TIẾP (minChars): gõ đủ ký tự → gọi API tìm kiếm (debounce 300ms).
  // Cache theo từ khóa 60s nên gõ lùi/xóa không phải gọi lại.
  useEffect(() => {
    if (minChars === undefined || !open) return
    const qq = query.trim()
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    if (qq.length < minChars) {
      setAll(null)
      setMeta({ source: '', error: '' })
      setLoading(false)
      return () => {
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', place, true)
      }
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const key = `${fetchUrl}?q=${encodeURIComponent(qq)}`
      const hit = listCache.get(key)
      if (hit && Date.now() - hit.ts < CACHE_TTL) {
        setAll(hit.options)
        setMeta({ source: hit.source, error: hit.error })
        setLoading(false)
        return
      }
      setLoading(true)
      api(key)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.json()
        })
        .then((json) => {
          if (cancelled) return
          const m = mapResponse(json)
          setAll(m.options)
          setMeta({ source: m.source, error: m.error })
          if (!m.error) listCache.set(key, { ts: Date.now(), options: m.options, source: m.source, error: '' })
        })
        .catch(() => {
          if (!cancelled) {
            setAll([])
            setMeta({ source: '', error: 'fetch-failed' })
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [query, open, minChars, fetchUrl])

  // LỌC ngay trên danh sách đã tải — không phân biệt hoa/thường + dấu, khớp cả barcode/SĐT
  const options = useMemo(() => {
    if (!all) return []
    const n = norm(query.trim())
    if (!n) return all
    return all.filter(
      (o) =>
        norm(o.code).includes(n) ||
        norm(o.name).includes(n) ||
        (o.extra ? norm(o.extra).includes(n) : false) ||
        (o.sub ? norm(o.sub).includes(n) : false),
    )
  }, [all, query])

  const hlSafe = Math.min(hl, Math.max(options.length - 1, 0))
  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector('.is-hl')?.scrollIntoView({ block: 'nearest' })
  }, [hlSafe, open])

  const pick = (o: ACOption) => {
    onChange(o)
    setOpen(false)
  }

  let notice = ''
  if (!loading) {
    if (minChars !== undefined && query.trim().length < minChars) {
      notice = minCharsHint ?? `Nhập tối thiểu ${minChars} ký tự để tìm kiếm…`
    } else if (meta.error === 'fetch-failed') notice = 'Không thể truy vấn dữ liệu — kiểm tra kết nối SAP B1 ở trang Cài đặt'
    else if (meta.error) notice = `⚠ Lỗi SAP: ${meta.error}`
    else if (all && all.length === 0)
      notice =
        meta.source === 'sap'
          ? 'Không có mặt hàng nào khớp từ khóa (chỉ tìm trong MẶT HÀNG BÁN ĐƯỢC — Sales Item)'
          : 'Dữ liệu local trống — kết nối SAP B1 ở trang Cài đặt để lấy dữ liệu thật'
    else if (all && options.length === 0)
      notice = `Không có mục nào khớp “${query.trim()}” trong ${all.length} mục đã tải`
  }

  const shown = options.slice(0, MAX_RENDER)

  return (
    <div className="fm-field" ref={boxRef}>
      <label className="fm-label">
        {label}
        {required && <span className="fm-label__req">*</span>}
      </label>
      <div className="fm-autocomplete">
        <input
          ref={inputRef}
          className={`fm-input${error ? ' is-error' : ''}`}
          placeholder={placeholder}
          value={value ? `${value.code} — ${value.name}` : query}
          onChange={(e) => {
            setQuery(e.target.value)
            onChange(null)
            setOpen(true)
            setHl(0)
          }}
          onFocus={() => {
            setQuery('')
            setOpen(true)
          }}
          // input đã có focus thì onFocus không fire lại — mở dropdown khi click vào ô đã chọn
          onMouseDown={() => {
            if (!open) {
              setQuery('')
              setOpen(true)
            }
          }}
          onKeyDown={(e) => {
            if (!open) return
            if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, options.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)) }
            else if (e.key === 'Enter' && options[hlSafe]) { e.preventDefault(); pick(options[hlSafe]) }
            else if (e.key === 'Escape') setOpen(false)
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <Search size={15} style={{ position: 'absolute', right: 10, top: 9, color: 'var(--fm-text-3)', pointerEvents: 'none' }} />
        {open && rect && (
          <div
            className="fm-autocomplete__panel fm-scroll"
            ref={panelRef}
            style={{
              position: 'fixed',
              top: rect.top ?? 'auto',
              bottom: rect.bottom ?? 'auto',
              left: rect.left,
              width: rect.width,
              maxWidth: 'calc(100vw - 16px)',
              right: 'auto',
              zIndex: 66, // trên bottom tab bar (65) — panel không bị thanh tab đè
            }}
          >
            {loading && <div className="fm-autocomplete__opt">{minChars !== undefined ? 'Đang tìm mặt hàng…' : 'Đang tải toàn bộ danh sách…'}</div>}
            {!loading && notice && (
              <div className="fm-autocomplete__opt" style={notice.startsWith('⚠') || meta.error ? { color: '#C14B33' } : undefined}>{notice}</div>
            )}
            {!loading && !notice && options.length === 0 && (
              <div className="fm-autocomplete__opt">Không tìm thấy kết quả</div>
            )}
            {shown.map((o, i) => (
              <div
                key={o.code}
                className={`fm-autocomplete__opt${i === hlSafe ? ' is-hl' : ''}`}
                onMouseEnter={() => setHl(i)}
                onClick={() => pick(o)}
              >
                <div className="fm-autocomplete__main">
                  <span><b>{o.code}</b> — {o.name}</span>
                  {o.sub && <small className="fm-autocomplete__sub">{o.sub}</small>}
                </div>
                {o.extra && <small>{o.extra}</small>}
              </div>
            ))}
            {!loading && options.length > 0 && (
              <div className="fm-autocomplete__more">
                {options.length > MAX_RENDER
                  ? `Hiển thị ${MAX_RENDER}/${options.length} mục — gõ thêm để thu hẹp`
                  : all && options.length !== all.length
                    ? `${options.length}/${all.length} mục khớp`
                    : `Toàn bộ ${options.length} mục`}
              </div>
            )}
          </div>
        )}
      </div>
      {error ? <div className="fm-error-text">{error}</div> : null}
    </div>
  )
}
