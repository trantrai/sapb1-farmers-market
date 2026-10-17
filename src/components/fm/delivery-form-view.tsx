'use client'

// ============================================================
// FORM tạo/sửa Phiếu giao hàng — standalone, đơn giản hơn
// order-form-view (không BOM, không ATP).
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
import { formatVND } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import CopyFromPicker from './copy-from-picker'
import type { PrefillDoc } from '@/lib/copy-from'
import {
  B2BFieldsSection,
  b2bFromSaved,
  buildB2BPayload,
  defaultB2BForm,
  parseB2BAddresses,
  type B2BAddress,
  type B2BFormState,
} from './order-form-view'

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
  /** Địa chỉ của KH đã chọn (từ BusinessPartner.addressesJson) — rỗng → ẩn 2 dropdown địa chỉ */
  const [b2bAddresses, setB2bAddresses] = useState<B2BAddress[]>([])
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
    setLines(
      (p.lines ?? []).map((l) => ({
        key: nextKey(),
        item: { code: l.itemCode, name: l.itemName },
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? 0,
        taxCode: l.taxCode ?? undefined,
        discPct: l.discPct ?? 0,
        uom: l.uom || undefined,
        warehouseCode: (l.warehouseCode ?? wh) || undefined,
      })),
    )
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

  // ---- B2B: địa chỉ giao/ghi hóa đơn của KH đã chọn (BusinessPartner.addressesJson) ----
  // Rỗng → ẩn 2 dropdown địa chỉ. Đồng bộ lại shipTo/billTo nếu mã đã chọn
  // không còn trong danh sách (tránh lưu mã địa chỉ không thuộc KH này).
  useEffect(() => {
    const code = partner?.code
    if (!code) { setB2bAddresses([]); return }
    let cancelled = false
    api(`/api/bpartners/sync?q=${encodeURIComponent(code)}&pageSize=5`)
      .then(async (r) => {
        if (cancelled) return
        let addrs: B2BAddress[] = []
        if (r.ok) {
          const j = await r.json().catch(() => null)
          const rows: Array<{ cardCode?: string; addressesJson?: string | null }> = Array.isArray(j?.data) ? j.data : []
          const rec = rows.find((d) => String(d.cardCode ?? '').toLowerCase() === code.toLowerCase()) ?? rows[0]
          addrs = parseB2BAddresses(rec?.addressesJson ?? null)
        }
        setB2bAddresses(addrs)
        const codes = new Set(addrs.map((a) => a.code))
        setB2b((b) => ({
          ...b,
          shipToCode: b.shipToCode && codes.has(b.shipToCode) ? b.shipToCode : '',
          billToCode: b.billToCode && codes.has(b.billToCode) ? b.billToCode : '',
        }))
      })
      .catch(() => { if (!cancelled) setB2bAddresses([]) })
    return () => { cancelled = true }
  }, [partner?.code])

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
        setLines(
          (d.lines ?? []).map((l: { id: string; itemCode: string; itemName: string; quantity: number; unitPrice: number; taxCode?: string | null; discPct?: number; warehouseCode?: string | null; uom?: string | null; batchNumber?: string | null }) => ({
            key: nextKey(),
            dbId: l.id,
            item: { code: l.itemCode, name: l.itemName },
            quantity: l.quantity,
            unitPrice: l.unitPrice ?? 0,
            taxCode: l.taxCode ?? undefined,
            discPct: l.discPct ?? 0,
            uom: l.uom || undefined,
            warehouseCode: (l.warehouseCode ?? d.warehouseCode ?? '') || undefined,
            batchNumber: l.batchNumber ?? undefined,
          })),
        )
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
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  const addLine = () => {
    setLines((ls) => [...ls, { key: nextKey(), item: null, quantity: 1, unitPrice: 0, taxCode: undefined, discPct: 0, warehouseCode: headerWh || undefined }])
  }
  const removeLine = (key: number) => {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls))
  }

  const lineTotal = (l: FormLine) => afterDiscTotal(l)
  /** Tổng các dòng SAU chiết khấu dòng (chưa trừ CK đầu chứng từ) */
  const subTotal = lines.reduce((s, l) => s + lineTotal(l), 0)
  /** Tiền CK đầu chứng từ (SAP DiscountPercent) — làm tròn, trừ vào tổng phiếu */
  const headerDiscAmt = Math.round((subTotal * clampDisc(headerDiscPct)) / 100)
  const grandTotal = subTotal - headerDiscAmt

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
              uom: l.uom?.trim() || l.item!.uom || '',
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              taxCode: l.taxCode || undefined,
              discPct: clampDisc(l.discPct),
              warehouseCode: l.warehouseCode || headerWh || undefined,
              batchNumber: l.batchNumber?.trim() || undefined,
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
        addresses={b2bAddresses}
      />

      <div className="fm-card" style={{ marginBottom: 12 }}>
        <h2 className="fm-card__title">Dòng hàng</h2>
        {isEdit && hasSourceOrder && (
          <div className="fm-hint" style={{ marginBottom: 8 }}>
            Phiếu tạo từ đơn hàng bán — chỉ sửa được số lượng từng dòng, không thêm/xóa dòng.
          </div>
        )}
        <table className="fm-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Mặt hàng</th>
              <th style={{ width: 90 }}>Kho</th>
              <th style={{ width: 110 }}>Số lượng</th>
              <th style={{ width: 96 }}>Đơn vị tính</th>
              <th style={{ width: 140 }}>Đơn giá</th>
              <th style={{ width: 110 }}>Mã thuế</th>
              <th style={{ width: 110 }} title="Số lô (SAP: BatchNumbers) — truy xuất nguồn gốc">Số lô</th>
              <th style={{ width: 90 }}>CK %</th>
              <th style={{ width: 140, textAlign: 'right' }}>Thành tiền</th>
              {(!isEdit || !hasSourceOrder) && <th style={{ width: 48 }} />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td>{i + 1}</td>
                <td style={{ minWidth: 220 }}>
                  {isEdit && hasSourceOrder ? (
                    <span>{l.item ? `${l.item.code} — ${l.item.name}` : '—'}</span>
                  ) : (
                    <Autocomplete
                      label={`Mặt hàng dòng ${i + 1}`}
                      hideLabel
                      placeholder="Tìm mã / tên mặt hàng…"
                      fetchUrl="/api/items"
                      value={l.item}
                      onChange={(v) => setLine(l.key, {
                        item: v,
                        unitPrice: v?.price ?? l.unitPrice,
                        // Gợi ý mã thuế từ danh mục mặt hàng (user vẫn sửa được)
                        taxCode: v?.taxCode || l.taxCode,
                        // Gợi ý đơn vị tính từ mặt hàng (user vẫn sửa được)
                        uom: v?.uom || l.uom,
                      })}
                      disabled={saving}
                    />
                  )}
                </td>
                <td style={{ minWidth: 100 }}>
                  <select
                    className="fm-input"
                    value={l.warehouseCode ?? headerWh ?? ''}
                    title="Kho xuất của dòng (WarehouseCode) — mặc định theo kho header"
                    disabled={saving || warehouses.length === 0}
                    onChange={(e) => setLine(l.key, { warehouseCode: e.target.value || undefined })}
                    aria-label={`Kho xuất dòng ${i + 1}`}
                  >
                    <option value="">—</option>
                    {warehouses.map((w) => (
                      <option key={w.warehouseCode} value={w.warehouseCode}>{w.warehouseCode}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    className="fm-input"
                    min={0}
                    step="any"
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: parseFloat(e.target.value) || 0 })}
                    disabled={saving}
                    aria-label={`Số lượng dòng ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="fm-input"
                    value={l.uom || l.item?.uom || ''}
                    onChange={(e) => setLine(l.key, { uom: e.target.value || undefined })}
                    disabled={saving}
                    title="Đơn vị tính (MeasureUnit) — có thể sửa; để trống để SAP dùng mặc định của mặt hàng"
                    aria-label={`Đơn vị tính dòng ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="fm-input"
                    min={0}
                    step="any"
                    value={l.unitPrice}
                    onChange={(e) => setLine(l.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                    disabled={saving || (isEdit && hasSourceOrder)}
                    aria-label={`Đơn giá dòng ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="fm-input"
                    value={l.taxCode ?? ''}
                    placeholder="—"
                    title="Mã nhóm thuế SAP (VatGroup)"
                    onChange={(e) => setLine(l.key, { taxCode: e.target.value.trim() || undefined })}
                    disabled={saving || (isEdit && hasSourceOrder)}
                    aria-label={`Mã thuế dòng ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="fm-input"
                    value={l.batchNumber ?? ''}
                    placeholder="—"
                    title="Số lô (SAP: BatchNumbers) — truy xuất nguồn gốc"
                    onChange={(e) => setLine(l.key, { batchNumber: e.target.value.trim() || undefined })}
                    disabled={saving || (isEdit && hasSourceOrder)}
                    aria-label={`Số lô dòng ${i + 1}`}
                    maxLength={50}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="fm-input"
                    min={0}
                    max={100}
                    step="any"
                    value={l.discPct || ''}
                    placeholder="0"
                    onChange={(e) => setLine(l.key, { discPct: clampDisc(parseFloat(e.target.value) || 0) })}
                    disabled={saving || (isEdit && hasSourceOrder)}
                    aria-label={`Chiết khấu % dòng ${i + 1}`}
                  />
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatVND(lineTotal(l))}</td>
                {(!isEdit || !hasSourceOrder) && (
                  <td>
                    <button
                      type="button"
                      className="fm-row-del"
                      onClick={() => removeLine(l.key)}
                      disabled={saving || lines.length <= 1}
                      title="Xóa dòng"
                      aria-label={`Xóa dòng ${i + 1}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {(!isEdit || !hasSourceOrder) && (
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={addLine} disabled={saving} style={{ marginTop: 8 }}>
            <Plus size={14} /> Thêm dòng
          </button>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <table style={{ minWidth: 280 }}>
            <tbody>
              <tr>
                <td>Tổng các dòng (sau CK dòng):</td>
                <td style={{ textAlign: 'right' }}>{formatVND(subTotal)}</td>
              </tr>
              {headerDiscAmt > 0 && (
                <tr>
                  <td>Chiết khấu đầu chứng từ ({headerDiscPct}%):</td>
                  <td style={{ textAlign: 'right' }}>−{formatVND(headerDiscAmt)}</td>
                </tr>
              )}
              <tr>
                <td style={{ fontWeight: 700 }}>Tổng phiếu giao hàng:</td>
                <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 16 }}>{formatVND(grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', position: 'sticky', bottom: 0, background: 'var(--fm-bg)', padding: '12px 0' }}>
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
