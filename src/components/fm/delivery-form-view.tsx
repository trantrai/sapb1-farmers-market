'use client'

// ============================================================
// FORM tạo/sửa Phiếu giao hàng — standalone, đơn giản hơn
// order-form-view (không ATP).
// - BOM: chọn mặt hàng BOM → bung thành phần con (giá 0, SL = SL cha × định
//   mức, theo SL cha). Dòng con chỉ lưu để hiển thị/soạn hàng — khi đẩy SAP
//   chỉ gửi dòng cha, SAP tự bung theo công thức.
// - Chế độ TẠO (deliveryId undefined): chọn khách hàng, ngày chứng từ,
//   ghi chú, thêm dòng mặt hàng → POST /api/deliveries
// - Chế độ SỬA (deliveryId có giá trị): tải phiếu qua GET, khách hàng
//   chỉ đọc (không đổi được — giữ liên kết đơn nguồn), sửa được ngày
//   chứng từ / ghi chú / SL, mã thuế, CK dòng → PUT /api/deliveries/[id]
// Thuật ngữ chuẩn SAP B1. Nút lưu có trạng thái "Đang lưu…".
// ============================================================

import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, Save, Trash2, Copy } from 'lucide-react'
import Autocomplete, { ACOption } from './autocomplete'
import PageHeader from './page-header'
import { formatNum, formatVND } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import CopyFromPicker from './copy-from-picker'
import type { PrefillDoc } from '@/lib/copy-from'
import {
  B2BFieldsSection,
  b2bFromSaved,
  buildB2BPayload,
  defaultB2BForm,
  type B2BFormState,
} from './order-form-view'
import { useBpB2BInfo } from './b2b-party-fields'
import { ShortcutHelp, useFormShortcuts } from './form-shortcuts'
import { LineQuickAdd } from './line-items'
import {
  BomChildCell, BomToggle, applyParentQty, bomChildCounts, explodeBom, fetchBomDef,
  inferBomTypes, removeWithBom, roundQty, visibleBomLines, type BomKind,
  bomParentTypes, useShowLockedBomChildren,
} from './bom-lines'

interface FormLine {
  key: number
  /** Chế độ sửa: id dòng trong DB (để PUT nhận diện) */
  dbId?: string
  item: ACOption | null
  quantity: number
  unitPrice: number
  /** Mã nhóm thuế SAP (VatGroup) — text input, gợi ý từ mặt hàng */
  taxCode?: string
  /** Chiết khấu % theo dòng (0–100) */
  discPct: number
  /** Kho xuất của dòng (WarehouseCode) — mặc định theo kho header */
  warehouseCode?: string
  /** Đơn vị tính (MeasureUnit) — có thể sửa tay; để trống để SAP dùng mặc định của mặt hàng */
  uom?: string
  /** Số lô (SAP BatchNumbers) — truy xuất nguồn gốc */
  batchNumber?: string
  /** BOM: loại BOM của dòng cha (undefined = hàng thường) */
  bomType?: BomKind
  /** BOM: dòng thành phần con (giá 0, SL theo dòng cha) */
  isBomChild?: boolean
  bomGroupKey?: string
  bomEditable?: boolean
  bomQtyPerParent?: number
}

/** Trường BOM của dòng nạp từ phiếu đã lưu / prefill */
const bomFromSaved = (l: { isBomChild?: boolean | null; bomGroupKey?: string | null; bomEditable?: boolean | null; bomQtyPerParent?: number | null; bomType?: string | null }) => ({
  isBomChild: l.isBomChild ?? false,
  bomGroupKey: l.bomGroupKey ?? undefined,
  bomEditable: l.bomEditable ?? true,
  bomQtyPerParent: l.bomQtyPerParent ?? undefined,
  ...(l.bomType === 'template' || l.bomType === 'production' || l.bomType === 'assembly' ? { bomType: l.bomType as BomKind } : {}),
})
/** Giữ bomType đã có (từ API), chỉ suy từ dòng con khi thiếu */
const withBomTypes = (ls: FormLine[]): FormLine[] => {
  const inferred = inferBomTypes(ls)
  return inferred.map((l, i) => (ls[i].bomType && l.bomGroupKey ? { ...l, bomType: ls[i].bomType } : l))
}

let keyCounter = 0
const nextKey = () => ++keyCounter

/** Ép CK dòng về 0–100 */
const clampDisc = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0)
/** Thành tiền dòng SAU chiết khấu — khớp công thức server (làm tròn từng dòng) */
const afterDiscTotal = (l: FormLine) => {
  const lt = Math.round(l.quantity * l.unitPrice)
  return lt - Math.round((lt * clampDisc(l.discPct)) / 100)
}

interface Props {
  /** Id phiếu cần sửa — có nghĩa là đang ở chế độ CẬP NHẬT */
  deliveryId?: string
  onSaved: (id: string) => void
  onCancel: () => void
}

export default function DeliveryFormView({ deliveryId, onSaved, onCancel }: Props) {
  const isEdit = Boolean(deliveryId)

  const [partner, setPartner] = useState<ACOption | null>(null)
  const [partnerErr, setPartnerErr] = useState('')
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [remarks, setRemarks] = useState('')
  const [lines, setLines] = useState<FormLine[]>([
    { key: nextKey(), item: null, quantity: 1, unitPrice: 0, taxCode: undefined, discPct: 0 },
  ])
  const [loading, setLoading] = useState(isEdit)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  /** Optimistic locking version (chế độ sửa) */
  const [version, setVersion] = useState<number | undefined>(undefined)
  /** Chế độ sửa: phiếu có liên kết đơn nguồn không (có → khóa thêm/xóa dòng) */
  const [hasSourceOrder, setHasSourceOrder] = useState(false)
  /** "Sao chép từ…" (copy-from): mở picker + thông tin nguồn đã chọn */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copyFromInfo, setCopyFromInfo] = useState<PrefillDoc | null>(null)
  // Kho hàng xuất bán (OWHS) — mặc định áp dụng cho toàn bộ dòng hàng
  const [warehouses, setWarehouses] = useState<{ warehouseCode: string; warehouseName: string }[]>([])
  const [headerWh, setHeaderWh] = useState('')
  // ---------- Thông tin B2B / SAP B1 (Đợt 2+3) ----------
  const [b2b, setB2b] = useState<B2BFormState>(() => defaultB2BForm(new Date().toISOString().slice(0, 10)))
  const setB2bField = <K extends keyof B2BFormState>(key: K, value: B2BFormState[K]) =>
    setB2b((b) => ({ ...b, [key]: value }))
  /** NVBH: GET /api/sales-persons → [{code, name}]; 404/lỗi → ô nhập số (fallback) */
  const [salesPersons, setSalesPersons] = useState<{ code: number; name: string }[]>([])
  const [spListFailed, setSpListFailed] = useState(false)
  /** ĐKTT: GET /api/payment-terms → [{code, name}]; 404/lỗi → ô nhập số (fallback) */
  const [paymentTerms, setPaymentTerms] = useState<{ code: number; name: string }[]>([])
  const [ptListFailed, setPtListFailed] = useState(false)
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: DiscountPercent) — trừ vào tổng phiếu */
  const [headerDiscPct, setHeaderDiscPct] = useState(0)
  /** Ghi chú soạn/đóng gói (SAP PickAndPackNotes) */
  const [pickAndPackNotes, setPickAndPackNotes] = useState('')

  // Đổi ngày chứng từ → Ngày tính thuế (SAP TaxDate) mặc định theo;
  // chỉ tự đồng bộ khi user chưa sửa tay ô Ngày tính thuế
  const onDocDateChange = (v: string) => {
    setDocDate(v)
    setB2b((b) => (b.taxDateManual ? b : { ...b, taxDate: v }))
  }

  // ---- "Sao chép từ…" (copy-from): điền dữ liệu prefill (?prefill=1) vào form ----
  // Chỉ dùng khi TẠO phiếu mới. SL từng dòng = SL còn mở (OpenQty) của đơn nguồn.
  // Giữ nguyên kho của chứng từ nguồn (header + từng dòng).
  const applyCopyFrom = (p: PrefillDoc) => {
    setPartner({ code: p.cardCode, name: p.cardName })
    setDocDate((p.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setRemarks(p.remarks ?? '')
    const wh = p.warehouseCode ?? ''
    setHeaderWh(wh)
    setHeaderDiscPct(0)
    setPickAndPackNotes('')
    // Copy-from: mang theo B2B của chứng từ nguồn (nếu API prefill có trả)
    setB2b(b2bFromSaved((p.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10), p as unknown as Parameters<typeof b2bFromSaved>[1]))
    setLines(withBomTypes(
      (p.lines ?? []).map((l) => ({
        key: nextKey(),
        item: { code: l.itemCode, name: l.itemName, barcode: l.barcode || undefined },
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? 0,
        taxCode: l.taxCode ?? undefined,
        discPct: l.discPct ?? 0,
        uom: l.uom || undefined,
        warehouseCode: (l.warehouseCode ?? wh) || undefined,
        ...bomFromSaved(l),
      })),
    ))
    setPartnerErr('')
    setSaveError('')
    setCopyFromInfo(p)
    setPickerOpen(false)
  }

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
        /* chưa cấu hình SAP / lỗi mạng — để trống, user vẫn tạo phiếu được */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Đổi kho trên header → áp dụng cho TẤT CẢ dòng hàng
  const applyHeaderWarehouse = (code: string) => {
    setHeaderWh(code)
    setLines((ls) => ls.map((l) => ({ ...l, warehouseCode: code || undefined })))
  }

  // ---- B2B: tải danh mục NVBH (SalesPersons) — lỗi/404 → dùng ô nhập số (fallback) ----
  useEffect(() => {
    let cancelled = false
    api('/api/sales-persons')
      .then(async (r) => {
        if (cancelled) return
        if (!r.ok) { setSpListFailed(true); return }
        const j = await r.json().catch(() => null)
        const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []
        const rows = arr
          .map((x: { code?: unknown; name?: unknown }) => ({ code: Number(x.code), name: String(x.name ?? '') }))
          .filter((x: { code: number }) => Number.isFinite(x.code))
        setSalesPersons(rows)
        if (rows.length === 0) setSpListFailed(true)
      })
      .catch(() => { if (!cancelled) setSpListFailed(true) })
    return () => { cancelled = true }
  }, [])

  // ---- B2B: tải danh mục ĐKTT (PaymentTerms) — lỗi/404 → dùng ô nhập số (fallback) ----
  useEffect(() => {
    let cancelled = false
    api('/api/payment-terms')
      .then(async (r) => {
        if (cancelled) return
        if (!r.ok) { setPtListFailed(true); return }
        const j = await r.json().catch(() => null)
        const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []
        const rows = arr
          .map((x: { code?: unknown; name?: unknown }) => ({ code: Number(x.code), name: String(x.name ?? '') }))
          .filter((x: { code: number }) => Number.isFinite(x.code))
        setPaymentTerms(rows)
        if (rows.length === 0) setPtListFailed(true)
      })
      .catch(() => { if (!cancelled) setPtListFailed(true) })
    return () => { cancelled = true }
  }, [])

  // ---- Địa chỉ giao/ghi hóa đơn + người liên hệ của KH đã chọn ----
  // Chọn KH → tự điền mặc định của KH; người dùng vẫn đổi được trên form.
  const party = useBpB2BInfo(partner?.code, (update) =>
    setB2b((b) => ({ ...b, ...update({ shipToCode: b.shipToCode, billToCode: b.billToCode, contactPersonCode: b.contactPersonCode }) })),
  )

  // Tải phiếu khi ở chế độ sửa
  useEffect(() => {
    if (!deliveryId) return
    let cancelled = false
    setLoading(true)
    api(`/api/deliveries/${deliveryId}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return
        const d = j?.delivery ?? j
        if (!ok || !d) {
          setLoadError(j?.error ?? 'Không tải được phiếu giao hàng')
          return
        }
        setPartner({ code: d.cardCode, name: d.cardName })
        const docDateStr = String(d.docDate ?? '').slice(0, 10)
        setDocDate(docDateStr)
        setRemarks(d.remarks ?? '')
        setVersion(d.version)
        setHeaderWh(d.warehouseCode ?? '')
        setHasSourceOrder(Boolean(d.sourceOrderId ?? d.sourceOrder?.id))
        setHeaderDiscPct(typeof d.headerDiscPct === 'number' ? d.headerDiscPct : 0)
        setPickAndPackNotes(d.pickAndPackNotes ?? '')
        setB2b(b2bFromSaved(docDateStr, d))
        setLines(withBomTypes(
          (d.lines ?? []).map((l: { id: string; itemCode: string; itemName: string; barcode?: string | null; quantity: number; unitPrice: number; taxCode?: string | null; discPct?: number; warehouseCode?: string | null; uom?: string | null; batchNumber?: string | null; isBomChild?: boolean | null; bomGroupKey?: string | null; bomEditable?: boolean | null; bomQtyPerParent?: number | null; bomType?: string | null }) => ({
            key: nextKey(),
            dbId: l.id,
            item: { code: l.itemCode, name: l.itemName, barcode: l.barcode || undefined },
            quantity: l.quantity,
            unitPrice: l.unitPrice ?? 0,
            taxCode: l.taxCode ?? undefined,
            discPct: l.discPct ?? 0,
            uom: l.uom || undefined,
            warehouseCode: (l.warehouseCode ?? d.warehouseCode ?? '') || undefined,
            batchNumber: l.batchNumber ?? undefined,
            ...bomFromSaved(l),
          })),
        ))
      })
      .catch(() => {
        if (!cancelled) setLoadError('Không kết nối được máy chủ')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [deliveryId])

  const setLine = (key: number, patch: Partial<FormLine>) => {
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l))
      // Đổi SL dòng cha BOM → SL con = SL cha × định mức
      return patch.quantity !== undefined ? applyParentQty(next, key, patch.quantity) : next
    })
  }

  /** Nhóm BOM đang thu gọn (ẩn dòng con trên bảng — vẫn lưu bình thường) */
  const [bomCollapsed, setBomCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  /** Cài đặt: hiện con BOM Production/Assembly */
  const showLockedBom = useShowLockedBomChildren()
  const toggleBomGroup = (gk: string) =>
    setBomCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(gk)) next.delete(gk)
      else next.add(gk)
      return next
    })

  // ---------- BOM: chọn mặt hàng BOM → bung thành phần con (giá 0, SL = SL cha × định mức) ----------
  const expandBom = async (parentKey: number, itemCode: string) => {
    const def = itemCode ? await fetchBomDef(itemCode) : null
    setLines((ls) => {
      const parent = ls.find((l) => l.key === parentKey)
      // Người dùng đã đổi sang mặt hàng khác trong lúc chờ → bỏ qua
      if (!parent || (parent.item?.code ?? '') !== itemCode) return ls
      if (!def && !parent.bomGroupKey) return ls
      return explodeBom(ls, parentKey, def, (c, p, groupKey) => ({
        key: nextKey(),
        item: { code: c.childItemCode, name: c.childItemName || c.childItemCode, uom: c.uom || '' },
        quantity: roundQty((Number(p.quantity) || 0) * Number(c.qtyPerParent || 0)),
        unitPrice: 0, // thành phần con giá luôn = 0
        discPct: 0,
        uom: c.uom || undefined,
        warehouseCode: p.warehouseCode || headerWh || undefined,
        isBomChild: true,
        bomGroupKey: groupKey,
        bomEditable: def!.bomType === 'template',
        bomQtyPerParent: Number(c.qtyPerParent || 0),
      })).lines
    })
  }

  /** Chọn mặt hàng: gợi ý đơn giá, mã thuế, đơn vị tính từ danh mục (user vẫn sửa được); BOM → bung con */
  const selectItem = (key: number, v: ACOption | null) => {
    setLines((ls) => ls.map((l) => (l.key === key
      ? { ...l, item: v, unitPrice: v?.price ?? l.unitPrice, taxCode: v?.taxCode || l.taxCode, uom: v?.uom || l.uom }
      : l)))
    void expandBom(key, v?.code ?? '')
  }
  /**
   * Thêm nhiều mặt hàng 1 lượt (dán danh sách / đặt lại đơn cũ): mỗi dòng đi qua
   * selectItem như khi chọn tay → giá, thuế, ĐVT, kho.
   */
  const addItemsBatch = (entries: { item: ACOption; quantity: number }[]) => {
    const fresh = entries.map((e) => ({
      key: nextKey(), item: null, quantity: e.quantity, unitPrice: 0, taxCode: undefined, discPct: 0,
      warehouseCode: headerWh || undefined,
    }))
    setLines((ls) => [...ls.filter((x) => x.item || x.isBomChild), ...fresh])
    fresh.forEach((nl, i) => selectItem(nl.key, entries[i].item))
  }

  /** Thêm dòng nhanh: điền vào dòng trống đầu tiên (nếu có) hoặc thêm dòng mới cuối bảng */
  const quickAddLine = (v: ACOption, quantity: number) => {
    const empty = lines.find((l) => !l.item && !l.isBomChild)
    const key = empty?.key ?? nextKey()
    setLines((ls) =>
      empty
        ? ls.map((l) => (l.key === key ? { ...l, quantity } : l))
        : [...ls, { key, item: null, quantity, unitPrice: 0, taxCode: undefined, discPct: 0, warehouseCode: headerWh || undefined }],
    )
    selectItem(key, v)
  }
  const removeLine = (key: number) => {
    setLines((ls) => {
      // Xóa dòng cha BOM → xóa cả nhóm thành phần con
      const next = removeWithBom(ls, key)
      return next.length > 0 ? next : ls
    })
  }

  /** Phiếu tạo từ đơn hàng (chế độ sửa): chỉ sửa SL, không thêm/xóa/đổi mặt hàng */
  const canEditLines = !isEdit || !hasSourceOrder
  const lineTotal = (l: FormLine) => afterDiscTotal(l)
  /** Tổng các dòng SAU chiết khấu dòng (chưa trừ CK đầu chứng từ) */
  const subTotal = lines.reduce((s, l) => s + lineTotal(l), 0)
  /** Tiền CK đầu chứng từ (SAP DiscountPercent) — làm tròn, trừ vào tổng phiếu */
  const headerDiscAmt = Math.round((subTotal * clampDisc(headerDiscPct)) / 100)
  const grandTotal = subTotal - headerDiscAmt
  /** Thuế suất theo mặt hàng (chỉ có khi vừa chọn từ danh mục) — phiếu giao không lưu VAT%, SAP tự tính khi đẩy */
  const lineVatPct = (l: FormLine) => (typeof l.item?.vatRate === 'number' ? clampDisc(l.item.vatRate) : undefined)
  const lineVatAmt = (l: FormLine) => Math.round((lineTotal(l) * (lineVatPct(l) ?? 0)) / 100)
  /** Thuế tạm tính — cùng công thức màn chi tiết (trừ phần CK đầu chứng từ) */
  const vatTotal = Math.round(lines.reduce((s, l) => s + lineVatAmt(l), 0) * (1 - clampDisc(headerDiscPct) / 100))
  const docTotal = grandTotal + vatTotal
  const totalBeforeDisc = lines.reduce((s, l) => s + Math.round(l.quantity * l.unitPrice), 0)
  const lineCols = canEditLines ? 15 : 14
  const totalRows: [string, string, string][] = [
    ['before', 'Tổng trước chiết khấu:', formatVND(totalBeforeDisc)],
    ['disc', 'Chiết khấu các dòng:', totalBeforeDisc > subTotal ? `−${formatVND(totalBeforeDisc - subTotal)}` : formatVND(0)],
    ...(headerDiscAmt > 0 ? [['hdisc', `Chiết khấu đầu chứng từ (${headerDiscPct}%):`, `−${formatVND(headerDiscAmt)}`] as [string, string, string]] : []),
    ['after', 'Sau chiết khấu:', formatVND(grandTotal)],
    ['vat', 'Thuế các dòng (tạm tính):', formatVND(vatTotal)],
  ]

  const validate = (): boolean => {
    setPartnerErr('')
    setSaveError('')
    if (!partner) {
      setPartnerErr('Vui lòng chọn khách hàng')
      return false
    }
    if (!docDate) {
      setSaveError('Vui lòng chọn ngày chứng từ')
      return false
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.item) {
        setSaveError(`Dòng ${i + 1}: vui lòng chọn mặt hàng`)
        return false
      }
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) {
        setSaveError(`Dòng ${i + 1} (${l.item.code}): số lượng phải > 0`)
        return false
      }
      if (l.isBomChild) continue
      if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
        setSaveError(`Dòng ${i + 1} (${l.item.code}): đơn giá không hợp lệ`)
        return false
      }
      if (!Number.isFinite(l.discPct) || l.discPct < 0 || l.discPct > 100) {
        setSaveError(`Dòng ${i + 1} (${l.item.code}): chiết khấu phải từ 0 đến 100%`)
        return false
      }
    }
    return true
  }

  // Phím tắt nhập liệu: Alt+N/Alt+K, Ctrl+Enter lưu, Ctrl+Shift+Enter lưu nháp, Enter giữa các dòng, ?
  const shortcuts = useFormShortcuts({
    onSave: () => void handleSave(),
    onSaveDraft: !isEdit ? () => void handleSave(true) : undefined,
    disabled: saving,
  })

  const handleSave = async (asDraft = false) => {
    if (saving || !validate()) return
    // B2B / SAP B1: validate + dựng payload (tỷ giá bắt buộc > 0 khi tiền tệ ≠ VND)
    const { payload: b2bPayload, error: b2bError } = buildB2BPayload(b2b)
    if (b2bError) {
      setSaveError(b2bError)
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      if (isEdit) {
        // Sửa: PUT nhận SL dòng + mã thuế + CK dòng + ngày/ghi chú/kho/số lô
        // + các trường header B2B mới (khách hàng và dòng hàng giữ nguyên khi có đơn nguồn)
        // Nếu đang sửa bản nháp thì giữ nguyên trạng thái nháp
        const body: Record<string, unknown> = {
          version,
          docDate,
          remarks: remarks.trim() || null,
          warehouseCode: headerWh || null,
          headerDiscPct: clampDisc(headerDiscPct),
          pickAndPackNotes: pickAndPackNotes.trim() || null,
          ...b2bPayload,
          lines: lines.map((l) => ({
            id: l.dbId,
            quantity: l.quantity,
            taxCode: l.taxCode || null,
            discPct: clampDisc(l.discPct),
            warehouseCode: l.warehouseCode || headerWh || undefined,
            uom: l.uom?.trim() || l.item?.uom || '',
            batchNumber: l.batchNumber?.trim() || null,
          })),
        }
        const r = await api(`/api/deliveries/${deliveryId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) {
          setSaveError(j.error ?? 'Không lưu được phiếu giao hàng')
          return
        }
        onSaved(deliveryId!)
      } else {
        const r = await api(`/api/deliveries${asDraft ? '?draft=true' : ''}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cardCode: partner!.code,
            cardName: partner!.name,
            docDate,
            remarks: remarks.trim() || undefined,
            warehouseCode: headerWh || undefined,
            headerDiscPct: clampDisc(headerDiscPct),
            pickAndPackNotes: pickAndPackNotes.trim() || undefined,
            ...b2bPayload,
            lines: lines.map((l) => ({
              itemCode: l.item!.code,
              itemName: l.item!.name,
              barcode: l.item!.barcode || undefined,
              uom: l.uom?.trim() || l.item!.uom || '',
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              taxCode: l.taxCode || undefined,
              discPct: clampDisc(l.discPct),
              warehouseCode: l.warehouseCode || headerWh || undefined,
              batchNumber: l.batchNumber?.trim() || undefined,
              isBomChild: l.isBomChild || undefined,
              bomGroupKey: l.bomGroupKey || undefined,
              bomEditable: l.bomEditable,
              bomQtyPerParent: l.bomQtyPerParent,
            })),
          }),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) {
          setSaveError(j.error ?? 'Không tạo được phiếu giao hàng')
          return
        }
        const id = j.delivery?.id ?? j.id
        if (!id) {
          setSaveError('Máy chủ không trả về id phiếu')
          return
        }
        onSaved(id)
      }
    } catch {
      setSaveError('Không kết nối được máy chủ')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader
          breadcrumb={['Chức năng chính', 'Giao hàng', isEdit ? 'Chỉnh sửa' : 'Tạo mới']}
          title={isEdit ? 'Chỉnh sửa phiếu giao hàng' : 'Tạo phiếu giao hàng'}
        />
        <div className="fm-empty">Đang tải…</div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div>
        <PageHeader
          breadcrumb={['Chức năng chính', 'Giao hàng', 'Chỉnh sửa']}
          title="Chỉnh sửa phiếu giao hàng"
          actions={<button className="fm-btn fm-btn--secondary" onClick={onCancel}><ArrowLeft size={16} /> Quay lại</button>}
        />
        <div className="fm-alert fm-alert--error" role="alert">{loadError}</div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Giao hàng', isEdit ? 'Chỉnh sửa' : 'Tạo mới']}
        title={isEdit ? 'Chỉnh sửa phiếu giao hàng' : 'Tạo phiếu giao hàng'}
        actions={<>
          <button className="fm-btn fm-btn--secondary" onClick={onCancel} disabled={saving}>
            <ArrowLeft size={16} /> Quay lại
          </button>
          {!isEdit && (
            <>
              <button
                className="fm-btn fm-btn--secondary"
                onClick={() => setPickerOpen(true)}
                disabled={saving}
                title="Sao chép dữ liệu từ đơn hàng bán (không tạo phiếu ngay)"
              >
                <Copy size={16} /> Sao chép từ…
              </button>
              <button className="fm-btn fm-btn--secondary" onClick={() => void handleSave(true)} disabled={saving}>
                <Save size={16} /> {saving ? 'Đang lưu nháp…' : 'Lưu nháp'}
              </button>
            </>
          )}
          <button className="fm-btn fm-btn--primary" onClick={() => void handleSave()} disabled={saving}>
            <Save size={16} /> {saving ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Tạo phiếu giao hàng'}
          </button>
        </>}
      />

      {/* "Sao chép từ…" (copy-from): dữ liệu đã điền sẵn từ chứng từ nguồn */}
      {!isEdit && copyFromInfo && (
        <div className="fm-alert fm-alert--info" role="status" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>
            <b>Tạo từ {copyFromInfo.sourceLabel}
              {copyFromInfo.sourceDocNum != null ? ` #${copyFromInfo.sourceDocNum}` : ''} — {copyFromInfo.cardName}</b>
            {' '}— dữ liệu đã điền sẵn (số lượng = số lượng còn mở của đơn nguồn). Kiểm tra lại rồi bấm Lưu.
          </div>
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => setPickerOpen(true)} disabled={saving}>
            Đổi nguồn
          </button>
          <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => setCopyFromInfo(null)} disabled={saving}>
            Xóa
          </button>
        </div>
      )}
      {pickerOpen && (
        <CopyFromPicker targetType="delivery" onPick={applyCopyFrom} onClose={() => setPickerOpen(false)} />
      )}

      {saveError && (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>{saveError}</div>
      )}

      <div className="fm-card" style={{ marginBottom: 12 }}>
        <h2 className="fm-card__title">Thông tin chung</h2>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label">Khách hàng <span className="fm-required">*</span></label>
            {isEdit ? (
              <div className="fm-input" style={{ background: 'var(--fm-bg-2)' }} aria-label="Khách hàng (không đổi được)">
                {partner ? `${partner.code} — ${partner.name}` : '—'}
              </div>
            ) : (
              <Autocomplete
                label="Khách hàng"
                hideLabel
                required
                placeholder="Tìm mã / tên khách hàng…"
                fetchUrl="/api/partners"
                value={partner}
                onChange={(v) => {
                  // người dùng chọn KH khác → điền địa chỉ/người liên hệ mặc định của KH mới
                  if (v?.code !== partner?.code) party.requestDefaults()
                  setPartner(v)
                  // Giá tự giải theo Price List 1 khi chọn khách hàng mới (mirror order-form)
                  if (v?.price) {
                    setLines((ls) => ls.map((l) => ({ ...l, unitPrice: l.unitPrice || v.price || 0 })))
                  }
                }}
                error={partnerErr}
                disabled={saving}
              />
            )}
            {isEdit && <div className="fm-hint">Không đổi được khách hàng trên phiếu đã tạo</div>}
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="dl-docdate">Ngày chứng từ <span className="fm-required">*</span></label>
            <input
              id="dl-docdate"
              type="date"
              className="fm-input"
              value={docDate}
              onChange={(e) => onDocDateChange(e.target.value)}
              disabled={saving}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="dl-header-wh" title="Kho xuất hàng (OWHS) — mặc định áp dụng cho toàn bộ dòng hàng">Kho xuất hàng</label>
            <select
              id="dl-header-wh"
              className="fm-input"
              value={headerWh}
              onChange={(e) => applyHeaderWarehouse(e.target.value)}
              disabled={saving || warehouses.length === 0}
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
            <label className="fm-label" htmlFor="dl-header-disc" title="Chiết khấu áp dụng cho TOÀN BỘ phiếu (SAP: DiscountPercent) — trừ vào tổng phiếu">Chiết khấu đầu chứng từ (%)</label>
            <input
              id="dl-header-disc"
              type="number"
              className="fm-input"
              min={0}
              max={100}
              step="any"
              inputMode="decimal"
              placeholder="0"
              value={headerDiscPct || ''}
              onChange={(e) => setHeaderDiscPct(clampDisc(parseFloat(e.target.value) || 0))}
              disabled={saving}
            />
          </div>
          <div className="fm-field" style={{ gridColumn: '1 / -1' }}>
            <label className="fm-label" htmlFor="dl-pickpack" title="Ghi chú soạn/đóng gói hàng (SAP: PickAndPackNotes)">Ghi chú soạn/đóng gói</label>
            <textarea
              id="dl-pickpack"
              className="fm-input"
              rows={2}
              value={pickAndPackNotes}
              onChange={(e) => setPickAndPackNotes(e.target.value)}
              placeholder="Hướng dẫn soạn hàng, đóng gói…"
              disabled={saving}
              maxLength={500}
            />
          </div>
          <div className="fm-field" style={{ gridColumn: '1 / -1' }}>
            <label className="fm-label" htmlFor="dl-remarks">Ghi chú</label>
            <textarea
              id="dl-remarks"
              className="fm-input"
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Ghi chú thêm trên phiếu giao hàng…"
              disabled={saving}
            />
          </div>
        </div>
      </div>

      {/* Thông tin B2B / SAP B1 (Đợt 2+3) */}
      <B2BFieldsSection
        b2b={b2b}
        onChange={setB2bField}
        saving={saving}
        idPrefix="dl-b2b"
        salesPersons={salesPersons}
        spListFailed={spListFailed}
        paymentTerms={paymentTerms}
        ptListFailed={ptListFailed}
        partyInfo={party.info}
        partyLoading={party.loading}
        hasPartner={!!partner}
      />

      <div className="fm-card" style={{ marginBottom: 12 }}>
        <h2 className="fm-card__title">Dòng hàng</h2>
        {isEdit && hasSourceOrder && (
          <div className="fm-hint" style={{ marginBottom: 8 }}>
            Phiếu tạo từ đơn hàng bán — chỉ sửa được số lượng từng dòng, không thêm/xóa dòng.
          </div>
        )}
        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
        <table className="fm-table fm-stack-table fm-stack-table--form fm-line-table">
          <thead>
            <tr>
              <th className="fm-col-no">#</th>
              <th className="fm-col-code">Mã hàng</th>
              <th className="fm-col-name">Tên hàng</th>
              <th className="fm-col-barcode" title="Mã vạch (BarCode) của mặt hàng — quét/gõ mã vạch ở ô tìm để chọn nhanh">Barcode</th>
              <th className="fm-col-qty fm-num">Số lượng</th>
              <th className="fm-col-uom" title="Đơn vị tính (MeasureUnit) — để trống để SAP dùng mặc định của mặt hàng">Đơn vị tính</th>
              <th className="fm-col-wh" title="Kho xuất của dòng (WarehouseCode) — mặc định theo kho header">Kho</th>
              <th className="fm-col-batch" title="Số lô (SAP: BatchNumbers) — truy xuất nguồn gốc">Số lô</th>
              <th className="fm-col-price fm-num">Đơn giá</th>
              <th className="fm-col-disc fm-num" title="Chiết khấu áp dụng riêng cho dòng này">CK (%)</th>
              <th className="fm-col-money fm-num">Sau chiết khấu</th>
              <th className="fm-col-tax" title="Mã nhóm thuế SAP (VatGroup) · thuế suất theo mặt hàng">Thuế</th>
              <th className="fm-col-money fm-num" title="Tạm tính theo thuế suất của mặt hàng — SAP tính lại khi đẩy phiếu">Tiền thuế</th>
              <th className="fm-col-total fm-num">Tiền dòng (sau thuế)</th>
              {canEditLines && <th className="fm-col-del"><span className="fm-sr-only">Xóa dòng</span></th>}
            </tr>
          </thead>
          <tbody>
            {(() => {
            const vis = visibleBomLines(lines, bomCollapsed, showLockedBom)
            const childCounts = bomChildCounts(lines)
            const parentTypes = bomParentTypes(lines)
            const parentCodes = new Map(
              lines.filter((x) => !x.isBomChild && x.bomGroupKey).map((x) => [x.bomGroupKey as string, x.item?.code ?? '']),
            )
            const parentCount = lines.filter((x) => !x.isBomChild).length
            let stt = 0
            return vis.map((l) => {
              const isChild = Boolean(l.isBomChild)
              if (!isChild) stt += 1
              const i = stt - 1
              const showToggle = !isChild && (l.bomType === 'template' || (showLockedBom && Boolean(l.bomType ?? parentTypes.get(l.bomGroupKey as string)))) && (childCounts.get(l.bomGroupKey as string) ?? 0) > 0
              const lockedBySource = isEdit && hasSourceOrder
              /** Dòng con BOM: giá/CK/thuế = 0, SL theo dòng cha — chỉ sửa kho/số lô */
              const lockedPrice = lockedBySource || isChild
              const afterDisc = lineTotal(l)
              const vatPct = isChild ? undefined : lineVatPct(l)
              const vatAmt = isChild ? 0 : lineVatAmt(l)
              const uomText = l.uom || l.item?.uom || ''
              return (
              <tr key={l.key} className={`${l.item ? '' : 'is-draft'}${isChild ? ' is-bom-child' : ''}${!isChild && l.bomGroupKey ? ' is-bom-parent' : ''}`}>
                <td data-label="Dòng">
                  <div className="fm-bom-parent-no">
                    {showToggle && (
                      <BomToggle
                        collapsed={bomCollapsed.has(l.bomGroupKey as string)}
                        count={childCounts.get(l.bomGroupKey as string) ?? 0}
                        parentLabel={l.item?.code ?? ''}
                        onToggle={() => toggleBomGroup(l.bomGroupKey as string)}
                      />
                    )}
                    {!isChild && <span className="fm-line-no">{stt}</span>}
                  </div>
                </td>
                <td data-label="Mã hàng" data-full className="fm-line-code">
                  {isChild ? (
                    <BomChildCell
                      code={l.item?.code}
                      qtyPerParent={l.bomQtyPerParent}
                      uom={uomText}
                      parentCode={parentCodes.get(l.bomGroupKey as string)}
                      disabled={saving}
                    />
                  ) : !canEditLines ? (
                    <div className="fm-line-item-text"><b>{l.item?.code ?? '—'}</b></div>
                  ) : (
                    <div className="fm-line-code__pick">
                      <Autocomplete
                        label={`Mặt hàng dòng ${i + 1}`}
                        hideLabel
                        placeholder="Gõ mã hàng, tên hàng hoặc quét barcode…"
                        fetchUrl="/api/items"
                        value={l.item}
                        onChange={(v) => selectItem(l.key, v)}
                        disabled={saving}
                      />
                    </div>
                  )}
                </td>
                <td data-label="Tên hàng" className="fm-line-name" title={l.item?.name || undefined}>{l.item?.name || '—'}</td>
                <td data-label="Barcode" className="fm-line-barcode">{l.item?.barcode || '—'}</td>
                <td data-label="Số lượng" className="fm-num">
                  {isChild ? (
                    <span
                      className="fm-line-locked-qty"
                      title="Thành phần BOM: số lượng theo dòng cha × định mức (đổi số lượng dòng cha để quy đổi)"
                      aria-label={`Số lượng thành phần ${l.item?.code ?? ''} (theo dòng cha)`}
                    >
                      {formatNum(l.quantity)}
                    </span>
                  ) : (
                  <input
                    type="number"
                    className="fm-line-input"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: parseFloat(e.target.value) || 0 })}
                    disabled={saving}
                    aria-label={`Số lượng dòng ${i + 1}`}
                  />
                  )}
                </td>
                <td data-label="Đơn vị tính">
                  {l.item ? (
                    <input
                      type="text"
                      className="fm-line-input fm-line-input--uom"
                      value={uomText}
                      onChange={(e) => setLine(l.key, { uom: e.target.value || undefined })}
                      disabled={saving}
                      title="Đơn vị tính (MeasureUnit) — để trống để SAP dùng mặc định của mặt hàng"
                      aria-label={`Đơn vị tính dòng ${i + 1}`}
                    />
                  ) : '—'}
                </td>
                <td data-label="Kho">
                  <select
                    className="fm-line-select"
                    value={l.warehouseCode ?? headerWh ?? ''}
                    disabled={saving || warehouses.length === 0}
                    title="Kho xuất của dòng (WarehouseCode) — mặc định theo kho header"
                    aria-label={`Kho dòng ${i + 1}`}
                    onChange={(e) => setLine(l.key, { warehouseCode: e.target.value || undefined })}
                  >
                    <option value="">—</option>
                    {warehouses.map((w) => (
                      <option key={w.warehouseCode} value={w.warehouseCode}>{w.warehouseCode}</option>
                    ))}
                  </select>
                </td>
                <td data-label="Số lô">
                  <input
                    type="text"
                    className="fm-line-input"
                    value={l.batchNumber ?? ''}
                    placeholder="—"
                    onChange={(e) => setLine(l.key, { batchNumber: e.target.value.trim() || undefined })}
                    disabled={saving || lockedBySource || !l.item}
                    maxLength={50}
                    title="Số lô (SAP: BatchNumbers) — truy xuất nguồn gốc"
                    aria-label={`Số lô dòng ${i + 1}`}
                  />
                </td>
                <td data-label="Đơn giá" className="fm-num">
                  <input
                    type="number"
                    className="fm-line-input"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={l.unitPrice}
                    onChange={(e) => setLine(l.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                    disabled={saving || lockedPrice}
                    aria-label={`Đơn giá dòng ${i + 1}`}
                  />
                </td>
                <td data-label="CK (%)" className="fm-num">
                  <input
                    type="number"
                    className="fm-line-input fm-line-input--pct"
                    min={0}
                    max={100}
                    step="any"
                    inputMode="decimal"
                    value={l.discPct || ''}
                    placeholder="0"
                    onChange={(e) => setLine(l.key, { discPct: clampDisc(parseFloat(e.target.value) || 0) })}
                    disabled={saving || lockedPrice}
                    aria-label={`Chiết khấu % dòng ${i + 1}`}
                  />
                </td>
                <td data-label="Sau chiết khấu" className="fm-num">{l.item ? formatVND(afterDisc) : '—'}</td>
                <td data-label="Thuế" className="fm-line-tax">
                  <div className="fm-line-tax__edit">
                    <input
                      type="text"
                      className="fm-line-input fm-line-input--tax"
                      value={l.taxCode ?? ''}
                      placeholder="—"
                      onChange={(e) => setLine(l.key, { taxCode: e.target.value.trim() || undefined })}
                      disabled={saving || lockedPrice}
                      title="Mã nhóm thuế SAP (VatGroup)"
                      aria-label={`Mã thuế dòng ${i + 1}`}
                    />
                    {vatPct !== undefined && <span title="Thuế suất theo mặt hàng">· {vatPct}%</span>}
                  </div>
                </td>
                <td data-label="Tiền thuế" className="fm-num">{l.item && vatPct !== undefined ? formatVND(vatAmt) : '—'}</td>
                <td className="fm-num fm-line-total" data-label="Tiền dòng (sau thuế)">{l.item ? formatVND(afterDisc + vatAmt) : '—'}</td>
                {canEditLines && (
                  <td data-label="Xóa dòng">
                    <button
                      type="button"
                      className="fm-row-del"
                      onClick={() => removeLine(l.key)}
                      disabled={saving || (!isChild && parentCount <= 1)}
                      title="Xóa dòng"
                      aria-label={`Xóa dòng ${i + 1}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
              )
            })
            })()}
          </tbody>
          <tfoot className="fm-line-foot">
            {totalRows.map(([k, label, value]) => (
              <tr key={k}>
                <td colSpan={lineCols - (canEditLines ? 2 : 1)} className="fm-num">{label}</td>
                <td className="fm-num">{value}</td>
                {canEditLines && <td />}
              </tr>
            ))}
            <tr className="fm-detail-total">
              <td colSpan={lineCols - (canEditLines ? 2 : 1)} className="fm-num"><b>Tổng chứng từ:</b></td>
              <td className="fm-num"><b>{formatVND(docTotal)}</b></td>
              {canEditLines && <td />}
            </tr>
          </tfoot>
        </table>
        </div>
        {canEditLines && <LineQuickAdd onAdd={quickAddLine} onAddMany={addItemsBatch} disabled={saving} />}
        <div className="fm-totals fm-totals--mobile">
          {totalRows.map(([k, label, value]) => (
            <div key={k} className="fm-totals__row"><span>{label.replace(/:$/, '')}</span><b>{value}</b></div>
          ))}
          <div className="fm-totals__grand"><span>Tổng chứng từ</span><span>{formatVND(docTotal)}</span></div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', position: 'sticky', bottom: 0, background: 'var(--fm-bg)', padding: '12px 0' }}>
        <ShortcutHelp open={shortcuts.helpOpen} onOpen={shortcuts.openHelp} onClose={shortcuts.closeHelp} />
        <button className="fm-btn fm-btn--secondary" onClick={onCancel} disabled={saving}>Hủy bỏ</button>
        {!isEdit && (
          <button className="fm-btn fm-btn--secondary" onClick={() => void handleSave(true)} disabled={saving}>
            <Save size={16} /> {saving ? 'Đang lưu nháp…' : 'Lưu nháp'}
          </button>
        )}
        <button className="fm-btn fm-btn--primary" onClick={() => void handleSave()} disabled={saving}>
          <Save size={16} /> {saving ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Tạo phiếu giao hàng'}
        </button>
      </div>
    </div>
  )
}
