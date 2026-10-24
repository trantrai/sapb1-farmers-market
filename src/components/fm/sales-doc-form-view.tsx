'use client'

// ============================================================
// FORM tạo/sửa chứng từ Sales A/R dùng chung cho 4 loại Phase 1:
// Báo giá bán hàng · Hóa đơn bán hàng · Phiếu ghi có phải thu · Phiếu trả hàng bán
// Mirror theo order-form-view: autocomplete khách hàng/mặt hàng, giá tự
// giải (OSPP → Price List 1), VAT theo mã thuế, tính tổng bằng order-calc
// (khớp từng đồng với máy chủ), 409 VERSION_CONFLICT có nút tải lại.
// Hỗ trợ tạo từ chứng từ nguồn (from-source) với banner "Tạo từ …".
// Hỗ trợ "Sao chép từ…" (copy-from) trên form tạo mới: picker chọn chứng từ
// nguồn → API ?prefill=1 trả dữ liệu điền sẵn (không tạo chứng từ ngay).
// ============================================================

import { Fragment, useEffect, useEffectEvent, useMemo, useState } from 'react'
import { Plus, Trash2, Save, ShoppingCart, ShoppingBasket, BadgeCheck, RefreshCw, ArrowLeft, Wallet, Copy, Building2 } from 'lucide-react'
import Autocomplete, { ACOption } from './autocomplete'
import PageHeader from './page-header'
import { formatVND } from '@/lib/fm-shared'
import { calcOrderLines } from '@/lib/order-calc'
import { api } from '@/lib/fm-client'
import { parseMySalesPerson } from '@/lib/sales-person-default'
import CopyFromPicker from './copy-from-picker'
import { B2BPartyFields, useBpB2BInfo } from './b2b-party-fields'
import { ShortcutHelp, useFormShortcuts } from './form-shortcuts'
import BomSwapDialog, { useCanSwapBom } from './bom-swap-dialog'
import { LineDetailField, LineDetailRow, LineExpandButton, LineQuickAdd, useExpandedLines } from './line-items'
import {
  BomChildCell, BomToggle, applyParentQty, bomChildCounts, explodeBom, fetchBomDef,
  inferBomTypes, removeWithBom, roundQty, visibleBomLines, type BomKind,
} from './bom-lines'
import type { B2BPartySelection } from '@/lib/bp-b2b'

const EMPTY_PARTY: B2BPartySelection = { shipToCode: '', billToCode: '', contactPersonCode: '' }
import type { CopyFromTarget, PrefillDoc } from '@/lib/copy-from'
import {
  clampPct,
  DOC_TYPE_LABEL,
  docLabelFor,
  INVOICE_DOC_TYPE_OPTIONS,
  toEditDocData,
  unwrapDoc,
  type DocKindConfig,
  type DownPaymentDrawItem,
  type EditDocData,
} from './sales-doc-shared'

interface DraftLine {
  key: number
  item: ACOption | null
  quantity: number
  unitPrice: number
  discPct: number
  vatPct: number
  taxCode?: string
  uom?: string
  warehouseCode?: string
  /** CHẾ ĐỘ SỬA: id dòng local (chứng từ local) hoặc LineNum trên SAP (chứng từ SAP) */
  dbId?: string
  sapLineNum?: number
  /** Tương đương BaseLine của SAP: id dòng chứng từ nguồn */
  sourceLineId?: string | null
  /** Mã tài khoản kế toán (SAP: DocumentLines.AccountCode) — nhập tay cho dòng hóa đơn DỊCH VỤ */
  accountCode?: string
  /** Số lô (SAP BatchNumbers) — chỉ dòng Phiếu trả hàng bán (Đợt 2) */
  batchNumber?: string
  // ---------- BOM (xem bom-lines.tsx) ----------
  bomType?: BomKind
  isBomChild?: boolean
  bomGroupKey?: string
  bomEditable?: boolean
  bomQtyPerParent?: number
}

/** Trường BOM của dòng nạp từ chứng từ đã lưu / prefill */
const bomFromSaved = (l: { isBomChild?: boolean | null; bomGroupKey?: string | null; bomEditable?: boolean | null; bomQtyPerParent?: number | null }) => ({
  isBomChild: l.isBomChild ?? false,
  bomGroupKey: l.bomGroupKey ?? undefined,
  bomEditable: l.bomEditable ?? true,
  bomQtyPerParent: l.bomQtyPerParent ?? undefined,
})

let keyCounter = 0
const nextKey = () => ++keyCounter

/** Đợt 2 — Đính kèm chứng từ: [{name, url}] lưu vào cột attachmentsJson */
export interface AttachmentItem { name: string; url: string }


/** Parse attachmentsJson (string JSON) → danh sách hiển thị trên form */
function parseAttachmentsState(raw: string | null | undefined): AttachmentItem[] {
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return (arr as Record<string, unknown>[])
      .slice(0, 20)
      .map((a) => ({ name: String(a?.name ?? ''), url: String(a?.url ?? '') }))
      .filter((a) => a.name || a.url)
  } catch {
    return []
  }
}

interface Props {
  config: DocKindConfig
  /** Id chứng từ cần sửa — có nghĩa là đang ở chế độ CẬP NHẬT */
  initialId?: string
  /** Tạo từ chứng từ nguồn: 'quotation'|'order'|'delivery' (hóa đơn), 'invoice'|'return' (ghi có), 'delivery'|'invoice' (trả hàng) */
  sourceType?: string
  sourceId?: string
  /** "Sao chép từ…" (copy-from): loại chứng từ đích — hiện nút picker trên
   *  form TẠO mới (không xung đột với sourceType/sourceId của copy-to) */
  copyFromTarget?: CopyFromTarget
  onBack: () => void
  onSaved: (id: string) => void
  /** Id user đăng nhập (dự phòng cho các mở rộng sau) */
  userId?: string
}

export default function SalesDocFormView({ config, initialId, sourceType, sourceId, copyFromTarget, onBack, onSaved, userId }: Props) {
  const { apiBase, docLabel, fromSourceApi, enableDownPaymentDraws, enableDocType } = config
  void userId
  /** Id chứng từ vừa được tạo qua from-source — API tạo NGAY (201) rồi trả về,
   *  form chuyển sang chế độ SỬA trên chứng từ vừa tạo để user kiểm tra/chỉnh */
  const [createdId, setCreatedId] = useState<string | null>(null)
  const editId = initialId ?? createdId ?? undefined
  const isEdit = Boolean(editId)
  const isFromSource = Boolean(sourceType && sourceId && fromSourceApi)

  const [partner, setPartner] = useState<ACOption | null>(null)
  const [partnerErr, setPartnerErr] = useState('')
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [docDueDate, setDocDueDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 5)
    return d.toISOString().slice(0, 10)
  })
  const [remarks, setRemarks] = useState('')

  // ---- Đợt 2 — Thông tin B2B / SAP B1 trên header ----
  /** Nhân viên bán hàng (SAP SalesPersonCode) — dropdown /api/sales-persons, fallback nhập số tay */
  const [salesPersons, setSalesPersons] = useState<{ code: number; name: string }[]>([])
  const [salesPersonCode, setSalesPersonCode] = useState<number | null>(null)
  const [spFallback, setSpFallback] = useState(false)
  /** Điều khoản thanh toán (SAP PaymentGroupCode) — dropdown /api/payment-terms, fallback nhập số tay */
  const [paymentTerms, setPaymentTerms] = useState<{ code: number; name: string }[]>([])
  const [paymentGroupCode, setPaymentGroupCode] = useState<number | null>(null)
  const [ptFallback, setPtFallback] = useState(false)
  /** Số PO / tham chiếu của KH (SAP NumAtCard) */
  const [numAtCard, setNumAtCard] = useState('')
  /** Ngày tính thuế (SAP TaxDate) — mặc định = ngày chứng từ */
  const [taxDate, setTaxDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [taxDateTouched, setTaxDateTouched] = useState(false)
  /** Tiền tệ (SAP DocCurrency) + Tỷ giá (SAP DocRate) */
  const [docCurrency, setDocCurrency] = useState('VND')
  const [docRate, setDocRate] = useState(1)
  /** Mã dự án (SAP ProjectCode) */
  const [projectCode, setProjectCode] = useState('')
  /** Địa chỉ giao hàng / ghi hóa đơn + người liên hệ (SAP ShipToCode / BillToCode / ContactPersonCode) */
  const [partySel, setPartySel] = useState<B2BPartySelection>(EMPTY_PARTY)
  /** Đính kèm [{name,url}] (lưu vào attachmentsJson) */
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])

  // Ngày tính thuế mặc định bám theo ngày chứng từ cho tới khi user sửa tay
  const setDocDateAndTax = (v: string) => {
    setDocDate(v)
    if (!taxDateTouched) setTaxDate(v)
  }

  // Kho hàng (OWHS) — mặc định áp dụng cho toàn bộ dòng hàng
  const [warehouses, setWarehouses] = useState<{ warehouseCode: string; warehouseName: string }[]>([])
  const [headerWh, setHeaderWh] = useState('')
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) — áp cho toàn chứng từ */
  const [headerDiscPct, setHeaderDiscPct] = useState(0)
  /** Optimistic locking: version lúc mở form */
  const [version, setVersion] = useState<number | undefined>(undefined)
  /** Phase 2 — Loại hóa đơn ('Item' | 'Service' | 'Reserve'), chỉ form Hóa đơn bán hàng */
  const [docType, setDocType] = useState<string>('Item')
  /** Phase 2 — true = đang sửa bản NHÁP (hiển thị banner + nút chuyển chính thức) */
  const [isDraftDoc, setIsDraftDoc] = useState(false)
  /** Phase 2 — finalize (nháp → chính thức) đang chạy */
  const [finalizing, setFinalizing] = useState(false)
  /** Phase 2 — thông báo hành động (vd finalize thành công) */
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [lines, setLines] = useState<DraftLine[]>([
    { key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 },
  ])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** true = lỗi 409 VERSION_CONFLICT — banner hiện thêm nút "Tải lại" */
  const [versionConflict, setVersionConflict] = useState(false)
  const [reloading, setReloading] = useState(false)
  const [fieldErr, setFieldErr] = useState<Record<number, string>>({})

  /** Phase 2 — Khấu trừ đặt cọc trên form Hóa đơn: danh sách đặt cọc còn dư của KH */
  interface DrawOption { id: string; docNum: number; grandTotal: number; remaining: number }
  const [drawOpts, setDrawOpts] = useState<DrawOption[]>([])
  const [drawsLoading, setDrawsLoading] = useState(false)
  /** { downPaymentId: { checked, amount } } */
  const [drawSel, setDrawSel] = useState<Record<string, { checked: boolean; amount: number }>>({})

  /** Thông tin chứng từ nguồn khi tạo từ from-source */
  const [prefillInfo, setPrefillInfo] = useState<{ sourceLabel: string; sourceDocNum: number | null } | null>(null)
  const [prefillLoading, setPrefillLoading] = useState(false)
  const [prefillError, setPrefillError] = useState('')
  /** "Sao chép từ…" (copy-from): mở picker + dữ liệu nguồn đã chọn */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copyFrom, setCopyFrom] = useState<PrefillDoc | null>(null)

  // ---- Điền sẵn dữ liệu khi vào chế độ SỬA ----
  const applyEditData = (o: EditDocData) => {
    setPartner({ code: o.cardCode, name: o.cardName })
    setDocDate((o.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setDocDueDate((o.docDueDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setRemarks(o.remarks ?? '')
    setHeaderWh(o.warehouseCode ?? '')
    setHeaderDiscPct(o.headerDiscPct ?? 0)
    setVersion(o.version)
    setIsDraftDoc(o.isDraft ?? false)
    setDocType(o.docType || 'Item')
    // ---- Đợt 2 — Thông tin B2B / SAP B1 ----
    setSalesPersonCode(o.salesPersonCode ?? null)
    setPaymentGroupCode(o.paymentGroupCode ?? null)
    setNumAtCard(o.numAtCard ?? '')
    const dDate = (o.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    setTaxDate((o.taxDate || '').slice(0, 10) || dDate)
    setTaxDateTouched(Boolean(o.taxDate))
    setDocCurrency(o.docCurrency || 'VND')
    setDocRate(o.docRate && o.docRate > 0 ? o.docRate : 1)
    setProjectCode(o.projectCode ?? '')
    // Địa chỉ giao/ghi hóa đơn + người liên hệ đã lưu (giữ nguyên nếu còn thuộc KH)
    setPartySel({
      shipToCode: o.shipToCode ?? '',
      billToCode: o.billToCode ?? '',
      contactPersonCode: o.contactPersonCode != null ? String(o.contactPersonCode) : '',
    })
    setAttachments(parseAttachmentsState(o.attachmentsJson))
    // Khấu trừ đặt cọc đã gắn (chế độ sửa hóa đơn): đánh dấu sẵn, merge thêm
    // số dư còn lại khi danh sách đặt cọc của KH tải xong
    if (o.draws && o.draws.length > 0) {
      setDrawSel((cur) => {
        const next = { ...cur }
        for (const d of o.draws as DownPaymentDrawItem[]) {
          next[d.downPaymentId] = { checked: true, amount: d.drawAmount }
        }
        return next
      })
    }
    const prefilled: DraftLine[] = (o.lines ?? []).map((l) => ({
      key: nextKey(),
      item: { code: l.itemCode, name: l.itemName, uom: l.uom || '', taxCode: l.taxCode || '', barcode: (l as { barcode?: string | null }).barcode || undefined },
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct ?? 0,
      vatPct: l.vatPct ?? 0,
      taxCode: l.taxCode || undefined,
      uom: l.uom || undefined,
      warehouseCode: l.warehouseCode || o.warehouseCode || undefined,
      dbId: l.dbId,
      sapLineNum: l.sapLineNum,
      sourceLineId: l.sourceLineId ?? null,
      accountCode: l.accountCode ?? undefined,
      batchNumber: l.batchNumber ?? undefined,
      ...bomFromSaved(l),
    }))
    setLines(prefilled.length > 0 ? inferBomTypes(prefilled) : [{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 }])
    setError('')
    setPartnerErr('')
    setFieldErr({})
  }

  // ---- "Sao chép từ…" (copy-from): điền dữ liệu prefill (?prefill=1) vào form ----
  // Chỉ dùng khi TẠO chứng từ mới (không ở chế độ sửa, không ở chế độ copy-to
  // tạo-ngay). Giữ giá/CK/thuế/kho + cấu trúc BOM của nguồn; sourceLineId từng
  // dòng được giữ để lưu kèm khi bấm Lưu (tương đương BaseLine của SAP).
  const applyCopyFrom = (p: PrefillDoc) => {
    setPartner({ code: p.cardCode, name: p.cardName })
    const cDate = (p.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    setDocDate(cDate)
    setDocDueDate((p.docDueDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setRemarks(p.remarks ?? '')
    setHeaderWh(p.warehouseCode ?? '')
    setHeaderDiscPct(p.headerDiscPct ?? 0)
    // ---- Đợt 2 — Thông tin B2B / SAP B1 từ prefill (?prefill=1) ----
    // PrefillDoc chưa khai báo các trường mới (copy-from.ts do worker khác sở
    // hữu) nên đọc qua ép kiểu — thiếu thì dùng mặc định.
    const p2 = p as unknown as Record<string, unknown>
    const intOrNull = (v: unknown) => {
      const n = Number(v)
      return Number.isInteger(n) ? n : null
    }
    setSalesPersonCode(intOrNull(p2.salesPersonCode))
    setPaymentGroupCode(intOrNull(p2.paymentGroupCode))
    setNumAtCard(typeof p2.numAtCard === 'string' ? p2.numAtCard : '')
    // Ngày tính thuế của chứng từ mới: mặc định = ngày chứng từ mới
    setTaxDate(cDate)
    setTaxDateTouched(false)
    setDocCurrency(typeof p2.docCurrency === 'string' && p2.docCurrency ? p2.docCurrency : 'VND')
    const pRate = Number(p2.docRate)
    setDocRate(Number.isFinite(pRate) && pRate > 0 ? pRate : 1)
    setProjectCode(typeof p2.projectCode === 'string' ? p2.projectCode : '')
    setPartySel({
      shipToCode: typeof p2.shipToCode === 'string' ? p2.shipToCode : '',
      billToCode: typeof p2.billToCode === 'string' ? p2.billToCode : '',
      contactPersonCode: typeof p2.contactPersonCode === 'number' ? String(p2.contactPersonCode) : '',
    })
    setAttachments(parseAttachmentsState(typeof p2.attachmentsJson === 'string' ? p2.attachmentsJson : null))
    const prefilled: DraftLine[] = (p.lines ?? []).map((l) => ({
      key: nextKey(),
      item: { code: l.itemCode, name: l.itemName, uom: l.uom || '', taxCode: l.taxCode || '', barcode: (l as { barcode?: string | null }).barcode || undefined },
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct ?? 0,
      vatPct: l.vatPct ?? 8,
      taxCode: l.taxCode || undefined,
      uom: l.uom || undefined,
      warehouseCode: l.warehouseCode || p.warehouseCode || undefined,
      sourceLineId: l.sourceLineId ?? null,
      accountCode: l.accountCode ?? undefined,
      batchNumber: (l as { batchNumber?: string | null }).batchNumber ?? undefined,
      ...bomFromSaved(l),
    }))
    setLines(prefilled.length > 0 ? inferBomTypes(prefilled) : [{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 }])
    setError('')
    setPartnerErr('')
    setFieldErr({})
    setCopyFrom(p)
    setPickerOpen(false)
  }

  // Tải dữ liệu đầu vào 1 lần khi mở form
  useEffect(() => {
    let cancelled = false
    if (isFromSource && fromSourceApi) {
      // API from-source TẠO CHỨNG TỪ NGAY (201) rồi trả về chứng từ đã tạo
      // (kèm dedupe chống bấm đúp phía máy chủ) — form chuyển sang chế độ sửa
      // trên chứng từ vừa tạo để user kiểm tra/chỉnh trước khi dùng tiếp
      setPrefillLoading(true)
      api(fromSourceApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType, sourceId }),
      })
        .then(async (res) => {
          const json = await res.json().catch(() => ({}))
          if (cancelled) return
          if (res.ok && json.ok) {
            const created = unwrapDoc(json, config)
            setCreatedId(created.id)
            applyEditData(toEditDocData(created))
            // Số chứng từ nguồn nằm trong remarks "Sao chép từ … #123"
            const m = /#(\d+)\s*$/.exec(created.remarks ?? '')
            setPrefillInfo({
              sourceLabel: DOC_TYPE_LABEL[sourceType ?? ''] ?? sourceType ?? 'chứng từ nguồn',
              sourceDocNum: m ? Number(m[1]) : null,
            })
          } else {
            setPrefillError(json.error ?? `Không tạo được ${docLabel} từ ${DOC_TYPE_LABEL[sourceType ?? ''] ?? 'chứng từ nguồn'}`)
          }
        })
        .catch(() => {
          if (!cancelled) setPrefillError('Không thể kết nối máy chủ')
        })
        .finally(() => { if (!cancelled) setPrefillLoading(false) })
    } else if (initialId) {
      api(`/api/${apiBase}/${initialId}`)
        .then(async (res) => {
          const json = await res.json().catch(() => ({}))
          if (cancelled) return
          if (res.ok) {
            applyEditData(toEditDocData(unwrapDoc(json, config)))
          } else {
            setError(json.error ?? `Không tải được ${docLabel} để sửa`)
          }
        })
        .catch(() => {
          if (!cancelled) setError('Không thể kết nối máy chủ')
        })
    }
    return () => { cancelled = true }
  }, [])

  // ---- Kho hàng: tải danh sách kho ----
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
        /* chưa cấu hình SAP / lỗi mạng — để trống, vẫn nhập chứng từ được */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // ---- Đợt 2 — Nhân viên bán hàng: /api/sales-persons (worker khác triển khai
  // song song). 404/lỗi/rỗng → fallback nhập mã số tay để không chặn nhập liệu ----
  // Chứng từ MỚI (không sao chép từ nguồn): tự điền NVKD gắn với user (mine) nếu ô còn trống
  const applyMySlp = useEffectEvent((mine: number | null) => {
    if (!isEdit && !sourceId && mine !== null) setSalesPersonCode((c) => c ?? mine)
  })
  useEffect(() => {
    let cancelled = false
    api('/api/sales-persons')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        const rows = (Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []) as { code?: unknown; name?: unknown }[]
        const list = rows
          .map((r) => ({ code: Number(r.code), name: String(r.name ?? '') }))
          .filter((r) => Number.isInteger(r.code))
        if (list.length > 0) setSalesPersons(list)
        else setSpFallback(true)
        applyMySlp(parseMySalesPerson(j))
      })
      .catch(() => { if (!cancelled) setSpFallback(true) })
    return () => { cancelled = true }
  }, [])

  // ---- Đợt 2 — Điều khoản thanh toán: /api/payment-terms (worker khác triển khai
  // song song). 404/lỗi/rỗng → fallback nhập mã số tay ----
  useEffect(() => {
    let cancelled = false
    api('/api/payment-terms')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        const rows = (Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : []) as { code?: unknown; name?: unknown }[]
        const list = rows
          .map((r) => ({ code: Number(r.code), name: String(r.name ?? '') }))
          .filter((r) => Number.isInteger(r.code))
        if (list.length > 0) setPaymentTerms(list)
        else setPtFallback(true)
      })
      .catch(() => { if (!cancelled) setPtFallback(true) })
    return () => { cancelled = true }
  }, [])

  // ---- Địa chỉ giao/ghi hóa đơn + người liên hệ của KH đã chọn ----
  // Chọn KH → tự điền mặc định của KH; người dùng vẫn đổi được trên form.
  const party = useBpB2BInfo(partner?.code, setPartySel)

  // ---- Phase 2 — Khấu trừ đặt cọc: tải đặt cọc còn dư của khách hàng ----
  // Chỉ khi form Hóa đơn (enableDownPaymentDraws) và đã chọn KH. Lọc
  // remainingAmount > 0 ở phía máy khách để không phụ thuộc filter của API.
  useEffect(() => {
    if (!enableDownPaymentDraws) return
    if (!partner?.code) {
      setDrawOpts([])
      return
    }
    let cancelled = false
    setDrawsLoading(true)
    // API list chỉ hỗ trợ ?q= (tìm theo số/tên/mã KH) — lọc chính xác cardCode
    // + remainingAmount > 0 ở phía máy khách
    api(`/api/down-payments?q=${encodeURIComponent(partner.code)}&pageSize=100`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        const rows = (j?.data ?? []) as { id: string; docNum: number; cardCode?: string; grandTotal: number; remainingAmount?: number | string | null; isDraft?: boolean }[]
        setDrawOpts(
          rows
            .filter((d) => !d.isDraft && (!d.cardCode || d.cardCode === partner.code) && Number(d.remainingAmount ?? 0) > 0)
            .map((d) => ({ id: d.id, docNum: d.docNum, grandTotal: d.grandTotal, remaining: Number(d.remainingAmount ?? 0) })),
        )
      })
      .catch(() => {
        if (!cancelled) setDrawOpts([])
      })
      .finally(() => {
        if (!cancelled) setDrawsLoading(false)
      })
    return () => { cancelled = true }
  }, [enableDownPaymentDraws, partner?.code])

  // Đổi kho trên header → áp dụng cho TẤT CẢ dòng hàng
  const applyHeaderWarehouse = (code: string) => {
    setHeaderWh(code)
    setLines((ls) => ls.map((l) => ({ ...l, warehouseCode: code || undefined })))
  }

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

  /** Phase 2 — tổng khấu trừ đặt cọc đã tick + tổng phải thu sau khấu trừ */
  const drawTotals = useMemo(() => {
    if (!enableDownPaymentDraws) return { totalDraw: 0, payable: totals.grand }
    let totalDraw = 0
    for (const o of drawOpts) {
      const s = drawSel[o.id]
      if (s?.checked) totalDraw += Math.max(0, s.amount || 0)
    }
    // Đặt cọc đã gắn từ trước nhưng KH không còn dư (không có trong options) vẫn tính
    for (const [id, s] of Object.entries(drawSel)) {
      if (s.checked && !drawOpts.some((o) => o.id === id)) totalDraw += Math.max(0, s.amount || 0)
    }
    return { totalDraw, payable: totals.grand - totalDraw }
  }, [enableDownPaymentDraws, drawOpts, drawSel, totals.grand])

  const updateLine = (key: number, patch: Partial<DraftLine>) => {
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l))
      // Đổi SL dòng cha BOM → SL con = SL cha × định mức
      return patch.quantity !== undefined ? applyParentQty(next, key, patch.quantity) : next
    })
    setFieldErr((fe) => ({ ...fe, [key]: '' }))
  }

  /** Nhóm BOM đang thu gọn (ẩn dòng con trên bảng — vẫn lưu/đẩy SAP bình thường) */
  const [bomCollapsed, setBomCollapsed] = useState<ReadonlySet<string>>(() => new Set())
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
        unitPrice: 0, // thành phần con giá bán luôn = 0
        discPct: 0,
        vatPct: 0,
        uom: c.uom || undefined,
        warehouseCode: p.warehouseCode || headerWh || undefined,
        isBomChild: true,
        bomGroupKey: groupKey,
        bomEditable: def!.bomType === 'template',
        bomQtyPerParent: Number(c.qtyPerParent || 0),
      })).lines
    })
  }

  /** Dòng đang mở chi tiết (ĐVT, kho, thuế, số lô…) */
  const expandedLines = useExpandedLines()

  /**
   * Chọn mặt hàng cho dòng: tự load đơn giá (Price List 1 / OSPP), VAT% (qua mã thuế),
   * mã nhóm thuế (SalesVATGroup), đơn vị tính (SalesUnit) + KHO theo header;
   * mặt hàng BOM → bung thành phần con; bỏ chọn → gỡ nhóm con cũ.
   */
  const selectItem = (key: number, v: ACOption | null) => {
    const cur = lines.find((l) => l.key === key)
    const vat = typeof v?.vatRate === 'number' ? v.vatRate : null
    const wh = cur?.warehouseCode || headerWh || undefined
    updateLine(key, {
      item: v,
      unitPrice: v?.price ?? 0,
      taxCode: v?.taxCode || undefined,
      uom: v?.uom || undefined,
      warehouseCode: wh,
      ...(vat !== null ? { vatPct: vat } : {}),
    })
    if (v) void resolvePrice(key, v.code, partner?.code ?? null)
    void expandBom(key, v?.code ?? '')
  }

  // ---------- BOM Template: hoán đổi thành phần con với mặt hàng khác ----------
  const [swapKey, setSwapKey] = useState<number | null>(null)
  /** Quyền hoán đổi thành phần BOM (Ủy quyền → Hoán đổi thành phần BOM → Sửa) */
  const canSwapBom = useCanSwapBom()
  const swapTarget = swapKey != null ? lines.find((x) => x.key === swapKey && x.isBomChild) ?? null : null
  const swapParentCode = swapTarget
    ? lines.find((x) => !x.isBomChild && x.bomGroupKey === swapTarget.bomGroupKey)?.item?.code
    : undefined
  /** Xác nhận hoán đổi: thay mã thành phần + nạp tên/ĐVT/mã thuế/barcode; giữ SL, định mức, giá 0, nhóm BOM */
  const swapBomComponent = (key: number, v: ACOption) => {
    updateLine(key, {
      item: v,
      uom: v.uom || undefined,
      taxCode: v.taxCode || undefined,
      ...(typeof v.vatRate === 'number' ? { vatPct: v.vatRate } : {}),
    })
    setSwapKey(null)
  }

  /**
   * Thêm nhiều mặt hàng 1 lượt (dán danh sách / đặt lại đơn cũ): mỗi dòng đi qua
   * selectItem như khi chọn tay → giá, thuế, ĐVT, kho, bung BOM.
   */
  const addItemsBatch = (entries: { item: ACOption; quantity: number }[]) => {
    const fresh = entries.map((e) => ({
      key: nextKey(), item: null, quantity: e.quantity, unitPrice: 0, discPct: 0, vatPct: 8,
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
        : [...ls, { key, item: null, quantity, unitPrice: 0, discPct: 0, vatPct: 8, warehouseCode: headerWh || undefined }],
    )
    selectItem(key, v)
  }
  const removeLine = (key: number) => {
    setLines((ls) => {
      // Xóa dòng cha BOM → xóa cả nhóm thành phần con
      const next = removeWithBom(ls, key)
      return next.length > 0
        ? next
        : [{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8, warehouseCode: headerWh || undefined }]
    })
  }

  // Giải đơn giá: GIÁ ĐẶC BIỆT theo Mặt hàng + Khách hàng (OSPP) → không có → Price List 1
  const resolvePrice = async (key: number, itemCode: string, cardCode: string | null) => {
    try {
      const qs = new URLSearchParams({ itemCode })
      if (cardCode) qs.set('cardCode', cardCode)
      const res = await api(`/api/items/price?${qs.toString()}`)
      const json = await res.json()
      if (json?.ok && typeof json.price === 'number' && json.price > 0) {
        setLines((ls) =>
          ls.map((l) => (l.key === key && l.item?.code === itemCode ? { ...l, unitPrice: json.price } : l)),
        )
      }
    } catch {
      /* giữ nguyên đơn giá hiện tại */
    }
  }

  /** Phase 2 — asDraft=true → gọi API với ?draft=true (lưu nháp) */
  // Phím tắt nhập liệu: Alt+N/Alt+K, Ctrl+Enter lưu, Ctrl+Shift+Enter lưu nháp, Enter giữa các dòng, ?
  const shortcuts = useFormShortcuts({
    onSave: () => void save(isDraftDoc),
    onSaveDraft: !isEdit ? () => void save(true) : undefined,
    disabled: saving || prefillLoading,
  })

  const save = async (asDraft = false) => {
    setError('')
    setActionMsg(null)
    setVersionConflict(false)
    setPartnerErr('')
    if (!partner) { setPartnerErr('Vui lòng chọn khách hàng từ danh sách'); return }
    const valid = lines.filter((l) => l.item && l.quantity > 0)
    if (valid.length === 0) {
      setError(`${docLabel} cần ít nhất 1 dòng hàng hóa có mã hàng và số lượng > 0`)
      return
    }
    const negPrice = valid.find((l) => l.unitPrice < 0)
    if (negPrice) {
      setError(`Đơn giá không được âm (dòng ${negPrice.item?.code ?? ''}) — hãy sửa lại trước khi lưu`)
      return
    }
    // Hóa đơn dịch vụ: mọi dòng bắt buộc có mã Tài khoản (SAP: AccountCode)
    if (showAccountCol) {
      const missingIdx = valid.findIndex((l) => !l.accountCode?.trim())
      if (missingIdx >= 0) {
        setError(`Hóa đơn dịch vụ: dòng ${missingIdx + 1} (${valid[missingIdx].item?.code ?? ''}) thiếu mã Tài khoản — vui lòng nhập Tài khoản cho mọi dòng (SAP B1 bắt buộc AccountCode với dòng dịch vụ)`)
        return
      }
    }
    // Phase 2 — validate khấu trừ đặt cọc: tổng khấu trừ ≤ tổng hóa đơn,
    // từng khoản ≤ số dư còn lại của đặt cọc đó
    // (contract API: draws = [{ downPaymentId, drawAmount }] — WORKER A)
    let drawPayload: { downPaymentId: string; drawAmount: number }[] = []
    if (enableDownPaymentDraws) {
      for (const o of drawOpts) {
        const s = drawSel[o.id]
        if (!s?.checked) continue
        const amt = Math.round((s.amount || 0) * 100) / 100
        if (amt <= 0) {
          setError(`Số tiền khấu trừ đặt cọc #${o.docNum} phải lớn hơn 0`)
          return
        }
        if (amt > o.remaining + 1e-9) {
          setError(`Số tiền khấu trừ đặt cọc #${o.docNum} (${formatVND(amt)}) vượt số dư còn lại (${formatVND(o.remaining)})`)
          return
        }
        drawPayload.push({ downPaymentId: o.id, drawAmount: amt })
      }
      if (drawTotals.totalDraw > totals.grand + 1e-9) {
        setError(`Tổng khấu trừ đặt cọc (${formatVND(drawTotals.totalDraw)}) vượt quá tổng hóa đơn (${formatVND(totals.grand)})`)
        return
      }
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
        // Đợt 2 — Thông tin B2B / SAP B1 trên header
        salesPersonCode,
        paymentGroupCode,
        numAtCard: numAtCard.trim() || undefined,
        taxDate: taxDate || docDate,
        docCurrency: (docCurrency.trim() || 'VND').toUpperCase(),
        docRate: docRate > 0 ? docRate : 1,
        projectCode: projectCode.trim() || undefined,
        shipToCode: partySel.shipToCode || undefined,
        billToCode: partySel.billToCode || undefined,
        contactPersonCode: partySel.contactPersonCode ? Number(partySel.contactPersonCode) : null,
        attachments: attachments.length > 0
          ? attachments.map((a) => ({ name: a.name.trim(), url: a.url.trim() })).filter((a) => a.name || a.url)
          : undefined,
        // Phase 2 — loại hóa đơn (Item | Service | Reserve)
        ...(enableDocType ? { docType } : {}),
        // Phase 2 — khấu trừ đặt cọc
        ...(enableDownPaymentDraws ? { draws: drawPayload } : {}),
        // API yêu cầu optimistic locking version ở chế độ sửa (thiếu → 400 VERSION_REQUIRED)
        ...(isEdit && typeof version === 'number' ? { version } : {}),
        lines: valid.map((l) => ({
          itemCode: l.item!.code,
          itemName: l.item!.name,
          barcode: l.item!.barcode || undefined,
          uom: l.uom?.trim() || l.item!.uom?.trim() || 'kg',
          taxCode: l.taxCode || l.item!.taxCode || undefined,
          warehouseCode: l.warehouseCode || headerWh || undefined,
          quantity: l.quantity,
          unitPrice: l.isBomChild ? 0 : l.unitPrice,
          discPct: l.isBomChild ? 0 : clampPct(l.discPct),
          vatPct: clampPct(l.vatPct),
          sourceLineId: l.sourceLineId ?? null,
          // BOM: SL con là SL người dùng đã chỉnh — đẩy SAP đúng SL này
          isBomChild: l.isBomChild ?? false,
          bomGroupKey: l.bomGroupKey ?? null,
          bomEditable: l.bomEditable ?? true,
          bomQtyPerParent: l.bomQtyPerParent ?? null,
          // Mã tài khoản kế toán (dòng hóa đơn dịch vụ) — API validate bắt buộc
          accountCode: l.accountCode?.trim() || undefined,
          // Số lô (SAP BatchNumbers) — chỉ phiếu trả hàng (Đợt 2)
          batchNumber: l.batchNumber?.trim() || undefined,
        })),
      }
      // API dùng PATCH cho cập nhật (2 chế độ: sửa toàn bộ / đóng-mở-hủy nhanh)
      // Phase 2 — lưu nháp: gọi với ?draft=true
      const url = isEdit ? `/api/${apiBase}/${editId}` : `/api/${apiBase}`
      const res = await api(asDraft ? `${url}?draft=true` : url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        // 409 VERSION_CONFLICT: chứng từ đã bị sửa bởi người khác
        if (res.status === 409 && json.code === 'VERSION_CONFLICT') {
          setVersionConflict(true)
          setError(`${docLabel} đã bị sửa bởi người khác — vui lòng tải lại chứng từ rồi thử lại`)
        } else {
          setError(json.error ?? (isEdit ? `Không thể cập nhật ${docLabel}` : `Không thể tạo ${docLabel}`))
        }
        return
      }
      const d = unwrapDoc(json, config)
      onSaved(d.id)
    } catch {
      setError('Không thể kết nối máy chủ')
    } finally {
      setSaving(false)
    }
  }

  // Tải lại dữ liệu mới nhất của chứng từ sau xung đột 409
  const reloadLatest = async () => {
    if (!isEdit || !editId) return
    setReloading(true)
    try {
      const r = await api(`/api/${apiBase}/${editId}`)
      if (r.ok) {
        const j = await r.json()
        applyEditData(toEditDocData(unwrapDoc(j, config)))
        setVersionConflict(false)
        setError('')
      } else {
        setError('Không tải được dữ liệu mới nhất — hãy thử lại')
      }
    } catch {
      setError('Không thể kết nối máy chủ')
    } finally {
      setReloading(false)
    }
  }

  // Phase 2 — Chuyển bản nháp thành chứng từ chính thức
  // (contract: PATCH /api/{base}/{id}/finalize { version } — do WORKER A triển khai)
  const finalize = async () => {
    if (!isEdit || !editId || finalizing) return
    setFinalizing(true)
    setActionMsg(null)
    try {
      const res = await api(`/api/${apiBase}/${editId}/finalize`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: version ?? 0 }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        setActionMsg({ type: 'error', text: json.error ?? `Không thể chuyển ${docLabel} thành chứng từ chính thức` })
        return
      }
      setActionMsg({ type: 'success', text: `Đã chuyển ${docLabel} #${json[config.docKey]?.docNum ?? ''} thành chứng từ chính thức.` })
      setIsDraftDoc(false)
      if (json[config.docKey]) applyEditData(toEditDocData(unwrapDoc(json, config)))
    } catch {
      setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setFinalizing(false)
    }
  }

  const dl = docLabelFor(config, docType)
  // Hóa đơn dịch vụ (docType=Service → SAP dDocument_Service): mỗi dòng hiện
  // ô "Tài khoản" — chưa có API /api/accounts nên dùng text input + validate không rỗng
  const showAccountCol = enableDocType && docType === 'Service'
  // Đợt 2 — Phiếu trả hàng bán: mỗi dòng thêm cột "Số lô" (SAP BatchNumbers)
  const showBatchCol = config.showBatchNumberCol === true
  /** Địa chỉ giao hàng (type 'S') và ghi hóa đơn (type 'B') — ẩn khi không có */
  const title = isEdit ? `Cập nhật ${dl}` : `Tạo ${dl} mới`
  const crumb = isEdit ? `Sửa ${dl}` : `Tạo ${dl} mới`

  // M4: paddingBottom = chỗ cuộn thêm để sticky action bar không che nội dung cuối form
  return (
    <div style={{ paddingBottom: 96 }}>
      <PageHeader
        breadcrumb={['Chức năng chính', crumb]}
        title={title}
      />

      {/* Banner tạo từ chứng từ nguồn */}
      {isFromSource && prefillInfo && (
        <div className="fm-alert fm-alert--info" style={{ marginBottom: 14 }} role="status">
          <div>
            <b>Tạo từ {prefillInfo.sourceLabel}
              {prefillInfo.sourceDocNum != null ? ` #${prefillInfo.sourceDocNum}` : ''}</b>
            {' '}— chứng từ đã được tạo sẵn từ chứng từ nguồn (dòng hàng giữ giá/CK/thuế/kho).
            Kiểm tra lại rồi bấm Lưu để cập nhật.
          </div>
        </div>
      )}
      {prefillLoading && (
        <div className="fm-alert fm-alert--info" style={{ marginBottom: 14 }} role="status" aria-busy="true">
          Đang tải dữ liệu từ chứng từ nguồn…
        </div>
      )}
      {prefillError && (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 14 }}>
          {prefillError}
        </div>
      )}

      {/* "Sao chép từ…" (copy-from): dữ liệu đã điền sẵn từ chứng từ nguồn */}
      {!isEdit && !isFromSource && copyFrom && copyFromTarget && (
        <div className="fm-alert fm-alert--info" role="status" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>
            <b>Tạo từ {copyFrom.sourceLabel}
              {copyFrom.sourceDocNum != null ? ` #${copyFrom.sourceDocNum}` : ''} — {copyFrom.cardName}</b>
            {' '}— dữ liệu đã điền sẵn (giữ giá/CK/thuế/kho của chứng từ nguồn). Kiểm tra lại rồi bấm Lưu.
          </div>
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => setPickerOpen(true)} disabled={saving}>
            Đổi nguồn
          </button>
          <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => setCopyFrom(null)} disabled={saving}>
            Xóa
          </button>
        </div>
      )}
      {pickerOpen && copyFromTarget && (
        <CopyFromPicker targetType={copyFromTarget} onPick={applyCopyFrom} onClose={() => setPickerOpen(false)} />
      )}

      {/* Phase 2 — banner bản nháp + nút chuyển thành chứng từ chính thức */}
      {isEdit && isDraftDoc && (
        <div className="fm-alert fm-alert--warning" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} role="status">
          <div style={{ flex: 1 }}>
            <b><span className="fm-chip fm-chip--warn">Nháp</span></b>{' '}
            Đây là bản nháp — chưa có hiệu lực, chưa đẩy được sang SAP B1.
          </div>
          <button
            type="button"
            className="fm-btn fm-btn--primary fm-btn--sm"
            onClick={() => void finalize()}
            disabled={finalizing || saving}
          >
            {finalizing ? 'Đang chuyển…' : 'Chuyển thành chứng từ chính thức'}
          </button>
        </div>
      )}
      {actionMsg && (
        <div className={`fm-alert ${actionMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={actionMsg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 14 }}>
          {actionMsg.text}
        </div>
      )}

      {error && (
        <div className="fm-alert fm-alert--error" role="alert">
          <div><b>{isEdit ? `Không thể cập nhật ${docLabel}` : `Không thể lưu ${docLabel}`}</b>{error}</div>
          {versionConflict && (
            <button
              type="button"
              className="fm-btn fm-btn--secondary fm-btn--sm fm-mt-2"
              onClick={() => void reloadLatest()}
              disabled={reloading}
            >
              <RefreshCw size={14} /> {reloading ? 'Đang tải…' : 'Tải lại dữ liệu mới nhất'}
            </button>
          )}
        </div>
      )}

      {/* Bước 1 — Khách hàng & thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingCart size={18} /> Bước 1 — Thông tin chung
        </h2>

        {!isEdit && !isFromSource && copyFromTarget && (
          <div style={{ marginBottom: 14 }}>
            <button
              type="button"
              className="fm-btn fm-btn--secondary fm-btn--sm"
              onClick={() => setPickerOpen(true)}
              disabled={saving}
              title="Sao chép dữ liệu từ chứng từ nguồn (không tạo chứng từ ngay)"
            >
              <Copy size={14} /> Sao chép từ…
            </button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1', maxWidth: 560 }}>
            <Autocomplete
              label="Khách hàng"
              required
              placeholder="Gõ mã khách hàng hoặc tên khách hàng…"
              fetchUrl="/api/partners"
              value={partner}
              disabled={saving}
              error={partnerErr || undefined}
              onChange={(v) => {
                // người dùng chọn KH khác → điền địa chỉ/người liên hệ mặc định của KH mới
                if (v?.code !== partner?.code) party.requestDefaults()
                setPartner(v)
                setPartnerErr('')
                // đổi khách hàng → tính lại giá cho các dòng chưa có đơn giá tay
                if (v) for (const line of lines) if (line.item && line.unitPrice === 0) void resolvePrice(line.key, line.item.code, v.code)
              }}
            />
          </div>
          <div>
            <label className="fm-label" htmlFor="fm-doc-date">Ngày chứng từ <span className="fm-label__req">*</span></label>
            <input id="fm-doc-date" type="date" className="fm-datepicker" value={docDate} disabled={saving} onChange={(e) => setDocDateAndTax(e.target.value)} />
          </div>
          <div>
            <label className="fm-label" htmlFor="fm-doc-due">Hạn <span className="fm-label__req">*</span></label>
            <input id="fm-doc-due" type="date" className="fm-datepicker" value={docDueDate} disabled={saving} onChange={(e) => setDocDueDate(e.target.value)} />
          </div>
          <div>
            <label className="fm-label" htmlFor="fm-header-wh" title="Kho hàng xuất bán (OWHS) — mặc định áp dụng cho toàn bộ dòng hàng">Kho hàng</label>
            <select
              id="fm-header-wh"
              className="fm-select"
              value={headerWh}
              disabled={saving}
              onChange={(e) => applyHeaderWarehouse(e.target.value)}
            >
              <option value="">— Chọn kho —</option>
              {warehouses.map((w) => (
                <option key={w.warehouseCode} value={w.warehouseCode}>{w.warehouseCode} — {w.warehouseName}</option>
              ))}
            </select>
          </div>
          {/* Phase 2 — Loại hóa đơn (docType của ArInvoice): Hàng hóa / Dịch vụ / Dự trữ */}
          {enableDocType && (
            <div>
              <label className="fm-label" htmlFor="fm-doc-type" title="Loại hóa đơn (SAP: Documents.DocType) — 'Dự trữ' tạo hóa đơn dự trữ (Reserve Invoice)">Loại hóa đơn</label>
              <select
                id="fm-doc-type"
                className="fm-select"
                value={docType}
                disabled={saving}
                onChange={(e) => setDocType(e.target.value)}
              >
                {INVOICE_DOC_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="fm-label" htmlFor="fm-header-disc" title="Chiết khấu đầu chứng từ % (SAP: Documents.DiscountPercent) — phân bổ về từng dòng">Chiết khấu đầu chứng từ (%)</label>
            <input
              id="fm-header-disc"
              type="number"
              min={0}
              max={100}
              step="any"
              className="fm-input"
              value={headerDiscPct || ''}
              disabled={saving}
              placeholder="0"
              onChange={(e) => setHeaderDiscPct(clampPct(Number(e.target.value) || 0))}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="fm-label" htmlFor="fm-remarks">Ghi chú</label>
            <textarea
              id="fm-remarks"
              className="fm-input"
              rows={2}
              placeholder="Ghi chú cho chứng từ…"
              value={remarks}
              disabled={saving}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Đợt 2 — Thông tin B2B / SAP B1 */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Building2 size={18} /> Thông tin B2B / SAP B1
        </h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {/* Nhân viên bán hàng (SAP SalesPersonCode) */}
          <div>
            <label className="fm-label" htmlFor="fm-sp" title="Nhân viên bán hàng (SAP: SalesPersonCode)">Nhân viên bán hàng</label>
            {spFallback ? (
              <input
                id="fm-sp"
                type="number"
                min={-1}
                step={1}
                className="fm-input"
                value={salesPersonCode ?? ''}
                disabled={saving}
                placeholder="Nhập mã NVBH…"
                title="Danh mục nhân viên chưa sẵn sàng — nhập mã số (SAP: SlpCode)"
                onChange={(e) => setSalesPersonCode(e.target.value === '' ? null : Math.trunc(Number(e.target.value)))}
              />
            ) : (
              <select
                id="fm-sp"
                className="fm-select"
                value={salesPersonCode ?? ''}
                disabled={saving}
                onChange={(e) => setSalesPersonCode(e.target.value === '' ? null : Number(e.target.value))}
              >
                <option value="">— Chưa chọn —</option>
                {salesPersons.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                ))}
              </select>
            )}
          </div>
          {/* Điều khoản thanh toán (SAP PaymentGroupCode) */}
          <div>
            <label className="fm-label" htmlFor="fm-pt" title="Điều khoản thanh toán (SAP: PaymentGroupCode)">Điều khoản thanh toán</label>
            {ptFallback ? (
              <input
                id="fm-pt"
                type="number"
                step={1}
                className="fm-input"
                value={paymentGroupCode ?? ''}
                disabled={saving}
                placeholder="Nhập mã ĐKTT…"
                title="Danh mục điều khoản chưa sẵn sàng — nhập mã số (SAP: GroupNum)"
                onChange={(e) => setPaymentGroupCode(e.target.value === '' ? null : Math.trunc(Number(e.target.value)))}
              />
            ) : (
              <select
                id="fm-pt"
                className="fm-select"
                value={paymentGroupCode ?? ''}
                disabled={saving}
                onChange={(e) => setPaymentGroupCode(e.target.value === '' ? null : Number(e.target.value))}
              >
                <option value="">— Chưa chọn —</option>
                {paymentTerms.map((t) => (
                  <option key={t.code} value={t.code}>{t.code} — {t.name}</option>
                ))}
              </select>
            )}
          </div>
          {/* Số PO của khách hàng (SAP NumAtCard) */}
          <div>
            <label className="fm-label" htmlFor="fm-po" title="Số tham chiếu / số PO của khách hàng (SAP: NumAtCard) — dùng được để tìm kiếm trong danh sách">Số PO của khách hàng</label>
            <input
              id="fm-po"
              className="fm-input"
              value={numAtCard}
              disabled={saving}
              placeholder="VD: PO-2026-118"
              maxLength={100}
              onChange={(e) => setNumAtCard(e.target.value)}
            />
          </div>
          {/* Ngày tính thuế (SAP TaxDate) — mặc định = ngày chứng từ */}
          <div>
            <label className="fm-label" htmlFor="fm-taxdate" title="Ngày tính thuế (SAP: TaxDate) — mặc định bằng ngày chứng từ, đổi ngày chứng từ sẽ tự kéo theo cho tới khi sửa tay">Ngày tính thuế</label>
            <input
              id="fm-taxdate"
              type="date"
              className="fm-datepicker"
              value={taxDate}
              disabled={saving}
              onChange={(e) => { setTaxDate(e.target.value); setTaxDateTouched(true) }}
            />
          </div>
          {/* Tiền tệ + Tỷ giá */}
          <div>
            <label className="fm-label" htmlFor="fm-curr" title="Tiền tệ chứng từ (SAP: DocCurrency)">Tiền tệ</label>
            <input
              id="fm-curr"
              className="fm-input"
              value={docCurrency}
              disabled={saving}
              maxLength={3}
              style={{ textTransform: 'uppercase' }}
              placeholder="VND"
              onChange={(e) => setDocCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))}
            />
          </div>
          <div>
            <label className="fm-label" htmlFor="fm-rate" title="Tỷ giá quy đổi về VND (SAP: DocRate)">Tỷ giá</label>
            <input
              id="fm-rate"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              className="fm-input"
              value={docRate || ''}
              disabled={saving}
              placeholder="1"
              onChange={(e) => setDocRate(Number(e.target.value) || 0)}
            />
          </div>
          {/* Mã dự án (SAP ProjectCode) */}
          <div>
            <label className="fm-label" htmlFor="fm-proj" title="Mã dự án (SAP: ProjectCode)">Mã dự án</label>
            <input
              id="fm-proj"
              className="fm-input"
              value={projectCode}
              disabled={saving}
              maxLength={50}
              placeholder="VD: PRJ-2026-01"
              onChange={(e) => setProjectCode(e.target.value)}
            />
          </div>
          {/* Người liên hệ + địa chỉ giao hàng / ghi hóa đơn — mặc định theo KH, cho phép đổi */}
          <B2BPartyFields
            value={partySel}
            onChange={(patch) => setPartySel((cur) => ({ ...cur, ...patch }))}
            info={party.info}
            loading={party.loading}
            disabled={saving}
            hasPartner={!!partner}
            idPrefix="fm-party"
          />
        </div>
        {/* Đính kèm [{name,url}] */}
        <div style={{ marginTop: 12 }}>
          <span className="fm-label" id="fm-attach-label">Đính kèm</span>
          <div role="group" aria-labelledby="fm-attach-label">
            {attachments.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  className="fm-input"
                  placeholder="Tên file / mô tả"
                  aria-label={`Tên đính kèm ${i + 1}`}
                  value={a.name}
                  disabled={saving}
                  maxLength={200}
                  onChange={(e) => setAttachments((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <input
                  className="fm-input"
                  placeholder="URL"
                  aria-label={`URL đính kèm ${i + 1}`}
                  value={a.url}
                  disabled={saving}
                  maxLength={2000}
                  style={{ flex: 2 }}
                  onChange={(e) => setAttachments((cur) => cur.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                />
                <button
                  type="button"
                  className="fm-row-del"
                  title="Xóa đính kèm"
                  aria-label={`Xóa đính kèm ${i + 1}`}
                  disabled={saving}
                  onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="fm-btn fm-btn--secondary fm-btn--sm"
              disabled={saving || attachments.length >= 20}
              onClick={() => setAttachments((cur) => [...cur, { name: '', url: '' }])}
            >
              <Plus size={14} /> Thêm đính kèm
            </button>
          </div>
        </div>
      </div>

      {/* Bước 2 — Dòng hàng hóa */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingBasket size={18} /> Bước 2 — Hàng hóa
        </h2>

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
          <table className="fm-table fm-stack-table fm-stack-table--form fm-line-table">
            <thead>
              <tr>
                <th className="fm-col-no">#</th>
                <th style={{ minWidth: 240 }}>Hàng hóa</th>
                <th className="fm-col-barcode" title="Mã vạch (BarCode) của mặt hàng — quét/gõ mã vạch ở ô tìm để chọn nhanh">Barcode</th>
                {showAccountCol && (
                  <th style={{ width: 120 }} title="Mã tài khoản kế toán (SAP: DocumentLines.AccountCode) — bắt buộc với hóa đơn dịch vụ">Tài khoản *</th>
                )}
                <th className="fm-col-qty fm-num">Số lượng</th>
                <th className="fm-col-price fm-num">Đơn giá (₫)</th>
                <th className="fm-col-disc fm-num" title="Chiết khấu áp dụng riêng cho dòng này">CK (%)</th>
                <th className="fm-col-total fm-num">Thành tiền (₫)</th>
                <th className="fm-col-del"><span className="fm-sr-only">Xóa dòng</span></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const vis = visibleBomLines(lines, bomCollapsed)
                const childCounts = bomChildCounts(lines)
                const parentCodes = new Map(
                  lines.filter((x) => !x.isBomChild && x.bomGroupKey).map((x) => [x.bomGroupKey as string, x.item?.code ?? '']),
                )
                const colCount = 8 + (showAccountCol ? 1 : 0)
                let stt = 0
                return vis.map((l) => {
                const isChild = Boolean(l.isBomChild)
                if (!isChild) stt += 1
                const idx = stt - 1
                const lineNo = stt
                const showToggle = !isChild && l.bomType === 'template' && (childCounts.get(l.bomGroupKey as string) ?? 0) > 0
                const invalid = Boolean(fieldErr[l.key])
                const qtyInvalid = Boolean(l.item) && l.quantity <= 0
                const priceInvalid = l.unitPrice < 0
                const acctInvalid = showAccountCol && Boolean(l.item) && !l.accountCode?.trim()
                const lineTotal = l.quantity * l.unitPrice
                const discAmt = Math.round((lineTotal * clampPct(l.discPct)) / 100)
                const afterDisc = lineTotal - discAmt
                const detailId = `fm-line-detail-${l.key}`
                const expanded = expandedLines.isOpen(l.key)
                const uomText = l.uom || l.item?.uom || ''
                const whText = l.warehouseCode || headerWh || ''
                const taxText = l.taxCode || l.item?.taxCode || ''
                return (
                  <Fragment key={l.key}>
                  <tr className={`${l.item ? '' : 'is-draft'}${isChild ? ' is-bom-child' : ''}${showToggle ? ' is-bom-parent' : ''}`}>
                    <td data-label="Dòng">
                      <div className="fm-bom-parent-no">
                        <LineExpandButton expanded={expanded} onToggle={() => expandedLines.toggle(l.key)} lineNo={lineNo} controls={detailId} hideNo={isChild} />
                        {showToggle && (
                          <BomToggle
                            collapsed={bomCollapsed.has(l.bomGroupKey as string)}
                            count={childCounts.get(l.bomGroupKey as string) ?? 0}
                            parentLabel={l.item?.code ?? ''}
                            onToggle={() => toggleBomGroup(l.bomGroupKey as string)}
                          />
                        )}
                      </div>
                    </td>
                    <td data-label="Hàng hóa" data-full>
                      {isChild ? (
                        <BomChildCell
                          code={l.item?.code}
                          name={l.item?.name}
                          qtyPerParent={l.bomQtyPerParent}
                          uom={uomText}
                          parentCode={parentCodes.get(l.bomGroupKey as string)}
                          onSwap={canSwapBom && l.bomEditable !== false ? () => setSwapKey(l.key) : undefined}
                          disabled={saving}
                        />
                      ) : (
                      <Autocomplete
                        label="Hàng hóa"
                        hideLabel
                        placeholder="Gõ mã hàng, tên hàng hoặc quét barcode…"
                        fetchUrl="/api/items"
                        disabled={saving}
                        minChars={2}
                        minCharsHint="Nhập tối thiểu 2 ký tự để tìm mặt hàng (chỉ MẶT HÀNG BÁN ĐƯỢC)…"
                        value={l.item}
                        onChange={(v) => selectItem(l.key, v)}
                        error={invalid ? 'Chưa chọn hàng hóa' : undefined}
                      />
                      )}
                      {l.item && !expanded && (
                        <div className="fm-line-summary">
                          {[uomText, whText && `Kho ${whText}`, taxText && `${taxText} · ${clampPct(l.vatPct)}%`, showBatchCol && l.batchNumber && `Lô ${l.batchNumber}`].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td data-label="Barcode" className="fm-line-barcode">{l.item?.barcode || '—'}</td>
                    {showAccountCol && (
                      <td data-label="Tài khoản">
                        {l.item ? (
                          <input
                            type="text"
                            aria-label={`Tài khoản dòng ${idx + 1}`}
                            className="fm-line-input"
                            style={acctInvalid ? { borderColor: 'var(--fm-coral)', background: 'var(--fm-coral-soft)', textAlign: 'left' } : { textAlign: 'left' }}
                            value={l.accountCode || ''}
                            disabled={saving}
                            placeholder="VD: 5111"
                            title={acctInvalid ? 'Hóa đơn dịch vụ bắt buộc nhập mã Tài khoản (SAP: AccountCode)' : 'Mã tài khoản kế toán (SAP: DocumentLines.AccountCode)'}
                            onChange={(e) => updateLine(l.key, { accountCode: e.target.value })}
                          />
                        ) : '—'}
                      </td>
                    )}
                    <td data-label="Số lượng" className="fm-num">
                      <input
                        type="number"
                        min={0}
                        step="0.5"
                        inputMode="decimal"
                        aria-label={`Số lượng dòng ${idx + 1}`}
                        className="fm-line-input"
                        style={qtyInvalid ? { borderColor: 'var(--fm-coral)', background: 'var(--fm-coral-soft)' } : undefined}
                        value={l.quantity || ''}
                        disabled={saving || (isChild && l.bomEditable === false)}
                        title={qtyInvalid ? 'Số lượng phải lớn hơn 0' : isChild ? 'BOM Template: được chỉnh số lượng thành phần — SL này được đẩy lên SAP' : undefined}
                        onChange={(e) => updateLine(l.key, { quantity: Number(e.target.value) || 0 })}
                      />
                    </td>
                    <td data-label="Đơn giá (₫)" className="fm-num">
                      {isChild ? (
                        <span className="fm-line-meta" title="Thành phần BOM: giá bán luôn = 0đ">0</span>
                      ) : (
                      <input
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        aria-label={`Đơn giá dòng ${idx + 1}`}
                        className="fm-line-input"
                        style={priceInvalid ? { borderColor: 'var(--fm-coral)', background: 'var(--fm-coral-soft)' } : undefined}
                        value={l.unitPrice || ''}
                        disabled={saving}
                        onChange={(e) => updateLine(l.key, { unitPrice: Number(e.target.value) || 0 })}
                      />
                      )}
                    </td>
                    <td data-label="CK (%)" className="fm-num">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="any"
                        inputMode="decimal"
                        aria-label={`Chiết khấu dòng ${idx + 1}`}
                        className="fm-line-input"
                        value={l.discPct || ''}
                        placeholder="0"
                        disabled={saving || isChild}
                        title={isChild ? 'Thành phần BOM: không chiết khấu (giá = 0)' : undefined}
                        onChange={(e) => updateLine(l.key, { discPct: clampPct(Number(e.target.value) || 0) })}
                      />
                    </td>
                    <td className="fm-num fm-line-total" data-label="Thành tiền (₫)">{formatVND(afterDisc)}</td>
                    <td data-label="Xóa dòng">
                      {isChild ? (
                        <span className="fm-line-meta" title="Xóa dòng cha để gỡ cả nhóm BOM">—</span>
                      ) : (
                      <button
                        type="button"
                        className="fm-row-del"
                        title={showToggle ? 'Xóa dòng (gồm cả các thành phần BOM)' : 'Xóa dòng'}
                        aria-label={`Xóa dòng ${idx + 1}${showToggle ? ' và các thành phần BOM' : ''}`}
                        disabled={saving}
                        onClick={() => removeLine(l.key)}
                      >
                        <Trash2 size={14} />
                      </button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <LineDetailRow id={detailId} colSpan={colCount}>
                      <LineDetailField label="Đơn vị tính" htmlFor={`${detailId}-uom`} title="Đơn vị tính (MeasureUnit) — để trống để SAP dùng mặc định của mặt hàng">
                        <input
                          id={`${detailId}-uom`}
                          className="fm-line-input"
                          value={uomText}
                          onChange={(e) => updateLine(l.key, { uom: e.target.value || undefined })}
                          disabled={saving || !l.item}
                        />
                      </LineDetailField>
                      <LineDetailField label="Kho" htmlFor={`${detailId}-wh`} title="Kho xuất của dòng (WarehouseCode) — mặc định theo kho header">
                        <select
                          id={`${detailId}-wh`}
                          className="fm-line-select"
                          value={l.warehouseCode || ''}
                          disabled={saving || !l.item}
                          onChange={(e) => updateLine(l.key, { warehouseCode: e.target.value || undefined })}
                        >
                          <option value="">Theo header{headerWh ? ` (${headerWh})` : ''}</option>
                          {warehouses.map((w) => (
                            <option key={w.warehouseCode} value={w.warehouseCode}>{w.warehouseCode}</option>
                          ))}
                        </select>
                      </LineDetailField>
                      <LineDetailField label="Mã thuế" title="Mã nhóm thuế (SalesVATGroup) của mặt hàng trong SAP B1">
                        <span className="fm-line-meta">{taxText || '—'}</span>
                      </LineDetailField>
                      <LineDetailField label="Thuế (%)" htmlFor={`${detailId}-vat`} title="Thuế suất VAT của dòng — tự điền theo mã thuế">
                        <input
                          id={`${detailId}-vat`}
                          type="number"
                          min={0}
                          max={100}
                          step="any"
                          inputMode="decimal"
                          className="fm-line-input"
                          value={l.vatPct || ''}
                          placeholder="8"
                          disabled={saving}
                          onChange={(e) => updateLine(l.key, { vatPct: clampPct(Number(e.target.value) || 0) })}
                        />
                      </LineDetailField>
                      {showBatchCol && (
                        <LineDetailField label="Số lô" htmlFor={`${detailId}-batch`} title="Số lô (SAP BatchNumbers) — truy xuất nguồn gốc">
                          <input
                            id={`${detailId}-batch`}
                            className="fm-line-input"
                            value={l.batchNumber || ''}
                            disabled={saving || !l.item}
                            placeholder="VD: L2026-001"
                            maxLength={60}
                            onChange={(e) => updateLine(l.key, { batchNumber: e.target.value || undefined })}
                          />
                        </LineDetailField>
                      )}
                    </LineDetailRow>
                  )}
                  </Fragment>
                )
              })
              })()}
            </tbody>
          </table>
        </div>
        <LineQuickAdd onAdd={quickAddLine} onAddMany={addItemsBatch} disabled={saving} />
        {swapTarget && (
          <BomSwapDialog
            key={swapTarget.key}
            open
            component={swapTarget.item ? { code: swapTarget.item.code, name: swapTarget.item.name } : null}
            parentCode={swapParentCode}
            onConfirm={(v) => swapBomComponent(swapTarget.key, v)}
            onCancel={() => setSwapKey(null)}
          />
        )}
      </div>

      {/* Phase 2 — Khấu trừ đặt cọc (chỉ form Hóa đơn bán hàng) */}
      {enableDownPaymentDraws && (
        <div className="fm-card" style={{ marginBottom: 16 }}>
          <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Wallet size={18} /> Khấu trừ đặt cọc
          </h2>
          {!partner ? (
            <div className="fm-hint">Chọn khách hàng ở Bước 1 để xem các hóa đơn đặt cọc còn dư.</div>
          ) : drawsLoading ? (
            <div aria-busy="true"><div className="fm-skeleton fm-skeleton--row" /></div>
          ) : drawOpts.length === 0 ? (
            <div className="fm-empty">Khách hàng {partner.name} không có hóa đơn đặt cọc nào còn dư chưa khấu trừ.</div>
          ) : (
            <div className="fm-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}><span className="fm-sr-only">Chọn</span></th>
                    <th>Số đặt cọc</th>
                    <th className="fm-num">Tổng đặt cọc</th>
                    <th className="fm-num">Số dư còn lại</th>
                    <th className="fm-num" style={{ minWidth: 150 }}>Số tiền khấu trừ (₫)</th>
                  </tr>
                </thead>
                <tbody>
                  {drawOpts.map((o) => {
                    const s = drawSel[o.id]
                    const checked = s?.checked ?? false
                    return (
                      <tr key={o.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Khấu trừ đặt cọc #${o.docNum}`}
                            checked={checked}
                            disabled={saving}
                            onChange={(e) => setDrawSel((cur) => ({
                              ...cur,
                              [o.id]: { checked: e.target.checked, amount: e.target.checked ? (cur[o.id]?.amount || o.remaining) : 0 },
                            }))}
                          />
                        </td>
                        <th scope="row"><b>#{o.docNum}</b></th>
                        <td className="fm-num">{formatVND(o.grandTotal)}</td>
                        <td className="fm-num">{formatVND(o.remaining)}</td>
                        <td className="fm-num">
                          <input
                            type="number"
                            min={0}
                            max={o.remaining}
                            step="any"
                            inputMode="decimal"
                            className="fm-line-input"
                            style={{ maxWidth: 150 }}
                            aria-label={`Số tiền khấu trừ đặt cọc #${o.docNum}`}
                            value={s?.amount || ''}
                            placeholder={String(o.remaining)}
                            disabled={saving || !checked}
                            onChange={(e) => setDrawSel((cur) => ({
                              ...cur,
                              [o.id]: { checked: true, amount: Number(e.target.value) || 0 },
                            }))}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {drawTotals.totalDraw > 0 && (
            <div className="fm-hint" style={{ marginTop: 8 }}>
              Tổng khấu trừ: <b>{formatVND(drawTotals.totalDraw)}</b> — Tổng phải thu sau khấu trừ: <b>{formatVND(drawTotals.payable)}</b>
            </div>
          )}
        </div>
      )}

      {/* Bước 3 — Tổng kết */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BadgeCheck size={18} /> Bước 3 — Tổng kết
        </h2>
        <dl className="fm-view-detail">
          <div><dt>Tổng trước chiết khấu</dt><dd>{formatVND(totals.totalBeforeDisc)}</dd></div>
          <div><dt>Chiết khấu các dòng</dt><dd>{totals.discountAmt > 0 ? `−${formatVND(totals.discountAmt)}` : formatVND(0)}</dd></div>
          {totals.headerDiscAmt > 0 && (
            <div><dt>Chiết khấu đầu chứng từ ({headerDiscPct}%)</dt><dd>−{formatVND(totals.headerDiscAmt)}</dd></div>
          )}
          <div><dt>Sau chiết khấu</dt><dd>{formatVND(totals.afterDisc)}</dd></div>
          <div><dt>Thuế các dòng</dt><dd>{formatVND(totals.vatAmt)}</dd></div>
          <div><dt><b>Tổng chứng từ</b></dt><dd><b style={{ fontSize: 17, color: 'var(--fm-navy)' }}>{formatVND(totals.grand)}</b></dd></div>
          {enableDownPaymentDraws && drawTotals.totalDraw > 0 && (
            <>
              <div><dt>Khấu trừ đặt cọc</dt><dd>−{formatVND(drawTotals.totalDraw)}</dd></div>
              <div><dt><b>Tổng phải thu sau khấu trừ</b></dt><dd><b style={{ fontSize: 17, color: 'var(--fm-navy)' }}>{formatVND(drawTotals.payable)}</b></dd></div>
            </>
          )}
        </dl>
      </div>

      {/* Sticky action bar */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--fm-surface)',
          borderTop: '1px solid var(--fm-line)',
          padding: '12px 0',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          flexWrap: 'wrap',
          zIndex: 10,
        }}
      >
        <ShortcutHelp open={shortcuts.helpOpen} onOpen={shortcuts.openHelp} onClose={shortcuts.closeHelp} />
        <button type="button" className="fm-btn fm-btn--secondary" onClick={onBack} disabled={saving}>
          <ArrowLeft size={16} /> Quay lại
        </button>
        {/* Phase 2 — Lưu nháp: gọi API với ?draft=true (chỉ khi tạo mới) */}
        {!isEdit && (
          <button type="button" className="fm-btn fm-btn--secondary" onClick={() => save(true)} disabled={saving || prefillLoading}>
            <Save size={16} /> {saving ? 'Đang lưu nháp…' : 'Lưu nháp'}
          </button>
        )}
        <button type="button" className="fm-btn fm-btn--primary" onClick={() => save(isDraftDoc)} disabled={saving || prefillLoading}>
          <Save size={16} /> {saving ? (isEdit ? 'Đang cập nhật…' : 'Đang lưu…') : isEdit ? (isDraftDoc ? 'Lưu bản nháp' : `Lưu ${dl}`) : `Tạo ${dl}`}
        </button>
      </div>
    </div>
  )
}
