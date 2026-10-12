'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Save, ShoppingCart, ShoppingBasket, BadgeCheck, RefreshCw, Upload, Sparkles, ChevronDown, ChevronUp, History, BookmarkPlus, X } from 'lucide-react'
import * as XLSX from 'xlsx'
import Autocomplete, { ACOption } from './autocomplete'
import { formatVND, formatNum } from '@/lib/fm-shared'
import { calcOrderLines } from '@/lib/order-calc'
import { api } from '@/lib/fm-client'

interface DraftLine {
  key: number
  item: ACOption | null
  quantity: number
  unitPrice: number
  discPct: number
  vatPct: number
  /** 'special' = giá đặc biệt theo khách hàng (OSPP); 'pricelist' = Price List 1 */
  priceSource?: string
  /** Mã nhóm thuế SAP (SalesVATGroup, vd S1/S2/S8) — tự điền khi chọn mặt hàng, đi kèm khi đẩy đơn sang SAP B1 */
  taxCode?: string
  /** Đơn vị tính (SalesUnit) — tự điền khi chọn mặt hàng */
  uom?: string
  /** Kho xuất của dòng (WarehouseCode) — mặc định lấy từ header, chỉnh được theo dòng */
  warehouseCode?: string
  /** CHẾ ĐỘ SỬA ĐƠN: id dòng local (đơn local) hoặc LineNum trên SAP (đơn SAP) */
  dbId?: string
  sapLineNum?: number
}

// ---------- Chế độ SỬA đơn hàng đang Open ----------
export interface EditOrderLine {
  /** id bản ghi SalesOrderLine local (đơn local) */
  dbId?: string
  /** LineNum trên SAP B1 (đơn đã synced — lấy từ chi tiết SL) */
  sapLineNum?: number
  itemCode: string
  itemName: string
  uom?: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  discPct?: number
  vatPct?: number
  taxCode?: string
}
export interface EditOrderData {
  id?: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks: string | null
  warehouseCode?: string | null
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
  headerDiscPct?: number
  sapSyncStatus?: string
  lines: EditOrderLine[]
}

// ---------- ATP check (tồn kho khả dụng từ SAP B1 /InventoryItems) ----------
interface StockRow {
  warehouseCode: string
  warehouseName?: string
  inStock: number
  committed: number
  onOrder: number
  /** ATP = Tồn − đã cam kết + đang đặt */
  available: number
}
interface AtpState {
  status: 'loading' | 'ok' | 'error'
  error?: string
  source?: string
  warehouses?: StockRow[]
  totals?: { inStock: number; committed: number; onOrder: number; available: number }
  selected?: StockRow | null
}

const clampPct = (n: number) => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0))

let keyCounter = 0
const nextKey = () => ++keyCounter

export default function OrderFormView({
  onSaved,
  editOrder,
  onCancel,
}: {
  onSaved: (result: { docNum: number; sapStatus: string; sapDocNum?: number | null; sapError?: string | null }) => void
  /** Đơn hàng cần sửa (Open) — có nghĩa là đang ở chế độ CẬP NHẬT */
  editOrder?: EditOrderData | null
  /** Nút hủy ở chế độ sửa → quay lại danh sách */
  onCancel?: () => void
}) {
  const [partner, setPartner] = useState<ACOption | null>(null)
  const [partnerErr, setPartnerErr] = useState('')
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [docDueDate, setDocDueDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 5)
    return d.toISOString().slice(0, 10)
  })
  const [remarks, setRemarks] = useState('')

  // Kho hàng xuất bán (OWHS) — mặc định áp dụng cho toàn bộ dòng hàng
  const [warehouses, setWarehouses] = useState<{ warehouseCode: string; warehouseName: string }[]>([])
  const [headerWh, setHeaderWh] = useState('')
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) — áp cho toàn đơn */
  const [headerDiscPct, setHeaderDiscPct] = useState(0)
  const [atp, setAtp] = useState<Record<number, AtpState>>({})

  const [lines, setLines] = useState<DraftLine[]>([
    { key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 },
  ])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fieldErr, setFieldErr] = useState<Record<number, string>>({})
  const isEdit = Boolean(editOrder)

  // ---- Nhập từ Excel ----
  const fileRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // ---- Mẫu đơn hàng (Order Template) ----
  interface TemplateLine {
    itemCode: string
    itemName?: string
    quantity?: number
    unitPrice?: number
    discPct?: number
    vatPct?: number
    uom?: string
    taxCode?: string
    warehouseCode?: string
  }
  interface OrderTemplate {
    id: string
    name: string
    description?: string | null
    cardCode?: string | null
    cardName?: string | null
    lines: TemplateLine[]
    createdBy: string
    createdAt: string
  }
  const [templates, setTemplates] = useState<OrderTemplate[]>([])
  const [tplModal, setTplModal] = useState(false)
  const [tplName, setTplName] = useState('')
  const [tplDesc, setTplDesc] = useState('')
  const [tplSaving, setTplSaving] = useState(false)
  const [tplMsg, setTplMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadTemplates = async () => {
    try {
      const res = await api('/api/order-templates')
      const json = await res.json()
      if (json?.data) setTemplates(json.data)
    } catch {
      // im lặng — tính năng phụ
    }
  }

  // Tải danh sách mẫu khi vào chế độ tạo mới
  useEffect(() => {
    if (!isEdit) loadTemplates()
  }, [isEdit])

  // Áp dụng mẫu: điền toàn bộ dữ liệu vào form
  const applyTemplate = (tpl: OrderTemplate) => {
    if (tpl.cardCode) {
      setPartner({ code: tpl.cardCode, name: tpl.cardName || tpl.cardCode } as ACOption)
    }
    const newLines: DraftLine[] = tpl.lines.map((tl) => ({
      key: nextKey(),
      item: { code: tl.itemCode, name: tl.itemName || tl.itemCode } as ACOption,
      quantity: tl.quantity ?? 1,
      unitPrice: tl.unitPrice ?? 0,
      discPct: tl.discPct ?? 0,
      vatPct: tl.vatPct ?? 8,
      uom: tl.uom,
      taxCode: tl.taxCode,
      warehouseCode: tl.warehouseCode || headerWh || undefined,
    }))
    setLines(newLines)
    // Tự động resolve giá/VAT/tồn kho cho từng dòng
    newLines.forEach((l) => {
      if (l.item) {
        void resolvePrice(l.key, l.item.code, tpl.cardCode ?? partner?.code ?? null)
        void checkAtp(l.key, l.item.code, l.warehouseCode)
      }
    })
    setTplMsg({ type: 'success', text: `Đã áp dụng mẫu "${tpl.name}" (${newLines.length} dòng).` })
  }

  // Lưu form hiện tại thành mẫu
  const saveAsTemplate = async () => {
    if (!tplName.trim()) {
      setTplMsg({ type: 'error', text: 'Vui lòng nhập tên mẫu.' })
      return
    }
    const validLines = lines.filter((l) => l.item && l.quantity > 0)
    if (validLines.length === 0) {
      setTplMsg({ type: 'error', text: 'Form phải có ít nhất 1 dòng hàng hợp lệ.' })
      return
    }
    setTplSaving(true)
    try {
      const res = await api('/api/order-templates', {
        method: 'POST',
        body: JSON.stringify({
          name: tplName.trim(),
          description: tplDesc.trim() || undefined,
          cardCode: partner?.code || undefined,
          cardName: partner?.name || undefined,
          lines: validLines.map((l) => ({
            itemCode: l.item!.code,
            itemName: l.item!.name,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discPct: l.discPct,
            vatPct: l.vatPct,
            uom: l.uom,
            taxCode: l.taxCode,
            warehouseCode: l.warehouseCode,
          })),
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setTplMsg({ type: 'error', text: json.error ?? 'Không lưu được mẫu.' })
        return
      }
      setTplMsg({ type: 'success', text: `Đã lưu mẫu "${tplName.trim()}".` })
      setTplModal(false)
      setTplName('')
      setTplDesc('')
      loadTemplates()
    } catch {
      setTplMsg({ type: 'error', text: 'Không thể kết nối máy chủ.' })
    } finally {
      setTplSaving(false)
    }
  }

  const deleteTemplate = async (id: string, name: string) => {
    if (!window.confirm(`Xóa mẫu "${name}"?`)) return
    try {
      const res = await api(`/api/order-templates/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setTplMsg({ type: 'success', text: `Đã xóa mẫu "${name}".` })
        loadTemplates()
      }
    } catch {
      // im lặng
    }
  }

  // ---- Gợi ý mặt hàng theo lịch sử mua hàng của khách ----
  interface SuggestItem {
    itemCode: string
    itemName: string
    orderCount: number
    totalQty: number
    lastPrice: number
    lastDate: string
    uom?: string
    taxCode?: string
    warehouseCode?: string
  }
  const [suggests, setSuggests] = useState<SuggestItem[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(true)

  // ---- Lịch sử giá theo khách hàng ----
  interface PriceHistRow {
    docNum: number
    docDate: string
    quantity: number
    unitPrice: number
    discPct: number
    uom: string
  }
  const [priceHist, setPriceHist] = useState<PriceHistRow[]>([])
  const [priceHistLoading, setPriceHistLoading] = useState(false)
  const [priceHistFor, setPriceHistFor] = useState<{ key: number; itemCode: string; itemName: string } | null>(null)

  const openPriceHist = (lineKey: number, itemCode: string, itemName: string) => {
    const code = partner?.code
    if (!code) return
    setPriceHistFor({ key: lineKey, itemCode, itemName })
    setPriceHist([])
    setPriceHistLoading(true)
    api(`/api/orders/price-history?cardCode=${encodeURIComponent(code)}&itemCode=${encodeURIComponent(itemCode)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (res.ok && json.ok) setPriceHist(json.data ?? [])
      })
      .catch(() => {})
      .finally(() => setPriceHistLoading(false))
  }

  const applyPriceHist = (row: PriceHistRow) => {
    if (!priceHistFor) return
    updateLine(priceHistFor.key, { unitPrice: row.unitPrice, discPct: row.discPct, priceSource: 'manual' })
    setPriceHistFor(null)
  }

  useEffect(() => {
    let cancelled = false
    const code = partner?.code
    if (!code) { setSuggests([]); return }
    setSuggestLoading(true)
    api(`/api/orders/suggest-items?cardCode=${encodeURIComponent(code)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!cancelled && res.ok && json.ok) setSuggests(json.data ?? [])
        else if (!cancelled) setSuggests([])
      })
      .catch(() => { if (!cancelled) setSuggests([]) })
      .finally(() => { if (!cancelled) setSuggestLoading(false) })
    return () => { cancelled = true }
  }, [partner?.code])

  const addSuggested = (s: SuggestItem) => {
    const key = nextKey()
    const line: DraftLine = {
      key,
      item: { code: s.itemCode, name: s.itemName } as ACOption,
      quantity: 1,
      unitPrice: s.lastPrice || 0,
      discPct: 0,
      vatPct: 8,
      uom: s.uom,
      taxCode: s.taxCode,
      warehouseCode: s.warehouseCode || headerWh || undefined,
    }
    setLines((ls) => {
      const hasData = ls.some((l) => l.item)
      return hasData ? [...ls, line] : [line]
    })
    void resolvePrice(key, s.itemCode, partner?.code ?? null)
    void checkAtp(key, s.itemCode, line.warehouseCode)
  }

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    try {
      // Lấy template mặc định
      const tRes = await api('/api/excel-templates')
      const tJson = await tRes.json()
      const templates = tJson.data ?? []
      const template = templates.find((t: { isDefault: boolean }) => t.isDefault) ?? templates[0]
      if (!template) {
        setImportMsg({ type: 'error', text: 'Chưa có template Excel nào. Vào "Mẫu Excel" để tạo template trước.' })
        return
      }
      const mapping: Record<string, string> = template.mapping

      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
      if (rows.length === 0) {
        setImportMsg({ type: 'error', text: 'File Excel không có dữ liệu.' })
        return
      }

      // Đảo mapping: fieldKey -> excelColumn
      const fieldToCol: Record<string, string> = {}
      for (const [col, field] of Object.entries(mapping)) fieldToCol[field] = col

      const newLines: DraftLine[] = []
      const errors: string[] = []
      rows.forEach((row, idx) => {
        const get = (field: string): string => {
          const col = fieldToCol[field]
          if (!col) return ''
          return String(row[col] ?? '').trim()
        }
        const itemCode = get('itemCode')
        if (!itemCode) {
          errors.push(`Dòng ${idx + 2}: thiếu Mã hàng`)
          return
        }
        const quantity = Number(get('quantity')) || 0
        if (quantity <= 0) {
          errors.push(`Dòng ${idx + 2}: Số lượng không hợp lệ`)
          return
        }
        newLines.push({
          key: nextKey(),
          item: { code: itemCode, name: get('itemName') || itemCode } as ACOption,
          quantity,
          unitPrice: Number(get('unitPrice')) || 0,
          discPct: Number(get('discPct')) || 0,
          vatPct: 8,
          uom: get('uom') || undefined,
          taxCode: get('taxCode') || undefined,
          warehouseCode: get('warehouseCode') || headerWh || undefined,
        })
      })

      if (newLines.length === 0) {
        setImportMsg({ type: 'error', text: `Không nhập được dòng nào. ${errors.slice(0, 3).join('; ')}` })
        return
      }

      // Thay dòng trống đầu tiên nếu chưa có dữ liệu
      setLines((ls) => {
        const hasData = ls.some((l) => l.item)
        const base = hasData ? ls : []
        return [...base, ...newLines]
      })
      // Tự động resolve giá/VAT cho từng dòng đã nhập
      newLines.forEach((l) => {
        if (l.item) {
          void resolvePrice(l.key, l.item.code, partner?.code ?? null)
          void checkAtp(l.key, l.item.code, l.warehouseCode)
        }
      })

      const msg = `Đã nhập ${newLines.length} dòng từ Excel (template "${template.name}").`
      setImportMsg({
        type: errors.length > 0 ? 'error' : 'success',
        text: errors.length > 0 ? `${msg} ${errors.length} dòng lỗi: ${errors.slice(0, 3).join('; ')}` : msg,
      })
    } catch {
      setImportMsg({ type: 'error', text: 'Không đọc được file Excel.' })
    }
  }

  // ---- ATP check: tồn kho khả dụng của mặt hàng (theo kho của dòng nếu có) ----
  async function checkAtp(key: number, itemCode: string, whCode?: string) {
    setAtp((m) => ({ ...m, [key]: { status: 'loading' } }))
    try {
      const qs = new URLSearchParams({ itemCode })
      if (whCode) qs.set('warehouseCode', whCode)
      const res = await api(`/api/items/stock?${qs.toString()}`)
      const json = await res.json()
      if (json?.ok) {
        setAtp((m) => ({
          ...m,
          [key]: { status: 'ok', source: json.source, warehouses: json.warehouses, totals: json.totals, selected: json.selected ?? null },
        }))
      } else {
        setAtp((m) => ({ ...m, [key]: { status: 'error', error: json?.error ?? 'Không kiểm tra được tồn kho' } }))
      }
    } catch {
      setAtp((m) => ({ ...m, [key]: { status: 'error', error: 'Không thể kết nối máy chủ' } }))
    }
  }


  // ---- Điền sẵn dữ liệu đơn khi vào chế độ SỬA ----
  useEffect(() => {
    if (!editOrder) return
    // Khởi tạo form từ editOrder (đồng bộ, hợp lệ — chạy 1 lần khi vào chế độ sửa)
    setPartner({ code: editOrder.cardCode, name: editOrder.cardName })
    setDocDate((editOrder.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setDocDueDate((editOrder.docDueDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setRemarks(editOrder.remarks ?? '')
    setHeaderWh(editOrder.warehouseCode ?? '')
    setHeaderDiscPct(editOrder.headerDiscPct ?? 0)
    const prefilled: DraftLine[] = editOrder.lines.map((l) => ({
      key: nextKey(),
      item: { code: l.itemCode, name: l.itemName, uom: l.uom || '', taxCode: l.taxCode || '' },
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct ?? 0,
      vatPct: l.vatPct ?? 0,
      taxCode: l.taxCode || undefined,
      uom: l.uom || undefined,
      warehouseCode: l.warehouseCode || editOrder.warehouseCode || undefined,
      priceSource: 'manual', // không tự giải lại giá khi sửa đơn — giữ nguyên số liệu gốc
      dbId: l.dbId,
      sapLineNum: l.sapLineNum,
    }))
    setLines(prefilled.length > 0 ? prefilled : [{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 }])
    setAtp({})
    setError('')
    setPartnerErr('')
    setFieldErr({})
    // Kiểm tra ATP cho các dòng đã điền
    for (const l of prefilled) if (l.item) void checkAtp(l.key, l.item.code, l.warehouseCode)
  }, [editOrder])

  const totals = useMemo(() => {
    // Dùng đúng bộ tính toán của máy chủ (order-calc) để số trên màn hình
    // khớp TỪNG ĐỒNG với số lưu khi bấm Lưu: CK dòng → CK đầu chứng từ
    // (phân bổ về dòng) → VAT
    const calc = calcOrderLines(
      lines
        .filter((l) => l.item && l.quantity > 0)
        .map((l) => ({
          itemCode: l.item!.code,
          itemName: l.item!.name,
          uom: l.uom || '',
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discPct: l.discPct,
          vatPct: l.vatPct,
        })),
      headerDiscPct,
    )
    const totalBeforeDisc = calc.reduce((s, l) => s + l.lineTotal, 0)
    const discountAmt = calc.reduce((s, l) => s + l.discAmt, 0)
    const headerDiscAmt = calc.reduce((s, l) => s + l.headerDiscAmt, 0)
    const vatAmt = calc.reduce((s, l) => s + l.vatAmt, 0)
    const afterDisc = totalBeforeDisc - discountAmt - headerDiscAmt
    return { totalBeforeDisc, discountAmt, headerDiscAmt, afterDisc, vatAmt, grand: afterDisc + vatAmt }
  }, [lines, headerDiscPct])

  const updateLine = (key: number, patch: Partial<DraftLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    setFieldErr((fe) => ({ ...fe, [key]: '' }))
  }
  const addLine = () =>
    setLines((ls) => [...ls, { key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8, warehouseCode: headerWh || undefined }])
  const removeLine = (key: number) =>
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls))

  // ---- Kho hàng xuất bán: tải danh sách kho (GET /Warehouses qua /api/warehouses) ----
  useEffect(() => {
    let cancelled = false
    api('/api/warehouses')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (Array.isArray(j?.data) && j.data.length > 0) {
          setWarehouses(j.data)
          setHeaderWh((cur) => cur || j.data[0].warehouseCode) // mặc định chọn kho đầu tiên
        }
      })
      .catch(() => {
        /* chưa cấu hình SAP / lỗi mạng — để trống, user vẫn nhập đơn được */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Đổi kho trên header → áp dụng cho TẤT CẢ dòng hàng + kiểm tra lại ATP
  const applyHeaderWarehouse = (code: string) => {
    setHeaderWh(code)
    setLines((ls) => {
      ls.forEach((l) => {
        if (l.item) void checkAtp(l.key, l.item.code, code)
      })
      return ls.map((l) => ({ ...l, warehouseCode: code || undefined }))
    })
  }

  // Giải đơn giá theo quy tắc: GIÁ ĐẶC BIỆT theo Mặt hàng + Khách hàng (OSPP) →
  // tìm thấy thì dùng; không tìm thấy → giá từ Price List 1 (source 'special' | 'pricelist')
  const resolvePrice = async (key: number, itemCode: string, cardCode: string | null) => {
    try {
      const qs = new URLSearchParams({ itemCode })
      if (cardCode) qs.set('cardCode', cardCode)
      const res = await api(`/api/items/price?${qs.toString()}`)
      const json = await res.json()
      if (json?.ok && typeof json.price === 'number' && json.price > 0) {
        setLines((ls) =>
          ls.map((l) =>
            l.key === key && l.item?.code === itemCode ? { ...l, unitPrice: json.price, priceSource: json.source } : l,
          ),
        )
      }
    } catch {
      /* giữ nguyên đơn giá hiện tại */
    }
  }

  const save = async () => {
    setError('')
    setPartnerErr('')
    if (!partner) { setPartnerErr('Vui lòng chọn khách hàng từ danh sách'); return }
    const valid = lines.filter((l) => l.item && l.quantity > 0)
    if (valid.length === 0) {
      setError('Đơn hàng cần ít nhất 1 dòng hàng hóa có mã hàng và số lượng > 0')
      return
    }

    setSaving(true)
    try {
      const payload = {
        cardCode: partner.code,
        cardName: partner.name,
        docDate,
        docDueDate,
        remarks,
        warehouseCode: headerWh || undefined,
        headerDiscPct: clampPct(headerDiscPct),
        lines: valid.map((l) => ({
          ...(isEdit ? { dbId: l.dbId, sapLineNum: l.sapLineNum } : {}),
          itemCode: l.item!.code,
          itemName: l.item!.name,
          uom: l.uom?.trim() || l.item!.uom?.trim() || 'kg',
          taxCode: l.taxCode || l.item!.taxCode || undefined,
          warehouseCode: l.warehouseCode || headerWh || undefined,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discPct: clampPct(l.discPct),
          vatPct: clampPct(l.vatPct),
        })),
      }
      const res = await api(isEdit ? `/api/orders/${editOrder!.id}` : '/api/orders', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? (isEdit ? 'Không thể cập nhật đơn hàng' : 'Không thể tạo đơn hàng'))
        return
      }
      const o = json.order
      onSaved({
        docNum: o.docNum,
        sapStatus: o.sapSyncStatus ?? 'none',
        sapDocNum: o.sapDocNum ?? null,
        sapError: o.sapSyncError ?? null,
      })
    } catch {
      setError('Không thể kết nối máy chủ')
    } finally {
      setSaving(false)
    }
  }

  // ---- ATP helpers: chọn dòng tồn kho tương ứng + tooltip chi tiết ----
  const pickAtpRow = (info: AtpState | undefined, l: DraftLine, headerWhCode: string): StockRow | null => {
    if (!info || info.status !== 'ok') return null
    if (info.selected) return info.selected
    const wh = l.warehouseCode || headerWhCode
    if (wh && info.warehouses) {
      const f = info.warehouses.find((w) => w.warehouseCode === wh)
      if (f) return f
    }
    return info.totals
      ? { warehouseCode: '', ...info.totals }
      : info.warehouses?.[0] ?? null
  }
  const atpTooltip = (info: AtpState | undefined, row: StockRow): string => {
    const perWh = (info?.warehouses ?? []).map(
      (w) => `Kho ${w.warehouseCode || '(local)'}: Tồn ${formatNum(w.inStock)} · Cam kết ${formatNum(w.committed)} · Đang về ${formatNum(w.onOrder)} → ATP ${formatNum(w.available)}`,
    )
    const tot = info?.totals
    const totalTxt = tot
      ? `Tổng: Tồn ${formatNum(tot.inStock)} · Cam kết ${formatNum(tot.committed)} · Đang về ${formatNum(tot.onOrder)} → ATP ${formatNum(tot.available)}`
      : ''
    return [
      `Kho đang xét ${row.warehouseCode ? row.warehouseCode : '(mặc định SAP)'} — ATP = Tồn kho − Đã cam kết + Đang đặt hàng`,
      ...perWh,
      totalTxt,
    ].filter(Boolean).join('\n')
  }

  return (
    <div>
      {error && (
        <div className="fm-alert fm-alert--error" role="alert">
          <div><b>{isEdit ? 'Không thể cập nhật đơn hàng' : 'Không thể lưu đơn hàng'}</b>{error}</div>
        </div>
      )}

      {isEdit && editOrder && (
        <div className="fm-alert fm-alert--success" style={{ marginBottom: 14 }}>
          <div>
            <b>Đang sửa Sale Order #{editOrder.docNum}</b>
            {editOrder.sapSyncStatus === 'synced'
              ? ' — Lưu thay đổi sẽ cập nhật trực tiếp chứng từ trên SAP B1 (PATCH /Orders). Chỉ được sửa khi chứng từ còn Open trên SAP.'
              : ' — Đơn chưa đẩy sang SAP B1, lưu thay đổi chỉ áp dụng trên hệ thống này.'}
          </div>
        </div>
      )}

      {/* Bước 1 — Khách hàng & thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingCart size={18} /> {isEdit ? `Cập nhật đơn hàng #${editOrder?.docNum}` : 'Bước 1 — Thông tin chung'}
        </h2>

        {!isEdit && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
            <label className="fm-label" style={{ margin: 0, whiteSpace: 'nowrap' }} htmlFor="fm-template-select">
              Chọn từ mẫu:
            </label>
            <select
              id="fm-template-select"
              className="fm-select"
              style={{ minWidth: 220, flex: '1 1 220px', maxWidth: 360 }}
              defaultValue=""
              onChange={(e) => {
                const tpl = templates.find((t) => t.id === e.target.value)
                if (tpl) applyTemplate(tpl)
                e.target.value = ''
              }}
            >
              <option value="" disabled>-- Chọn mẫu đơn hàng --</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.cardName ? ` — ${t.cardName}` : ''} ({t.lines.length} dòng)
                </option>
              ))}
            </select>
            {templates.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--fm-text-2)' }}>{templates.length} mẫu có sẵn</span>
            )}
          </div>
        )}
        {tplMsg && (
          <div className={`fm-alert ${tplMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} style={{ marginBottom: 12 }} role="status">
            <div>{tplMsg.text}</div>
            <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setTplMsg(null)}>✕</button>
          </div>
        )}

        <div className="fm-form-grid">
          <Autocomplete
            label="Khách hàng (CardCode)"
            required
            placeholder="Gõ mã KH hoặc tên KH…"
            fetchUrl="/api/partners"
            value={partner}
            onChange={(v) => {
              setPartner(v)
              setPartnerErr('')
              // đổi khách hàng → tính lại giá (đặc biệt → bảng giá) cho các dòng chưa sửa giá tay
              if (v) for (const line of lines) if (line.item && line.priceSource !== 'manual') void resolvePrice(line.key, line.item.code, v.code)
            }}
            error={partnerErr || undefined}
          />
          {/* Thông tin khách hàng: địa chỉ + người liên hệ (từ đồng bộ SAP B1) */}
          <div className="fm-field">
            <label>Địa chỉ</label>
            <input className="fm-input" value={partner?.address || ''} readOnly placeholder="—" tabIndex={-1} />
          </div>
          <div className="fm-field">
            <label>Người liên hệ</label>
            <input
              className="fm-input"
              value={partner?.contactPerson ? `${partner.contactPerson}${partner.contactPhone ? ` · ${partner.contactPhone}` : ''}` : ''}
              readOnly placeholder="—" tabIndex={-1}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-doc-date">Ngày chứng từ <span className="fm-label__req">*</span></label>
            <input id="fm-doc-date" type="date" className="fm-datepicker" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-doc-due-date">Ngày giao hàng <span className="fm-label__req">*</span></label>
            <input id="fm-doc-due-date" type="date" className="fm-datepicker" value={docDueDate} onChange={(e) => setDocDueDate(e.target.value)} />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-header-wh" title="Kho hàng xuất bán (OWHS) — mặc định áp dụng cho toàn bộ dòng hàng ở Bước 2">Kho hàng xuất bán</label>
            <select
              id="fm-header-wh"
              className="fm-input"
              value={headerWh}
              onChange={(e) => applyHeaderWarehouse(e.target.value)}
              disabled={warehouses.length === 0}
            >
              {warehouses.length === 0 && <option value="">— (chưa có danh sách kho)</option>}
              <option value="">— Theo mặc định SAP —</option>
              {warehouses.map((w) => (
                <option key={w.warehouseCode} value={w.warehouseCode}>
                  {w.warehouseCode} · {w.warehouseName}
                </option>
              ))}
            </select>
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-header-disc" title="Chiết khấu áp dụng cho TOÀN BỘ chứng từ (SAP: Documents.DiscountPercent) — tính trên tiền sau chiết khấu các dòng, trước thuế">
              Chiết khấu đầu chứng từ (%)
            </label>
            <input
              id="fm-header-disc"
              type="number"
              className="fm-input"
              min={0}
              max={100}
              step="any"
              inputMode="decimal"
              placeholder="0"
              value={headerDiscPct || ''}
              onChange={(e) => setHeaderDiscPct(clampPct(Number(e.target.value)))}
            />
          </div>
        </div>

        <div className="fm-field">
          <label className="fm-label" htmlFor="fm-remarks">Ghi chú</label>
          <textarea id="fm-remarks" className="fm-input" rows={2} placeholder="Yêu cầu giao hàng, hóa đơn VAT…" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>
      </div>

      {/* Bước 2 — Dòng hàng hóa (CK% + VAT% theo từng dòng) */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingBasket size={18} /> Bước 2 — Hàng hóa
        </h2>

        {/* Gợi ý mặt hàng theo lịch sử mua hàng của khách */}
        {partner?.code && (suggestLoading || suggests.length > 0) && (
          <div style={{ marginBottom: 14, border: '1px solid var(--fm-line)', borderRadius: 'var(--fm-r-md)', background: 'var(--fm-cream)', padding: '10px 12px' }}>
            <button
              type="button"
              onClick={() => setSuggestOpen((v) => !v)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13, color: 'var(--fm-text)', padding: 0, width: '100%', textAlign: 'left' }}
            >
              <Sparkles size={15} style={{ color: 'var(--fm-primary)' }} />
              Gợi ý theo lịch sử mua hàng
              {suggestLoading
                ? <span style={{ fontWeight: 400, color: 'var(--fm-text-2)' }}> — đang tải…</span>
                : <span className="fm-chip fm-chip--role" style={{ marginLeft: 4 }}>{suggests.length} mặt hàng</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--fm-text-2)' }}>
                {suggestOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </span>
            </button>
            {suggestOpen && !suggestLoading && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {suggests.map((s) => (
                  <div
                    key={s.itemCode}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--fm-surface)', border: '1px solid var(--fm-line)', borderRadius: 'var(--fm-r-md)', padding: '6px 8px 6px 10px', maxWidth: 320 }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.itemName}>
                        {s.itemName}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--fm-text-2)' }}>
                        {s.itemCode} · đã mua {s.orderCount} lần
                      </div>
                    </div>
                    <button
                      type="button"
                      className="fm-btn fm-btn--secondary fm-btn--sm"
                      onClick={() => addSuggested(s)}
                      title={`Thêm ${s.itemName} vào đơn`}
                    >
                      <Plus size={12} /> Thêm
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>#</th>
                <th style={{ minWidth: 230 }}>Hàng hóa (ItemCode)</th>
                <th style={{ width: 96 }}>Số lượng</th>
                <th style={{ width: 78 }}>Đơn vị tính</th>
                <th style={{ width: 86 }} title="Kho hàng xuất bán (WarehouseCode) — mặc định lấy từ header, chỉnh được theo dòng">Kho</th>
                <th style={{ width: 128 }} title="ATP — tồn kho khả dụng: Tồn − đã cam kết + đang đặt. Tự kiểm tra sau khi chọn mặt hàng">Tồn kho (ATP)</th>
                <th style={{ width: 132 }}>Đơn giá (₫)</th>
                <th style={{ width: 92 }} title="Chiết khấu áp dụng riêng cho dòng này">CK (%)</th>
                <th style={{ width: 88 }} title="Mã nhóm thuế (SalesVATGroup) của mặt hàng trong SAP B1">Mã thuế</th>
                <th style={{ width: 92 }} title="Thuế suất VAT áp dụng riêng cho dòng này — tự điền theo mã thuế">VAT (%)</th>
                <th className="fm-num" style={{ minWidth: 128 }}>Sau CK (₫)</th>
                <th style={{ width: 44 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => {
                const invalid = Boolean(fieldErr[l.key])
                const lineTotal = l.quantity * l.unitPrice
                const discAmt = Math.round((lineTotal * clampPct(l.discPct)) / 100)
                const afterDisc = lineTotal - discAmt
                return (
                  <tr key={l.key} className={l.item ? '' : 'is-draft'}>
                    <td data-label="Dòng">{idx + 1}</td>
                    <td data-label="Hàng hóa (ItemCode)" data-full>
                      <Autocomplete
                        label=""
                        placeholder="Gõ tối thiểu 2 ký tự: mã hàng hoặc tên hàng…"
                        fetchUrl="/api/items"
                        minChars={2}
                        minCharsHint="Nhập tối thiểu 2 ký tự để tìm mặt hàng (chỉ MẶT HÀNG BÁN ĐƯỢC)…"
                        value={l.item}
                        onChange={(v) => {
                          // chọn mặt hàng → tự load đơn giá (Price List 1 / OSPP), VAT% (qua mã thuế),
                          // mã nhóm thuế (SalesVATGroup), đơn vị tính (SalesUnit) + KHO theo header
                          const vat = typeof v?.vatRate === 'number' ? v.vatRate : null
                          const wh = l.warehouseCode || headerWh || undefined
                          updateLine(l.key, {
                            item: v,
                            unitPrice: v?.price ?? 0,
                            priceSource: v ? 'pricelist' : undefined,
                            taxCode: v?.taxCode || undefined,
                            uom: v?.uom || undefined,
                            warehouseCode: wh,
                            ...(vat !== null ? { vatPct: vat } : {}),
                          })
                          if (v) {
                            void resolvePrice(l.key, v.code, partner?.code ?? null)
                            void checkAtp(l.key, v.code, wh) // ATP check tự động sau khi chọn mặt hàng
                          }
                        }}
                        error={invalid ? 'Chưa chọn hàng hóa' : undefined}
                      />
                    </td>
                    <td data-label="Số lượng">
                      <input
                        type="number"
                        min={0}
                        step="0.5"
                        inputMode="decimal"
                        aria-label={`Số lượng dòng ${l.key}`}
                        className="fm-line-input"
                        value={l.quantity || ''}
                        onChange={(e) => updateLine(l.key, { quantity: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td data-label="Đơn vị tính">
                      {l.item ? (
                        <span className="fm-line-meta" title="Đơn vị tính (SalesUnit) tải từ SAP B1">{l.uom || l.item.uom || '—'}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-label="Kho">
                      <select
                        className="fm-line-select"
                        value={l.warehouseCode ?? headerWh ?? ''}
                        title="Kho xuất của dòng (WarehouseCode) — mặc định theo header"
                        disabled={warehouses.length === 0}
                        onChange={(e) => {
                          updateLine(l.key, { warehouseCode: e.target.value || undefined })
                          if (l.item) void checkAtp(l.key, l.item.code, e.target.value || undefined)
                        }}
                      >
                        <option value="">—</option>
                        {warehouses.map((w) => (
                          <option key={w.warehouseCode} value={w.warehouseCode}>{w.warehouseCode}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="Tồn kho (ATP)">
                      {!l.item ? (
                        '—'
                      ) : (
                        <div className="fm-atp-cell">
                          {atp[l.key]?.status === 'loading' && <span className="fm-line-meta">Đang kiểm tra…</span>}
                          {atp[l.key]?.status === 'error' && (
                            <span className="fm-line-meta fm-atp--warn" title={atp[l.key]?.error}>Không kiểm tra được</span>
                          )}
                          {atp[l.key]?.status === 'ok' && (() => {
                            const row = pickAtpRow(atp[l.key], l, headerWh)
                            if (!row) return <span className="fm-line-meta fm-atp--warn" title="SAP không có dữ liệu tồn cho kho này">Không có tồn</span>
                            const enough = row.available - l.quantity >= 0
                            return (
                              <span
                                className={`fm-line-meta ${enough ? 'fm-atp--ok' : 'fm-atp--low'}`}
                                title={atpTooltip(atp[l.key], row)}
                              >
                                {enough ? 'ATP ' : 'Thiếu '}
                                {formatNum(enough ? row.available : -(row.available - l.quantity))}
                              </span>
                            )
                          })()}
                          <button
                            type="button"
                            className="fm-atp-recheck"
                            title="Kiểm tra lại tồn kho khả dụng (ATP)"
                            aria-label={`Kiểm tra lại tồn kho cho ${l.item?.name ?? 'mặt hàng'}`}
                            onClick={() => l.item && checkAtp(l.key, l.item.code, l.warehouseCode || headerWh || undefined)}
                          >
                            <RefreshCw size={12} />
                          </button>
                        </div>
                      )}
                    </td>
                    <td data-label="Đơn giá (₫)">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <input
                          type="number"
                          min={0}
                          step="1000"
                          inputMode="decimal"
                          aria-label={`Đơn giá dòng ${l.key}`}
                          className="fm-line-input"
                          style={{ flex: 1, minWidth: 0 }}
                          value={l.unitPrice || ''}
                          title={l.priceSource === 'special' ? 'Giá đặc biệt theo khách hàng (SAP OSPP)' : l.item ? 'Giá từ Price List 1' : undefined}
                          onChange={(e) => updateLine(l.key, { unitPrice: Number(e.target.value) || 0, priceSource: l.item ? 'manual' : undefined })}
                        />
                        {l.priceSource === 'special' && (
                          <span className="fm-price-star" title="Giá đặc biệt theo khách hàng (SAP OSPP)">★</span>
                        )}
                        {l.item && partner?.code && (() => {
                          const it = l.item
                          return (
                            <button
                              type="button"
                              className="fm-icon-btn"
                              style={{ width: 26, height: 26, minWidth: 26, minHeight: 26 }}
                              title="Lịch sử giá đã bán cho khách hàng này"
                              aria-label={`Lịch sử giá ${it.code}`}
                              onClick={() => openPriceHist(l.key, it.code, it.name)}
                            >
                              <History size={13} />
                            </button>
                          )
                        })()}
                      </div>
                    </td>
                    <td data-label="CK (%)">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="1"
                        inputMode="decimal"
                        aria-label={`Chiết khấu % dòng ${l.key}`}
                        className="fm-line-input fm-line-input--pct"
                        value={l.discPct || ''}
                        onChange={(e) => updateLine(l.key, { discPct: clampPct(Number(e.target.value)) })}
                      />
                    </td>
                    <td data-label="Mã thuế">
                      {l.item && l.taxCode ? (
                        <span className="fm-line-meta" title={`Mã nhóm thuế SAP (SalesVATGroup) — thuế suất ${l.vatPct ?? '?'}%`}>
                          {l.taxCode}
                          <small style={{ color: 'var(--fm-text-3)' }}> · {l.vatPct ?? '?'}%</small>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td data-label="VAT (%)">
                      <input
                        type="number"
                        aria-label={`VAT % dòng ${l.key}`}
                        className="fm-line-input fm-line-input--pct"
                        value={l.vatPct || ''}
                        readOnly
                        tabIndex={-1}
                        title="VAT % tự điền theo mã thuế"
                      />
                    </td>
                    <td className="fm-num" data-label="Sau CK (₫)">{l.item ? formatVND(afterDisc) : '—'}</td>
                    <td data-label="Xóa dòng">
                      <button className="fm-row-del" title="Xóa dòng" aria-label={`Xóa dòng ${l.key}`} onClick={() => removeLine(l.key)} disabled={lines.length <= 1}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="fm-btn fm-btn--dashed fm-btn--sm" onClick={addLine}>
            <Plus size={14} /> Thêm dòng hàng
          </button>
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Nhập từ Excel
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={handleExcelImport}
          />
        </div>
        {importMsg && (
          <div className={`fm-alert ${importMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} style={{ marginTop: 10 }}>
            <div>{importMsg.text}</div>
            <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setImportMsg(null)}>✕</button>
          </div>
        )}
      </div>

      {/* Bước 3 — Tổng kết */}
      <div className="fm-card">
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BadgeCheck size={18} /> Bước 3 — Tổng kết
        </h2>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 220px', minWidth: 220 }}>
            <div className="fm-field">
              <label className="fm-label">Số dòng hàng hóa</label>
              <div className="fm-input" style={{ background: 'var(--fm-cream)', color: 'var(--fm-text-2)' }}>
                {lines.filter((l) => l.item && l.quantity > 0).length} dòng hợp lệ / {lines.length} dòng
              </div>
            </div>
          </div>

          <div className="fm-totals">
            <div className="fm-totals__row"><span>Tổng trước chiết khấu</span><b>{formatVND(totals.totalBeforeDisc)}</b></div>
            <div className="fm-totals__row"><span>Chiết khấu các dòng</span><b>{totals.discountAmt > 0 ? `−${formatVND(totals.discountAmt)}` : formatVND(0)}</b></div>
            {totals.headerDiscAmt > 0 && (
              <div className="fm-totals__row"><span>Chiết khấu đầu chứng từ ({headerDiscPct}%)</span><b>−{formatVND(totals.headerDiscAmt)}</b></div>
            )}
            <div className="fm-totals__row"><span>Sau chiết khấu</span><b>{formatVND(totals.afterDisc)}</b></div>
            <div className="fm-totals__row"><span>Thuế VAT các dòng</span><b>{formatVND(totals.vatAmt)}</b></div>
            <div className="fm-totals__grand"><span>TỔNG CỘNG</span><span>{formatVND(totals.grand)}</span></div>
          </div>
        </div>

        <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="fm-btn fm-btn--primary" onClick={save} disabled={saving}>
            <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {saving ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Lưu đơn hàng'}
          </button>
          {!isEdit && (
            <button
              className="fm-btn fm-btn--secondary"
              onClick={() => { setTplModal(true); setTplMsg(null) }}
              disabled={saving}
              title="Lưu đơn hàng hiện tại thành mẫu để tạo nhanh lần sau"
            >
              <BookmarkPlus size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
              Lưu thành mẫu
            </button>
          )}
          {isEdit ? (
            <button className="fm-btn fm-btn--ghost" onClick={onCancel} disabled={saving}>
              Hủy — không lưu thay đổi
            </button>
          ) : (
            <button
              className="fm-btn fm-btn--ghost"
              onClick={() => {
                setPartner(null); setRemarks('')
                setHeaderDiscPct(0)
                setLines([{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8, warehouseCode: headerWh || undefined }])
                setAtp({})
                setError('')
              }}
              disabled={saving}
            >
              Nhập lại
            </button>
          )}
        </div>
      </div>

      {/* Modal lưu thành mẫu đơn hàng */}
      {tplModal && (
        <div className="fm-backdrop" onClick={() => setTplModal(false)}>
          <div className="fm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <BookmarkPlus size={17} /> Lưu thành mẫu đơn hàng
            </h3>
            <p style={{ fontSize: 12.5, color: 'var(--fm-text-2)', margin: '0 0 14px' }}>
              {partner ? `${partner.name} (${partner.code})` : 'Chưa chọn khách hàng'} — {lines.filter((l) => l.item && l.quantity > 0).length} dòng hàng
            </p>
            <div className="fm-field" style={{ marginBottom: 12 }}>
              <label className="fm-label" htmlFor="fm-tpl-name">Tên mẫu *</label>
              <input
                id="fm-tpl-name"
                className="fm-input"
                placeholder="VD: Đơn rau củ tuần — KH Coopmart"
                value={tplName}
                onChange={(e) => setTplName(e.target.value)}
                maxLength={100}
              />
            </div>
            <div className="fm-field" style={{ marginBottom: 16 }}>
              <label className="fm-label" htmlFor="fm-tpl-desc">Mô tả</label>
              <textarea
                id="fm-tpl-desc"
                className="fm-input"
                rows={2}
                placeholder="Ghi chú về mẫu này…"
                value={tplDesc}
                onChange={(e) => setTplDesc(e.target.value)}
                maxLength={255}
              />
            </div>
            {tplMsg && (
              <div className={`fm-alert ${tplMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} style={{ marginBottom: 12 }} role="status">
                <div>{tplMsg.text}</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--ghost" onClick={() => setTplModal(false)} disabled={tplSaving}>
                Hủy
              </button>
              <button className="fm-btn fm-btn--primary" onClick={saveAsTemplate} disabled={tplSaving}>
                <BookmarkPlus size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                {tplSaving ? 'Đang lưu…' : 'Lưu mẫu'}
              </button>
            </div>

            {templates.length > 0 && (
              <div style={{ marginTop: 18, borderTop: '1px solid var(--fm-line)', paddingTop: 12 }}>
                <div className="fm-label" style={{ marginBottom: 8 }}>Mẫu đã lưu ({templates.length})</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                  {templates.map((t) => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'var(--fm-cream)', borderRadius: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--fm-text-2)' }}>{t.lines.length} dòng{t.cardName ? ` — ${t.cardName}` : ''}</div>
                      </div>
                      <button
                        className="fm-btn fm-btn--ghost fm-btn--sm"
                        onClick={() => { setTplModal(false); applyTemplate(t) }}
                        title="Áp dụng mẫu này"
                      >
                        Dùng
                      </button>
                      <button
                        className="fm-icon-btn fm-icon-btn--danger"
                        onClick={() => deleteTemplate(t.id, t.name)}
                        title={`Xóa mẫu "${t.name}"`}
                        aria-label={`Xóa mẫu ${t.name}`}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal lịch sử giá theo khách hàng */}
      {priceHistFor && (
        <div className="fm-backdrop" onClick={() => setPriceHistFor(null)}>
          <div className="fm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <History size={17} /> Lịch sử giá
            </h3>
            <p style={{ fontSize: 12.5, color: 'var(--fm-text-2)', margin: '0 0 14px' }}>
              {priceHistFor.itemName} ({priceHistFor.itemCode}) — {partner?.name} ({partner?.code})
            </p>
            {priceHistLoading ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--fm-text-2)' }}>Đang tải…</div>
            ) : priceHist.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--fm-text-2)' }}>
                Chưa có lịch sử bán mặt hàng này cho khách hàng.
              </div>
            ) : (
              <div className="fm-table-wrap" style={{ overflowX: 'auto' }}>
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Ngày</th>
                      <th>Số CT</th>
                      <th style={{ textAlign: 'right' }}>SL</th>
                      <th style={{ textAlign: 'right' }}>Đơn giá (₫)</th>
                      <th style={{ textAlign: 'right' }}>CK%</th>
                      <th style={{ width: 90 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceHist.map((h, i) => (
                      <tr key={`${h.docNum}-${i}`}>
                        <td>{new Date(h.docDate).toLocaleDateString('vi-VN')}</td>
                        <td>#{h.docNum}</td>
                        <td style={{ textAlign: 'right' }}>{formatNum(h.quantity)} {h.uom}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatVND(h.unitPrice)}</td>
                        <td style={{ textAlign: 'right' }}>{h.discPct}%</td>
                        <td>
                          <button
                            type="button"
                            className="fm-btn fm-btn--secondary fm-btn--sm"
                            onClick={() => applyPriceHist(h)}
                          >
                            Áp dụng
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="fm-btn fm-btn--ghost" onClick={() => setPriceHistFor(null)}>
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
