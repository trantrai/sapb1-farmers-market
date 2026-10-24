'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Search, TriangleAlert } from 'lucide-react'
import { api, ApiNetworkError } from '@/lib/fm-client'

export interface ACOption {
  code: string
  name: string
  /** text bên phải: SĐT (khách hàng) hoặc đơn giá (mặt hàng) */
  extra?: string
  /** dòng thông tin phụ bên dưới: địa chỉ / Đơn vị · Mã thuế · Barcode */
  sub?: string
  /** khách hàng: địa chỉ đầy đủ */
  address?: string
  /** khách hàng: người liên hệ chính */
  contactPerson?: string
  /** khách hàng: SĐT người liên hệ */
  contactPhone?: string
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
  /** Ẩn label khỏi giao diện nhưng vẫn giữ cho screen reader (WCAG 4.1.2) */
  hideLabel?: boolean
  /** Khóa ô nhập (vd form đang lưu) — không mở dropdown, không gõ được */
  disabled?: boolean
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
/** Timeout riêng cho autocomplete: lần tải đầu (cache SAP lạnh) phải lấy toàn bộ
 *  danh mục phân trang từ Service Layer nên có thể chậm — cho tới 120s thay vì 30s mặc định */
const AC_TIMEOUT_MS = 120_000
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
      address: !isItem ? ((d.address as string) ?? '') : undefined,
      contactPerson: !isItem ? ((d.contactPerson as string) ?? '') : undefined,
      contactPhone: !isItem ? ((d.contactPhone as string) ?? '') : undefined,
      price: isItem && price > 0 ? price : undefined,
      uom: isItem ? ((d.uom as string) ?? '') : undefined,
      taxCode: isItem ? ((d.taxCode as string) ?? '') : undefined,
      vatRate: vat,
      barcode: isItem ? ((d.barcode as string) ?? '') : undefined,
    }
  })
  return { options: found, source: json.source ?? '', error: json.error ?? '' }
}

/** Trích thông điệp lỗi thật từ response HTTP (ưu tiên trường error JSON do backend trả) */
async function httpErrorDetail(res: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: string } | null
    if (body && typeof body.error === 'string' && body.error) detail = ` — ${body.error}`
  } catch { /* body không phải JSON */ }
  return `HTTP ${res.status}${detail}`
}

/** Diễn giải lỗi fetch thành tiếng Việt ngắn gọn để hiển thị */
function fetchErrorDetail(e: unknown): string {
  if (e instanceof ApiNetworkError)
    return 'không kết nối được máy chủ (quá thời gian chờ hoặc mất mạng) — Service Layer có thể đang tải danh mục chậm, thử lại sau ít phút'
  if (e instanceof Error) return e.message
  return 'lỗi không xác định'
}

/** Khớp CHÍNH XÁC mã vạch (ưu tiên) hoặc mã hàng — dùng cho máy quét barcode (gõ nhanh + Enter) */
function exactMatch(opts: ACOption[], q: string): ACOption | undefined {
  const t = q.trim().toLowerCase()
  if (!t) return undefined
  return opts.find((o) => (o.barcode ?? '').toLowerCase() === t) ?? opts.find((o) => o.code.toLowerCase() === t)
}

/** Autocomplete chọn CardCode / ItemCode (Bước 1 & 2 của form SO) */
export default function Autocomplete({ label, required, placeholder, fetchUrl, value, onChange, error, minChars, minCharsHint, hideLabel, disabled }: Props) {
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
  /** Enter khi kết quả tìm chưa về (máy quét barcode) → chờ kết quả rồi tự chọn mục khớp */
  const pendingEnterRef = useRef<string | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange })
  const uid = useId()
  const inputId = `fm-ac-${uid}`
  const listId = `fm-ac-list-${uid}`

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

    // eslint-disable-next-line react-hooks/set-state-in-effect -- place() đo DOM để định vị dropdown, use case hợp lệ của effect
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)

    const hit = listCache.get(fetchUrl)
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      // Cache hit: setState đồng bộ khi mở dropdown (hợp lệ, không cần defer)
      setAll(hit.options)
      setMeta({ source: hit.source, error: hit.error })
      setLoading(false)
      return () => {
        window.removeEventListener('resize', place)
        window.removeEventListener('scroll', place, true)
      }
    }
    setLoading(true)
    api(fetchUrl, { timeoutMs: AC_TIMEOUT_MS })
      .then(async (res) => {
        if (!res.ok) throw new Error(await httpErrorDetail(res))
        return res.json()
      })
      .then((json) => {
        if (cancelled) return
        const m = mapResponse(json)
        setAll(m.options)
        setMeta({ source: m.source, error: m.error })
        if (!m.error) listCache.set(fetchUrl, { ts: Date.now(), options: m.options, source: m.source, error: '' })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setAll([])
          setMeta({ source: '', error: `fetch-failed: ${fetchErrorDetail(e)}` })
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

  /** Kết quả tìm vừa về: nếu đang chờ Enter cho đúng từ khóa này → chọn mục khớp chính xác (hoặc mục duy nhất) */
  const resolvePendingEnter = (opts: ACOption[], qq: string) => {
    if (pendingEnterRef.current !== qq) return
    pendingEnterRef.current = null
    const o = exactMatch(opts, qq) ?? (opts.length === 1 ? opts[0] : undefined)
    if (o) {
      onChangeRef.current(o)
      setOpen(false)
    }
  }

  // CHẾ ĐỘ TÌM TRỰC TIẾP (minChars): gõ đủ ký tự → gọi API tìm kiếm (debounce 300ms).
  // Cache theo từ khóa 60s nên gõ lùi/xóa không phải gọi lại.
  useEffect(() => {
    if (minChars === undefined || !open) return
    const qq = query.trim()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- place() đo DOM để định vị dropdown, use case hợp lệ của effect
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    if (qq.length < minChars) {
      // Query quá ngắn: reset state đồng bộ (hợp lệ, không cần defer)
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
        resolvePendingEnter(hit.options, qq)
        return
      }
      setLoading(true)
      api(key, { timeoutMs: AC_TIMEOUT_MS })
        .then(async (res) => {
          if (!res.ok) throw new Error(await httpErrorDetail(res))
          return res.json()
        })
        .then((json) => {
          if (cancelled) return
          const m = mapResponse(json)
          setAll(m.options)
          setMeta({ source: m.source, error: m.error })
          resolvePendingEnter(m.options, qq)
          if (!m.error) listCache.set(key, { ts: Date.now(), options: m.options, source: m.source, error: '' })
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setAll([])
            setMeta({ source: '', error: `fetch-failed: ${fetchErrorDetail(e)}` })
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
    } else if (meta.error.startsWith('fetch-failed')) {
      const detail = meta.error.slice('fetch-failed:'.length).trim()
      notice = detail
        ? `Không thể truy vấn dữ liệu: ${detail}`
        : 'Không thể truy vấn dữ liệu — kiểm tra kết nối SAP B1 ở trang Cài đặt'
    } else if (meta.error) notice = `Lỗi SAP: ${meta.error}`
    else if (all && all.length === 0)
      notice =
        meta.source === 'sap'
          ? 'Không có mặt hàng nào khớp từ khóa (chỉ tìm trong MẶT HÀNG BÁN ĐƯỢC — Sales Item)'
          : meta.source === 'mirror'
            ? 'Không có mặt hàng nào khớp — thử từ khóa khác hoặc vào "Đồng bộ Mặt hàng" để cập nhật danh mục'
            : 'Dữ liệu local trống — kết nối SAP B1 ở trang Cài đặt để lấy dữ liệu thật'
    else if (all && options.length === 0)
      notice = `Không có mục nào khớp “${query.trim()}” trong ${all.length} mục đã tải`
  }

  const shown = options.slice(0, MAX_RENDER)

  return (
    <div className="fm-field" ref={boxRef}>
      <label className={`fm-label${hideLabel ? ' fm-sr-only' : ''}`} htmlFor={inputId}>
        {label}
        {required && <span className="fm-label__req">*</span>}
      </label>
      <div className="fm-autocomplete">
        <input
          ref={inputRef}
          id={inputId}
          className={`fm-input${error ? ' is-error' : ''}`}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && shown[hlSafe] ? `${listId}-opt-${hlSafe}` : undefined}
          aria-autocomplete="list"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-err` : undefined}
          disabled={disabled}
          value={value ? `${value.code} — ${value.name}` : query}
          onChange={(e) => {
            pendingEnterRef.current = null // gõ tiếp → hủy lượt Enter đang chờ
            setQuery(e.target.value)
            onChange(null)
            setOpen(true)
            setHl(0)
          }}
          onFocus={() => {
            if (disabled) return
            setQuery('')
            setOpen(true)
          }}
          // Bấm Tab/Shift+Tab ra ngoài ô nhập → đóng panel (click vào option không gây blur nhờ preventDefault ở panel)
          onBlur={(e) => {
            if (!boxRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
          }}
          // input đã có focus thì onFocus không fire lại — mở dropdown khi click vào ô đã chọn
          onMouseDown={() => {
            if (disabled) return
            if (!open) {
              setQuery('')
              setOpen(true)
            }
          }}
          onKeyDown={(e) => {
            if (!open) return
            if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, options.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)) }
            else if (e.key === 'Enter') {
              // Ưu tiên khớp chính xác mã vạch / mã hàng (quét barcode), sau đó mục đang chọn
              const ex = exactMatch(options, query)
              if (ex) { e.preventDefault(); pick(ex) }
              else if (options[hlSafe] && !loading) { e.preventDefault(); pick(options[hlSafe]) }
              else if (minChars !== undefined && query.trim().length >= minChars) {
                // Kết quả chưa về (vừa quét xong) → chờ kết quả rồi tự chọn
                e.preventDefault()
                pendingEnterRef.current = query.trim()
              }
            }
            else if (e.key === 'Escape') setOpen(false)
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <Search size={16} aria-hidden="true" style={{ position: 'absolute', right: 10, top: 9, color: 'var(--fm-text-3)', pointerEvents: 'none' }} />
        {open && rect && (
          <div
            className="fm-autocomplete__panel fm-scroll"
            ref={panelRef}
            role="listbox"
            id={listId}
            aria-label={label}
            // Giữ focus trong input khi bấm vào option → onClick vẫn chạy, onBlur không đóng panel sớm
            onMouseDown={(e) => e.preventDefault()}
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
              <div className="fm-autocomplete__opt" style={meta.error ? { color: 'var(--fm-coral-deep)', fontWeight: 600 } : undefined}>
                {meta.error && <TriangleAlert size={14} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />}
                <span>{notice}</span>
              </div>
            )}
            {!loading && !notice && options.length === 0 && (
              <div className="fm-autocomplete__opt">Không tìm thấy kết quả</div>
            )}
            {shown.map((o, i) => (
              <div
                key={o.code}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === hlSafe}
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
      {/* Thông báo số kết quả cho screen reader (mục 43) */}
      <span aria-live="polite" role="status" className="fm-sr-only">
        {open ? (loading ? 'Đang tìm kiếm…' : options.length === 0 ? 'Không tìm thấy kết quả' : `${options.length} kết quả`) : ''}
      </span>
      {error ? <div id={`${inputId}-err`} className="fm-error-text" role="alert">{error}</div> : null}
    </div>
  )
}
