'use client'

import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Save, ShoppingCart, ShoppingBasket, BadgeCheck, RefreshCw, Upload, ChevronDown, ChevronUp, History, BookmarkPlus, X, Copy, Paperclip } from 'lucide-react'
import Autocomplete, { ACOption } from './autocomplete'
import PageHeader from './page-header'
import { formatVND, formatNum, formatDateVN } from '@/lib/fm-shared'
import { calcOrderLines } from '@/lib/order-calc'
import { api } from '@/lib/fm-client'
import { useFocusTrap } from './use-focus-trap'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import CopyFromPicker from './copy-from-picker'
import type { PrefillDoc } from '@/lib/copy-from'
import { B2BPartyFields, useBpB2BInfo } from './b2b-party-fields'
import { BomChildCell, BomToggle, bomChildCounts, visibleBomLines } from './bom-lines'
import BomSwapDialog, { useCanSwapBom } from './bom-swap-dialog'
import { ShortcutHelp, useFormShortcuts } from './form-shortcuts'
import PrecheckDialog from './precheck-dialog'
import { precheckOrder, type PrecheckIssue } from '@/lib/order-precheck'
import RecentOrdersPanel, { recentLineToOption, type RecentOrder } from './recent-orders'
import CustomerBasket from './customer-basket'
import DeliveryHint from './delivery-hint'
import { LineDetailField, LineDetailRow, LineExpandButton, LineQuickAdd, useExpandedLines } from './line-items'
import type { B2BPartySelection, BpB2BInfo } from '@/lib/bp-b2b'

interface DraftLine {
  key: number
  item: ACOption | null
  /** Copy-from: id dòng báo giá nguồn (tương đương BaseLine SAP) — đẩy SAP gắn BaseType 23 */
  sourceLineId?: string | null
  quantity: number
  unitPrice: number
  discPct: number
  vatPct: number
  /** 'special' = giá đặc biệt theo khách hàng (OSPP); 'pricelist' = Price List 1 */
  priceSource?: string
  /** Giá tham chiếu đã giải (OSPP / Price List 1) — cảnh báo khi giá nhập tay thấp hơn */
  refPrice?: number
  /** Mã nhóm thuế SAP (SalesVATGroup, vd S1/S2/S8) — tự điền khi chọn mặt hàng, đi kèm khi đẩy đơn sang SAP B1 */
  taxCode?: string
  /** true = người dùng đã tự sửa VAT% tay (ghi đè thuế suất từ mã thuế) */
  vatOverridden?: boolean
  /** Đơn vị tính (SalesUnit) — tự điền khi chọn mặt hàng */
  uom?: string
  /** Kho xuất của dòng (WarehouseCode) — mặc định lấy từ header, chỉnh được theo dòng */
  warehouseCode?: string
  /** CHẾ ĐỘ SỬA ĐƠN: id dòng local (đơn local) hoặc LineNum trên SAP (đơn SAP) */
  dbId?: string
  sapLineNum?: number
  // ---------- BOM ----------
  /** Loại BOM của dòng cha: 'template' | 'production' | 'assembly' (undefined = hàng thường) */
  bomType?: 'template' | 'production' | 'assembly'
  /** true = dòng thành phần con của mặt hàng BOM */
  isBomChild?: boolean
  /** Khóa nhóm BOM: dòng cha và các dòng con cùng nhóm */
  bomGroupKey?: string
  /** Dòng con có được sửa số lượng không (template: có, production/assembly: không) */
  bomEditable?: boolean
  /** Định mức: số lượng con cho 1 đơn vị cha (dòng con) */
  bomQtyPerParent?: number
}

// ---------- Chế độ SỬA đơn hàng đang Open ----------
export interface EditOrderLine {
  /** id bản ghi SalesOrderLine local (đơn local) */
  dbId?: string
  /** LineNum trên SAP B1 (đơn đã synced — lấy từ chi tiết SL) */
  sapLineNum?: number
  itemCode: string
  itemName: string
  /** Copy-from: id dòng báo giá nguồn */
  sourceLineId?: string | null
  /** Mã vạch (BarCode) đã lưu trên dòng */
  barcode?: string | null
  uom?: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  discPct?: number
  vatPct?: number
  taxCode?: string
  // ---------- BOM ----------
  isBomChild?: boolean
  bomGroupKey?: string | null
  bomEditable?: boolean
  bomQtyPerParent?: number | null
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
  /** Optimistic locking: version lúc mở form */
  version?: number
  /** Phase 2 — Nháp: true = bản nháp chưa có hiệu lực */
  isDraft?: boolean
  // ---------- B2B / SAP B1 (Đợt 2+3) ----------
  /** Nhân viên bán hàng (SAP SalesPersonCode) */
  salesPersonCode?: number | null
  /** Điều khoản thanh toán (SAP PaymentGroupCode) */
  paymentGroupCode?: number | null
  /** Địa chỉ giao hàng (SAP ShipToCode) */
  shipToCode?: string | null
  /** Địa chỉ ghi hóa đơn (SAP BillToCode) */
  billToCode?: string | null
  /** Người liên hệ (SAP ContactPersonCode) */
  contactPersonCode?: number | null
  /** Số PO / tham chiếu của KH (SAP NumAtCard) */
  numAtCard?: string | null
  /** Ngày tính thuế (SAP TaxDate) — ISO date */
  taxDate?: string | null
  /** Tiền tệ chứng từ (SAP DocCurrency) */
  docCurrency?: string | null
  /** Tỷ giá (SAP DocRate) */
  docRate?: number | null
  /** Mã dự án (SAP ProjectCode) */
  projectCode?: string | null
  /** Đính kèm JSON [{name,url}] */
  attachmentsJson?: string | null
  /** Ngày cần giao (SAP ReqDate) — ISO date */
  reqDate?: string | null
  lines: EditOrderLine[]
}

// ---------- Nguồn dữ liệu đầu vào cho toEditData (đơn từ danh sách, chi tiết API, ...) ----------
/** Hình dạng tối thiểu của 1 dòng đơn để dựng EditOrderData */
export interface EditOrderSourceLine {
  id?: string
  lineNum?: number
  itemCode: string
  itemName: string
  /** Copy-from: id dòng báo giá nguồn */
  sourceLineId?: string | null
  /** Mã vạch (BarCode) đã lưu trên dòng */
  barcode?: string | null
  uom?: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  discPct?: number
  vatPct?: number
  taxCode?: string
  isBomChild?: boolean
  bomGroupKey?: string | null
  bomEditable?: boolean
  bomQtyPerParent?: number | null
}
/** Hình dạng tối thiểu của 1 đơn để dựng EditOrderData */
export interface EditOrderSource {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks: string | null
  warehouseCode?: string | null
  headerDiscPct?: number
  sapSyncStatus?: string
  version?: number
  source?: string
  localId?: string | null
  /** Phase 2 — Nháp: true = bản nháp chưa có hiệu lực (API: ?isDraft=) */
  isDraft?: boolean
  // ---------- B2B / SAP B1 (Đợt 2+3) ----------
  salesPersonCode?: number | null
  paymentGroupCode?: number | null
  shipToCode?: string | null
  billToCode?: string | null
  contactPersonCode?: number | null
  numAtCard?: string | null
  taxDate?: string | null
  docCurrency?: string | null
  docRate?: number | null
  projectCode?: string | null
  attachmentsJson?: string | null
  reqDate?: string | null
  lines: EditOrderSourceLine[]
}

/**
 * Dựng EditOrderData từ 1 đơn — DÙNG CHUNG cho mọi đường vào form sửa
 * (danh sách đơn, chi tiết đơn, ...).
 * QUAN TRỌNG: map dbId (dòng local) / sapLineNum (dòng SAP) để API PUT
 * nhận diện đúng dòng cũ — thiếu 2 trường này, PUT sẽ append TRÙNG dòng
 * trên SAP B1 (B1S-ReplaceCollectionsOnPatch coi dòng không LineNum là dòng mới).
 */
export const toEditData = (o: EditOrderSource): EditOrderData => ({
  id: o.source === 'sap' ? o.localId ?? o.id : o.id,
  docNum: o.docNum,
  cardCode: o.cardCode,
  cardName: o.cardName,
  docDate: o.docDate,
  docDueDate: o.docDueDate,
  status: o.status,
  remarks: o.remarks,
  warehouseCode: o.warehouseCode ?? null,
  headerDiscPct: o.headerDiscPct ?? 0,
  sapSyncStatus: o.sapSyncStatus ?? (o.source === 'sap' ? 'synced' : 'none'),
  version: o.version,
  isDraft: o.isDraft ?? false,
  salesPersonCode: o.salesPersonCode ?? null,
  paymentGroupCode: o.paymentGroupCode ?? null,
  shipToCode: o.shipToCode ?? null,
  billToCode: o.billToCode ?? null,
  contactPersonCode: o.contactPersonCode ?? null,
  numAtCard: o.numAtCard ?? null,
  taxDate: o.taxDate ? String(o.taxDate).slice(0, 10) : null,
  docCurrency: o.docCurrency ?? null,
  docRate: o.docRate ?? null,
  projectCode: o.projectCode ?? null,
  attachmentsJson: o.attachmentsJson ?? null,
  reqDate: o.reqDate ? String(o.reqDate).slice(0, 10) : null,
  lines: o.lines.map((l) => ({
    dbId: o.source === 'sap' ? undefined : l.id,
    sapLineNum: o.source === 'sap' ? l.lineNum : undefined,
    itemCode: l.itemCode,
    itemName: l.itemName,
    barcode: l.barcode ?? null,
    uom: l.uom,
    warehouseCode: l.warehouseCode,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discPct: l.discPct,
    vatPct: l.vatPct,
    taxCode: l.taxCode,
    isBomChild: l.isBomChild ?? false,
    bomGroupKey: l.bomGroupKey ?? null,
    bomEditable: l.bomEditable ?? true,
    bomQtyPerParent: l.bomQtyPerParent ?? null,
    sourceLineId: l.sourceLineId ?? null,
  })),
})

// ============================================================
// THÔNG TIN B2B / SAP B1 (Đợt 2+3) — dùng chung cho form Đơn hàng & Giao hàng
// ============================================================

/** Tiền tệ chứng từ được phép (SAP DocCurrency) */
export const B2B_CURRENCIES = ['VND', 'USD', 'EUR', 'JPY'] as const

/** Trạng thái các ô nhập của khu vực "Thông tin B2B / SAP B1" trên form */
export interface B2BFormState {
  /** Mã NVBH dạng chuỗi ('' = chưa chọn) — bind trực tiếp vào dropdown/number input */
  salesPersonCode: string
  /** Mã ĐKTT dạng chuỗi ('' = chưa chọn) */
  paymentGroupCode: string
  /** Số PO / tham chiếu của KH */
  numAtCard: string
  /** Ngày tính thuế (yyyy-mm-dd) */
  taxDate: string
  /** true = user đã tự sửa Ngày tính thuế → không tự đồng bộ theo Ngày chứng từ nữa */
  taxDateManual: boolean
  /** Tiền tệ chứng từ */
  docCurrency: string
  /** Tỷ giá dạng chuỗi (chỉ dùng khi tiền tệ ≠ VND) */
  docRate: string
  /** Mã dự án */
  projectCode: string
  /** Địa chỉ giao hàng (ShipToCode) */
  shipToCode: string
  /** Địa chỉ ghi hóa đơn (BillToCode) */
  billToCode: string
  /** Người liên hệ (ContactPersonCode) — mã số dạng chuỗi */
  contactPersonCode: string
  /** Ngày cần giao (yyyy-mm-dd) */
  reqDate: string
  /** Danh sách đính kèm {name, url} */
  attachments: { name: string; url: string }[]
}

export const defaultB2BForm = (docDate: string): B2BFormState => ({
  salesPersonCode: '',
  paymentGroupCode: '',
  numAtCard: '',
  taxDate: (docDate || '').slice(0, 10),
  taxDateManual: false,
  docCurrency: 'VND',
  docRate: '',
  projectCode: '',
  shipToCode: '',
  billToCode: '',
  contactPersonCode: '',
  reqDate: '',
  attachments: [],
})

/** Parse attachmentsJson → mảng {name, url} (lỗi → mảng rỗng) */
export function parseB2BAttachments(json?: string | null): { name: string; url: string }[] {
  if (!json || typeof json !== 'string') return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({ name: String((a as { name?: unknown }).name ?? ''), url: String((a as { url?: unknown }).url ?? '') }))
      .filter((a) => a.name || a.url)
      .slice(0, 50)
  } catch {
    return []
  }
}

/** Dựng B2BFormState từ dữ liệu đơn/phiếu đã lưu (chế độ sửa) */
export function b2bFromSaved(
  docDate: string,
  o: {
    salesPersonCode?: number | null; paymentGroupCode?: number | null
    numAtCard?: string | null; taxDate?: string | null; docCurrency?: string | null
    docRate?: number | null; projectCode?: string | null; shipToCode?: string | null
    billToCode?: string | null; reqDate?: string | null; attachmentsJson?: string | null
    contactPersonCode?: number | null
  },
): B2BFormState {
  const tax = (o.taxDate || '').slice(0, 10)
  const doc = (docDate || '').slice(0, 10)
  const cur = (o.docCurrency || '').toUpperCase()
  return {
    salesPersonCode: o.salesPersonCode != null ? String(o.salesPersonCode) : '',
    paymentGroupCode: o.paymentGroupCode != null ? String(o.paymentGroupCode) : '',
    numAtCard: o.numAtCard ?? '',
    taxDate: tax || doc,
    taxDateManual: Boolean(tax) && tax !== doc,
    docCurrency: (B2B_CURRENCIES as readonly string[]).includes(cur) ? cur : 'VND',
    docRate: o.docRate != null && Number.isFinite(o.docRate) ? String(o.docRate) : '',
    projectCode: o.projectCode ?? '',
    shipToCode: o.shipToCode ?? '',
    billToCode: o.billToCode ?? '',
    contactPersonCode: o.contactPersonCode != null ? String(o.contactPersonCode) : '',
    reqDate: (o.reqDate || '').slice(0, 10),
    attachments: parseB2BAttachments(o.attachmentsJson),
  }
}

export interface B2BPayload {
  salesPersonCode: number | null
  paymentGroupCode: number | null
  shipToCode: string | null
  billToCode: string | null
  contactPersonCode: number | null
  numAtCard: string | null
  taxDate: string | null
  docCurrency: string
  docRate: number | null
  projectCode: string | null
  attachmentsJson: string | null
  reqDate: string | null
}

/** Chuyển B2BFormState → payload gửi API (kèm validate; lỗi → { error }) */
export function buildB2BPayload(b: B2BFormState): { payload: B2BPayload; error?: string } {
  const intOrNull = (v: string): number | null => {
    const t = v.trim()
    if (!t) return null
    const n = Number(t)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }
  const strOrNull = (v: string): string | null => {
    const t = v.trim()
    return t === '' ? null : t
  }
  const currency = (B2B_CURRENCIES as readonly string[]).includes(b.docCurrency) ? b.docCurrency : 'VND'
  let docRate: number | null = null
  if (currency !== 'VND') {
    const r = Number(b.docRate)
    if (!Number.isFinite(r) || r <= 0) {
      return { payload: null as unknown as B2BPayload, error: 'Tỷ giá phải là số lớn hơn 0 khi tiền tệ khác VND' }
    }
    docRate = r
  }
  const attachments = (b.attachments ?? [])
    .map((a) => ({ name: (a.name ?? '').trim(), url: (a.url ?? '').trim() }))
    .filter((a) => a.name || a.url)
    .slice(0, 50)
  return {
    payload: {
      salesPersonCode: intOrNull(b.salesPersonCode),
      paymentGroupCode: intOrNull(b.paymentGroupCode),
      shipToCode: strOrNull(b.shipToCode),
      billToCode: strOrNull(b.billToCode),
      contactPersonCode: intOrNull(b.contactPersonCode),
      numAtCard: strOrNull(b.numAtCard),
      taxDate: strOrNull(b.taxDate),
      docCurrency: currency,
      docRate,
      projectCode: strOrNull(b.projectCode),
      attachmentsJson: attachments.length > 0 ? JSON.stringify(attachments) : null,
      reqDate: strOrNull(b.reqDate),
    },
  }
}

// Địa chỉ đối tác: dùng chung từ '@/lib/bp-b2b' (giữ export cũ cho các form khác)
export { parseB2BAddresses, type B2BAddress } from '@/lib/bp-b2b'

// ============================================================
// KHU VỰC "THÔNG TIN B2B / SAP B1" — dùng chung cho form Đơn hàng & Giao hàng
// ============================================================

interface B2BSectionProps {
  b2b: B2BFormState
  onChange: <K extends keyof B2BFormState>(key: K, value: B2BFormState[K]) => void
  saving: boolean
  /** Tiền tố id cho các ô nhập (tránh trùng id khi có nhiều form) */
  idPrefix: string
  salesPersons: { code: number; name: string }[]
  /** true = không tải được danh mục NVBH → dùng ô nhập số (fallback) */
  spListFailed: boolean
  paymentTerms: { code: number; name: string }[]
  /** true = không tải được danh mục ĐKTT → dùng ô nhập số (fallback) */
  ptListFailed: boolean
  /** Địa chỉ + người liên hệ của KH đã chọn (useBpB2BInfo) */
  partyInfo: BpB2BInfo
  partyLoading?: boolean
  /** Đã chọn khách hàng chưa */
  hasPartner: boolean
}

/** Khu vực "Thông tin B2B / SAP B1" trên form chứng từ: NVBH, ĐKTT, PO KH,
 *  ngày tính thuế, tiền tệ/tỷ giá, dự án, địa chỉ giao/ghi hóa đơn, đính kèm. */
export function B2BFieldsSection({
  b2b, onChange, saving, idPrefix,
  salesPersons, spListFailed, paymentTerms, ptListFailed, partyInfo, partyLoading, hasPartner,
}: B2BSectionProps) {

  const setAttachment = (idx: number, patch: Partial<{ name: string; url: string }>) => {
    onChange('attachments', b2b.attachments.map((a, i) => (i === idx ? { ...a, ...patch } : a)))
  }
  const addAttachment = () => onChange('attachments', [...b2b.attachments, { name: '', url: '' }])
  const removeAttachment = (idx: number) =>
    onChange('attachments', b2b.attachments.filter((_, i) => i !== idx))

  /** Dropdown NVBH/ĐKTT: có danh mục → select; 404/lỗi → ô nhập số (fallback) */
  const renderCodeSelect = (
    id: string,
    label: string,
    title: string,
    value: string,
    rows: { code: number; name: string }[],
    listFailed: boolean,
    field: 'salesPersonCode' | 'paymentGroupCode',
  ) => (
    <div className="fm-field">
      <label className="fm-label" htmlFor={id} title={title}>{label}</label>
      {listFailed ? (
        <input
          id={id}
          type="number"
          className="fm-input"
          min={0}
          step={1}
          inputMode="numeric"
          placeholder="Nhập mã số…"
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          disabled={saving}
          title={`${title} — chưa tải được danh mục, nhập mã số trực tiếp`}
        />
      ) : (
        <select
          id={id}
          className="fm-input"
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          disabled={saving}
          title={title}
        >
          <option value="">— Chưa chọn —</option>
          {rows.map((r) => (
            <option key={r.code} value={r.code}>
              {r.code} · {r.name}
            </option>
          ))}
          {/* Mã đã lưu nhưng không có trong danh mục (vd danh mục chưa đồng bộ) */}
          {value && !rows.some((r) => String(r.code) === value) && (
            <option value={value}>{value} (mã đã lưu)</option>
          )}
        </select>
      )}
    </div>
  )

  return (
    <div className="fm-card" style={{ marginBottom: 16 }}>
      <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Paperclip size={18} /> Thông tin B2B / SAP B1
      </h2>
      <div className="fm-form-grid">
        {renderCodeSelect(
          `${idPrefix}-sp`, 'Nhân viên bán hàng', 'Nhân viên bán hàng (SAP: SalesPersonCode)',
          b2b.salesPersonCode, salesPersons, spListFailed, 'salesPersonCode',
        )}
        {renderCodeSelect(
          `${idPrefix}-pt`, 'Điều khoản thanh toán', 'Điều khoản thanh toán (SAP: PaymentGroupCode)',
          b2b.paymentGroupCode, paymentTerms, ptListFailed, 'paymentGroupCode',
        )}
        <div className="fm-field">
          <label className="fm-label" htmlFor={`${idPrefix}-numatcard`} title="Số PO / tham chiếu của khách hàng (SAP: NumAtCard)">Số PO / Tham chiếu KH</label>
          <input
            id={`${idPrefix}-numatcard`}
            type="text"
            className="fm-input"
            placeholder="VD: PO-2026-001"
            value={b2b.numAtCard}
            onChange={(e) => onChange('numAtCard', e.target.value)}
            disabled={saving}
            maxLength={100}
          />
        </div>
        <div className="fm-field">
          <label className="fm-label" htmlFor={`${idPrefix}-taxdate`} title="Ngày tính thuế (SAP: TaxDate) — mặc định = ngày chứng từ">Ngày tính thuế</label>
          <input
            id={`${idPrefix}-taxdate`}
            type="date"
            className="fm-datepicker"
            value={b2b.taxDate}
            onChange={(e) => { onChange('taxDate', e.target.value); onChange('taxDateManual', true) }}
            disabled={saving}
          />
        </div>
        <div className="fm-field">
          <label className="fm-label" htmlFor={`${idPrefix}-reqdate`} title="Ngày cần giao hàng cho khách (SAP: ReqDate)">Ngày cần giao</label>
          <input
            id={`${idPrefix}-reqdate`}
            type="date"
            className="fm-datepicker"
            value={b2b.reqDate}
            onChange={(e) => onChange('reqDate', e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="fm-field">
          <label className="fm-label" htmlFor={`${idPrefix}-currency`} title="Tiền tệ chứng từ (SAP: DocCurrency)">Tiền tệ</label>
          <select
            id={`${idPrefix}-currency`}
            className="fm-input"
            value={b2b.docCurrency}
            onChange={(e) => onChange('docCurrency', e.target.value)}
            disabled={saving}
          >
            {B2B_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        {b2b.docCurrency !== 'VND' && (
          <div className="fm-field">
            <label className="fm-label" htmlFor={`${idPrefix}-rate`} title="Tỷ giá quy đổi sang VND (SAP: DocRate)">Tỷ giá <span className="fm-label__req">*</span></label>
            <input
              id={`${idPrefix}-rate`}
              type="number"
              className="fm-input"
              min={0}
              step="any"
              inputMode="decimal"
              placeholder="VD: 26000"
              value={b2b.docRate}
              onChange={(e) => onChange('docRate', e.target.value)}
              disabled={saving}
            />
          </div>
        )}
        <div className="fm-field">
          <label className="fm-label" htmlFor={`${idPrefix}-project`} title="Mã dự án (SAP: ProjectCode)">Mã dự án</label>
          <input
            id={`${idPrefix}-project`}
            type="text"
            className="fm-input"
            value={b2b.projectCode}
            onChange={(e) => onChange('projectCode', e.target.value)}
            disabled={saving}
            maxLength={50}
          />
        </div>
        <B2BPartyFields
          value={{ shipToCode: b2b.shipToCode, billToCode: b2b.billToCode, contactPersonCode: b2b.contactPersonCode }}
          onChange={(patch) => { for (const [k, v] of Object.entries(patch)) onChange(k as keyof B2BPartySelection, v as string) }}
          info={partyInfo}
          loading={partyLoading}
          disabled={saving}
          hasPartner={hasPartner}
          idPrefix={idPrefix}
        />
        <div className="fm-field" style={{ gridColumn: '1 / -1' }}>
          <span className="fm-label" id={`${idPrefix}-attachments-label`}>Đính kèm</span>
          {b2b.attachments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }} role="group" aria-labelledby={`${idPrefix}-attachments-label`}>
              {b2b.attachments.map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    className="fm-input"
                    placeholder="Tên file…"
                    value={a.name}
                    onChange={(e) => setAttachment(i, { name: e.target.value })}
                    disabled={saving}
                    style={{ flex: '1 1 180px', minWidth: 0 }}
                    aria-label={`Tên đính kèm ${i + 1}`}
                    maxLength={200}
                  />
                  <input
                    className="fm-input"
                    placeholder="URL…"
                    value={a.url}
                    onChange={(e) => setAttachment(i, { url: e.target.value })}
                    disabled={saving}
                    style={{ flex: '2 1 260px', minWidth: 0 }}
                    aria-label={`URL đính kèm ${i + 1}`}
                    maxLength={500}
                  />
                  <button
                    type="button"
                    className="fm-icon-btn fm-icon-btn--danger"
                    onClick={() => removeAttachment(i)}
                    disabled={saving}
                    title="Xóa đính kèm"
                    aria-label={`Xóa đính kèm ${i + 1}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div>
            <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={addAttachment} disabled={saving}>
              <Plus size={14} /> Thêm đính kèm
            </button>
          </div>
          <div className="fm-hint">Tên + đường dẫn URL của file đính kèm (lưu gọn thay cho AttachmentEntry của SAP B1)</div>
        </div>
      </div>
    </div>
  )
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
  userId,
}: {
  onSaved: (result: { id?: string | null; docNum: number; sapStatus: string; sapDocNum?: number | null; sapError?: string | null }) => void
  /** Đơn hàng cần sửa (Open) — có nghĩa là đang ở chế độ CẬP NHẬT */
  editOrder?: EditOrderData | null
  /** Nút hủy ở chế độ sửa → quay lại danh sách */
  onCancel?: () => void
  /** Id user đăng nhập — dùng làm key nháp form (fm-order-draft-<userId>-...) */
  userId?: string
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

  const [lines, setLines] = useState<DraftLine[]>([
    { key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 },
  ])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** true = lỗi 409 VERSION_CONFLICT — banner hiện thêm nút "Tải lại" */
  const [versionConflict, setVersionConflict] = useState(false)
  const [reloading, setReloading] = useState(false)
  /** Phase 2 — finalize (nháp → chính thức) đang chạy */
  const [finalizing, setFinalizing] = useState(false)

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)
  const [fieldErr, setFieldErr] = useState<Record<number, string>>({})
  /** "Sao chép từ…" (copy-from): mở picker + thông tin nguồn đã chọn */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copyFromInfo, setCopyFromInfo] = useState<PrefillDoc | null>(null)
  const isEdit = Boolean(editOrder)

  // ---- Nhập từ Excel ----
  const fileRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  /** Chi tiết các dòng lỗi khi nhập Excel — banner riêng tách khỏi banner thành công */
  const [importErrors, setImportErrors] = useState<string[] | null>(null)
  /** Tiến trình tra cứu mã hàng từ master data (null = không chạy) */
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)

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
  // Focus trap + Escape cho modal "Lưu thành mẫu đơn hàng"
  const tplTrapRef = useFocusTrap<HTMLDivElement>(tplModal, () => setTplModal(false))

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
      setTplMsg({ type: 'error', text: 'Vui lòng nhập tên mẫu' })
      return
    }
    const validLines = lines.filter((l) => l.item && l.quantity > 0)
    if (validLines.length === 0) {
      setTplMsg({ type: 'error', text: 'Form phải có ít nhất 1 dòng hàng hợp lệ' })
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
        setTplMsg({ type: 'error', text: json.error ?? 'Không lưu được mẫu' })
        return
      }
      setTplMsg({ type: 'success', text: `Đã lưu mẫu "${tplName.trim()}".` })
      setTplModal(false)
      setTplName('')
      setTplDesc('')
      loadTemplates()
    } catch {
      setTplMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setTplSaving(false)
    }
  }

  const resetForm = () => {
    setConfirmCfg(null)
    setPartner(null); setRemarks('')
    setHeaderDiscPct(0)
    setB2b(defaultB2BForm(docDate))
    setLines([{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8, warehouseCode: headerWh || undefined }])
    setAtp({})
    setError('')
  }

  const deleteTemplate = async (id: string, name: string) => {
    setConfirmCfg(null)
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
  // Focus trap + Escape cho modal "Lịch sử giá"
  const priceHistTrapRef = useFocusTrap<HTMLDivElement>(!!priceHistFor, () => setPriceHistFor(null))

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

  /** Parse số từ ô Excel: chấp nhận "1.234,56" (vi), "1,234.56" (en), "1,5".
   *  Trả null khi ô trống, NaN khi không phải số. */
  const parseExcelNum = (v: string): number | null => {
    const s = v.trim().replace(/\s/g, '')
    if (s === '') return null
    let norm = s
    if (norm.includes(',') && norm.includes('.')) {
      norm =
        norm.lastIndexOf(',') > norm.lastIndexOf('.')
          ? norm.replace(/\./g, '').replace(',', '.')
          : norm.replace(/,/g, '')
    } else if (norm.includes(',')) {
      norm = norm.replace(',', '.')
    }
    const n = Number(norm)
    return Number.isFinite(n) ? n : NaN
  }

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    try {
      // Reset banner cũ + bắt đầu hiển thị tiến trình
      setImportMsg(null)
      setImportErrors(null)

      // 1) Lấy template mặc định
      const tRes = await api('/api/excel-templates')
      const tJson = await tRes.json()
      const templates = tJson.data ?? []
      const template = templates.find((t: { isDefault: boolean }) => t.isDefault) ?? templates[0]
      if (!template) {
        setImportMsg({ type: 'error', text: 'Chưa có template Excel nào. Vào "Mẫu Excel" để tạo template trước.' })
        return
      }
      const mapping: Record<string, string> = template.mapping

      // 2) Đọc file Excel
      const buf = await file.arrayBuffer()
      // B4: lazy load xlsx (~7MB) chỉ khi dùng nhập Excel
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buf, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
      if (rows.length === 0) {
        setImportMsg({ type: 'error', text: 'File Excel không có dữ liệu' })
        return
      }

      // Đảo mapping: fieldKey -> excelColumn
      const fieldToCol: Record<string, string> = {}
      for (const [col, field] of Object.entries(mapping)) fieldToCol[field] = col

      // 3) Parse + validate từng dòng (mã hàng, số lượng, số học)
      interface ParsedRow {
        excelRow: number // số dòng trên file (1-based, đã + header)
        itemCode: string
        itemName: string
        quantity: number
        unitPrice: number | null // null = Excel không khai → lấy từ master data
        discPct: number | null
        uom: string
        taxCode: string
        warehouseCode: string
      }
      const parsed: ParsedRow[] = []
      const errors: string[] = []
      rows.forEach((row, idx) => {
        const excelRow = idx + 2
        const get = (field: string): string => {
          const col = fieldToCol[field]
          if (!col) return ''
          return String(row[col] ?? '').trim()
        }
        const itemCode = get('itemCode')
        if (!itemCode) {
          errors.push(`Dòng ${excelRow}: thiếu Mã hàng`)
          return
        }
        const quantity = parseExcelNum(get('quantity'))
        if (quantity === null || Number.isNaN(quantity)) {
          errors.push(`Dòng ${excelRow}: Số lượng trống hoặc không phải số`)
          return
        }
        if (quantity <= 0) {
          errors.push(`Dòng ${excelRow}: Số lượng phải > 0`)
          return
        }
        const unitPrice = parseExcelNum(get('unitPrice'))
        if (unitPrice !== null && (Number.isNaN(unitPrice) || unitPrice < 0)) {
          errors.push(`Dòng ${excelRow}: Đơn giá không hợp lệ`)
          return
        }
        const discPct = parseExcelNum(get('discPct'))
        if (discPct !== null && (Number.isNaN(discPct) || discPct < 0 || discPct > 100)) {
          errors.push(`Dòng ${excelRow}: Chiết khấu % phải từ 0 đến 100`)
          return
        }
        parsed.push({
          excelRow,
          itemCode,
          itemName: get('itemName'),
          quantity,
          unitPrice,
          discPct,
          uom: get('uom'),
          taxCode: get('taxCode'),
          warehouseCode: get('warehouseCode'),
        })
      })

      // 4) Tra cứu master data cho các mã hàng distinct — điền thông tin còn thiếu
      //    (tên hàng, đơn vị, đơn giá, mã thuế, VAT%) mà template không khai báo
      interface MasterItem {
        itemCode: string
        itemName?: string
        uom?: string
        price?: number
        taxCode?: string
        vatRate?: number
        barcode?: string
      }
      const master = new Map<string, MasterItem>()
      const distinctCodes = [...new Set(parsed.map((p) => p.itemCode))]
      for (const [idx, code] of distinctCodes.entries()) {
        // Hiển thị tiến trình tra cứu để người dùng biết không bị treo
        setImportProgress({ current: idx + 1, total: distinctCodes.length })
        try {
          // Timeout dài: lần đầu cache SAP lạnh phải tải toàn bộ danh mục phân trang
          const res = await api(`/api/items?q=${encodeURIComponent(code)}`, { timeoutMs: 120_000 })
          if (!res.ok) continue
          const json = await res.json()
          const items = (json.data ?? []) as MasterItem[]
          const found = items.find(
            (it) => String(it.itemCode ?? '').trim().toLowerCase() === code.toLowerCase(),
          )
          if (found) master.set(code, found)
        } catch {
          /* lỗi mạng/timeout → coi như không tìm thấy, báo ở bước sau */
        }
      }

      // 5) Dựng dòng đơn + validate mã hàng tồn tại trong danh mục
      const newLines: DraftLine[] = []
      for (const p of parsed) {
        const m = master.get(p.itemCode)
        if (!m) {
          errors.push(`Dòng ${p.excelRow}: Mã hàng "${p.itemCode}" không có trong danh mục`)
          continue
        }
        const item: ACOption = {
          code: m.itemCode,
          name: p.itemName || m.itemName || m.itemCode,
          uom: m.uom ?? '',
          taxCode: m.taxCode ?? '',
          vatRate: typeof m.vatRate === 'number' ? m.vatRate : undefined,
          price: typeof m.price === 'number' && m.price > 0 ? m.price : undefined,
          barcode: m.barcode ?? '',
        }
        newLines.push({
          key: nextKey(),
          item,
          quantity: p.quantity,
          // Ưu tiên đơn giá trên Excel; thiếu → giá Price List 1 từ master data
          unitPrice: p.unitPrice ?? item.price ?? 0,
          discPct: p.discPct ?? 0,
          // Template không có VAT% → lấy thuế suất theo mã thuế của mặt hàng
          vatPct: item.vatRate ?? 8,
          uom: p.uom || item.uom || undefined,
          taxCode: p.taxCode || item.taxCode || undefined,
          warehouseCode: p.warehouseCode || headerWh || undefined,
        })
      }

      if (newLines.length === 0) {
        setImportMsg({ type: 'error', text: 'Không nhập được dòng nào' })
        setImportErrors(errors.length > 0 ? errors : null)
        return
      }

      // Thay dòng trống đầu tiên nếu chưa có dữ liệu
      setLines((ls) => {
        const hasData = ls.some((l) => l.item)
        const base = hasData ? ls : []
        return [...base, ...newLines]
      })
      // Tự động resolve giá đặc biệt/VAT/tồn kho cho từng dòng đã nhập
      newLines.forEach((l) => {
        if (l.item) {
          void resolvePrice(l.key, l.item.code, partner?.code ?? null)
          void checkAtp(l.key, l.item.code, l.warehouseCode)
          // M2: bung dòng con BOM cho mặt hàng nhập từ Excel
          void expandBom(l.key, l.item.code)
        }
      })

      const msg = `Đã nhập ${newLines.length} dòng từ Excel (template "${template.name}").`
      // Banner kết quả tách 2: success (số dòng OK) + error riêng (số dòng lỗi + chi tiết)
      setImportMsg({ type: 'success', text: msg })
      setImportErrors(errors.length > 0 ? errors : null)
    } catch {
      setImportMsg({ type: 'error', text: 'Không đọc được file Excel' })
      setImportErrors(null)
    } finally {
      setImportProgress(null)
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
  // Khởi tạo form là EVENT (chạy 1 lần khi vào chế độ sửa), không phải effect
  // phản ứng — bọc bằng useEffectEvent để rõ ý định và tránh reset form nếu
  // identity của editOrder đổi giữa lúc nhập liệu.
  // Áp dữ liệu đơn vào form (hàm thường — gọi được từ event handler).
  // initEditForm bọc nó bằng useEffectEvent cho effect khởi tạo (chạy 1 lần
  // khi vào chế độ sửa, tránh reset form nếu identity của editOrder đổi giữa lúc nhập liệu).
  const applyEditData = (o: EditOrderData) => {
    // Khởi tạo form từ editOrder (đồng bộ, hợp lệ — chạy 1 lần khi vào chế độ sửa)
    setPartner({ code: o.cardCode, name: o.cardName })
    setDocDate((o.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setDocDueDate((o.docDueDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setRemarks(o.remarks ?? '')
    setHeaderWh(o.warehouseCode ?? '')
    setHeaderDiscPct(o.headerDiscPct ?? 0)
    setB2b(b2bFromSaved((o.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10), o))
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
      priceSource: 'manual', // không tự giải lại giá khi sửa đơn — giữ nguyên số liệu gốc
      dbId: l.dbId,
      sapLineNum: l.sapLineNum,
      // ---------- BOM ----------
      isBomChild: l.isBomChild ?? false,
      bomGroupKey: l.bomGroupKey ?? undefined,
      bomEditable: l.bomEditable ?? true,
      bomQtyPerParent: l.bomQtyPerParent ?? undefined,
      // Chỉ giữ liên kết nguồn khi SỬA đơn; "Nhân bản" (id rỗng) tạo đơn mới độc lập
      sourceLineId: o.id ? (l.sourceLineId ?? null) : null,
    }))
    // Suy loại BOM của dòng cha từ dòng con (production/assembly → con khóa SL)
    for (const pl of prefilled) {
      if (pl.isBomChild || !pl.bomGroupKey) continue
      const kids = prefilled.filter((k) => k.isBomChild && k.bomGroupKey === pl.bomGroupKey)
      if (kids.length > 0) {
        pl.bomType = kids.some((k) => k.bomEditable === false) ? 'production' : 'template'
      }
    }
    setLines(prefilled.length > 0 ? prefilled : [{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 }])
    setAtp({})
    setError('')
    setPartnerErr('')
    setFieldErr({})
    // Kiểm tra ATP cho các dòng đã điền
    for (const l of prefilled) if (l.item) void checkAtp(l.key, l.item.code, l.warehouseCode)
  }

  const initEditForm = useEffectEvent((o: NonNullable<typeof editOrder>) => {
    applyEditData(o)
  })

  // ---- "Sao chép từ…" (copy-from): điền dữ liệu prefill (?prefill=1) vào form ----
  // Chỉ dùng khi TẠO đơn mới. Giá giữ nguyên theo nguồn (priceSource 'manual'
  // để không tự giải lại giá), cấu trúc BOM được suy lại như khi sửa đơn.
  const applyCopyFrom = (p: PrefillDoc) => {
    setPartner({ code: p.cardCode, name: p.cardName } as ACOption)
    setDocDate((p.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setDocDueDate((p.docDueDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setRemarks(p.remarks ?? '')
    setHeaderWh(p.warehouseCode ?? '')
    setHeaderDiscPct(p.headerDiscPct ?? 0)
    // Copy-from: mang theo B2B của chứng từ nguồn (nếu API prefill có trả)
    setB2b(b2bFromSaved((p.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10), p as unknown as Parameters<typeof b2bFromSaved>[1]))
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
      priceSource: 'manual', // giữ nguyên giá/CK/thuế của chứng từ nguồn
      isBomChild: l.isBomChild ?? false,
      bomGroupKey: l.bomGroupKey ?? undefined,
      bomEditable: l.bomEditable ?? true,
      bomQtyPerParent: l.bomQtyPerParent ?? undefined,
      sourceLineId: (l as { sourceLineId?: string | null }).sourceLineId ?? null,
    }))
    // Suy loại BOM của dòng cha từ dòng con (giống applyEditData)
    for (const pl of prefilled) {
      if (pl.isBomChild || !pl.bomGroupKey) continue
      const kids = prefilled.filter((k) => k.isBomChild && k.bomGroupKey === pl.bomGroupKey)
      if (kids.length > 0) {
        pl.bomType = kids.some((k) => k.bomEditable === false) ? 'production' : 'template'
      }
    }
    setLines(prefilled.length > 0 ? prefilled : [{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 }])
    setAtp({})
    setError('')
    setPartnerErr('')
    setFieldErr({})
    setCopyFromInfo(p)
    setPickerOpen(false)
  }

  useEffect(() => {
    if (!editOrder) return
    initEditForm(editOrder)
  }, [editOrder])

  // ---- Draft nháp: tự lưu khi đang nhập, restore khi quay lại form ----
  // Đổi view (lỡ bấm sidebar...) unmount form → dữ liệu đang nhập không mất.
  // Key riêng theo user + chế độ (tạo mới / sửa đơn nào); xóa sau khi lưu thành công.
  interface OrderDraftLine {
    item: { code: string; name: string; uom?: string; taxCode?: string; barcode?: string } | null
    quantity: number
    unitPrice: number
    discPct: number
    vatPct: number
    taxCode?: string
    uom?: string
    warehouseCode?: string
    dbId?: string
    sapLineNum?: number
    isBomChild?: boolean
    bomGroupKey?: string
    bomEditable?: boolean
    bomQtyPerParent?: number
    sourceLineId?: string | null
  }
  interface OrderDraft {
    v: 1
    partner: { code: string; name: string } | null
    docDate: string
    docDueDate: string
    remarks: string
    headerWh: string
    headerDiscPct: number
    /** Thông tin B2B / SAP B1 (Đợt 2+3) */
    b2b?: B2BFormState
    lines: OrderDraftLine[]
  }
  const draftKey = userId
    ? `fm-order-draft-${userId}-${isEdit && editOrder?.id ? `edit-${editOrder.id}` : 'new'}`
    : null
  const [draftRestored, setDraftRestored] = useState(false)
  const hydratedRef = useRef(false)

  const clearDraft = () => {
    if (draftKey) {
      try { localStorage.removeItem(draftKey) } catch { /* bỏ qua */ }
    }
    setDraftRestored(false)
  }

  // Restore: chạy 1 lần sau mount, SAU effect initEditForm (khai báo sau nó)
  // để nháp của chính user thắng dữ liệu gốc khi quay lại form.
  useEffect(() => {
    if (!draftKey || hydratedRef.current) return
    hydratedRef.current = true
    try {
      const raw = localStorage.getItem(draftKey)
      if (!raw) return
      const d = JSON.parse(raw) as OrderDraft
      if (!d || d.v !== 1 || !Array.isArray(d.lines) || d.lines.length === 0) return
      // Chỉ restore khi nháp có nội dung thật (tránh ghi đè form trống bằng nháp trống)
      const meaningful = d.partner || (d.remarks ?? '').trim() || d.lines.some((l) => l.item)
      if (!meaningful) return
      if (d.partner) setPartner({ code: d.partner.code, name: d.partner.name })
      if (d.docDate) setDocDate(d.docDate)
      if (d.docDueDate) setDocDueDate(d.docDueDate)
      setRemarks(d.remarks ?? '')
      setHeaderWh(d.headerWh ?? '')
      setHeaderDiscPct(typeof d.headerDiscPct === 'number' ? d.headerDiscPct : 0)
      if (d.b2b) {
        const nb = { ...defaultB2BForm(d.docDate || ''), ...d.b2b }
        // sanitize nhẹ — tránh nháp cũ hỏng làm vỡ form
        if (!(B2B_CURRENCIES as readonly string[]).includes(nb.docCurrency)) nb.docCurrency = 'VND'
        if (!Array.isArray(nb.attachments)) nb.attachments = []
        setB2b(nb)
      }
      const restored: DraftLine[] = d.lines.map((l) => ({
        key: nextKey(),
        item: l.item ? { code: l.item.code, name: l.item.name, uom: l.item.uom ?? '', taxCode: l.item.taxCode ?? '' } : null,
        quantity: l.quantity ?? 1,
        unitPrice: l.unitPrice ?? 0,
        discPct: l.discPct ?? 0,
        vatPct: l.vatPct ?? 8,
        taxCode: l.taxCode,
        uom: l.uom,
        warehouseCode: l.warehouseCode,
        priceSource: 'manual', // giữ nguyên số liệu nháp, không giải lại giá
        dbId: l.dbId,
        sapLineNum: l.sapLineNum,
        isBomChild: l.isBomChild ?? false,
        bomGroupKey: l.bomGroupKey,
        bomEditable: l.bomEditable ?? true,
        bomQtyPerParent: l.bomQtyPerParent,
        sourceLineId: l.sourceLineId ?? null,
      }))
      setLines(restored)
      setDraftRestored(true)
      // Kiểm tra lại ATP cho các dòng đã khôi phục
      for (const l of restored) if (l.item) void checkAtp(l.key, l.item.code, l.warehouseCode)
    } catch { /* nháp hỏng → bỏ qua */ }
  }, [draftKey])

  // Tự lưu nháp (debounce 800ms) — đổi view giữa chừng vẫn kịp lưu
  useEffect(() => {
    if (!draftKey) return
    const t = setTimeout(() => {
      try {
        const d: OrderDraft = {
          v: 1,
          partner: partner ? { code: partner.code, name: partner.name } : null,
          docDate,
          docDueDate,
          remarks,
          headerWh,
          headerDiscPct,
          b2b,
          lines: lines.map((l) => ({
            item: l.item ? { code: l.item.code, name: l.item.name, uom: l.item.uom, taxCode: l.item.taxCode } : null,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discPct: l.discPct,
            vatPct: l.vatPct,
            taxCode: l.taxCode,
            uom: l.uom,
            warehouseCode: l.warehouseCode,
            dbId: l.dbId,
            sapLineNum: l.sapLineNum,
            isBomChild: l.isBomChild,
            bomGroupKey: l.bomGroupKey,
            bomEditable: l.bomEditable,
            bomQtyPerParent: l.bomQtyPerParent,
            sourceLineId: l.sourceLineId ?? null,
          })),
        }
        localStorage.setItem(draftKey, JSON.stringify(d))
      } catch { /* quota đầy → bỏ qua */ }
    }, 800)
    return () => clearTimeout(t)
  }, [draftKey, partner, docDate, docDueDate, remarks, headerWh, headerDiscPct, b2b, lines])

  // Bỏ nháp: xóa nháp + reset form về trạng thái ban đầu
  const discardDraft = () => {
    clearDraft()
    if (isEdit && editOrder) {
      applyEditData(editOrder)
    } else {
      setPartner(null)
      setPartnerErr('')
      setDocDate(new Date().toISOString().slice(0, 10))
      const dd = new Date()
      dd.setDate(dd.getDate() + 5)
      setDocDueDate(dd.toISOString().slice(0, 10))
      setRemarks('')
      setHeaderWh('')
      setHeaderDiscPct(0)
      setB2b(defaultB2BForm(new Date().toISOString().slice(0, 10)))
      setLines([{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8 }])
      setError('')
      setFieldErr({})
    }
  }

  // Đóng modal bằng Escape (WCAG — dialog phải đóng được bằng bàn phím)
  useEffect(() => {
    if (!tplModal && !priceHistFor) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTplModal(false)
        setPriceHistFor(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tplModal, priceHistFor])

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
    setLines((ls) => {
      const parent = ls.find((l) => l.key === key)
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l))
      // Đổi SL dòng cha BOM → tự quy đổi SL các dòng con theo công thức
      // (SL con = SL cha × định mức). Áp dụng cho cả Template và Production.
      if (parent?.bomType && parent.bomGroupKey && patch.quantity !== undefined) {
        const pq = Number(patch.quantity) || 0
        return next.map((l) =>
          l.isBomChild && l.bomGroupKey === parent.bomGroupKey
            ? { ...l, quantity: Math.round(pq * (l.bomQtyPerParent ?? 0) * 1000) / 1000 }
            : l,
        )
      }
      return next
    })
    setFieldErr((fe) => ({ ...fe, [key]: '' }))
  }

  // ---------- BOM: bung thành phần con khi chọn mặt hàng BOM ----------
  // - Template: hiện dòng con, cho sửa SL con, giá con = 0
  // - Production: hiện dòng con, KHÔNG cho sửa SL (khóa theo công thức), giá con = 0
  // Đổi SL cha → các dòng con tự quy đổi theo định mức (xử lý trong updateLine)
  const expandBom = async (parentKey: number, itemCode: string) => {
    // Xóa mặt hàng → gỡ nhóm con cũ ngay tại chỗ, không cần gọi API
    if (!itemCode) {
      setLines((ls) => {
        const parent = ls.find((l) => l.key === parentKey)
        if (!parent?.bomGroupKey) return ls
        return ls
          .filter((l) => l.key === parentKey || l.bomGroupKey !== parent.bomGroupKey)
          .map((l) => (l.key === parentKey ? { ...l, bomType: undefined, bomGroupKey: undefined } : l))
      })
      return
    }
    let def: { bomType?: string; components?: { childItemCode: string; childItemName: string; qtyPerParent: number; uom: string }[] } | null = null
    try {
      const res = await api(`/api/bom?parentItemCode=${encodeURIComponent(itemCode)}`)
      def = await res.json()
    } catch {
      return
    }
    const wh = headerWh || undefined
    // updater của setState phải pure (StrictMode double-invoke) → gom thông tin
    // dòng con ra biến ngoài rồi mới gọi checkAtp (side-effect) sau setLines
    let newChildren: { key: number; code: string; wh?: string }[] = []
    setLines((ls) => {
      const parent = ls.find((l) => l.key === parentKey)
      // Người dùng đã đổi sang mặt hàng khác trong lúc chờ → bỏ qua
      if (!parent || parent.item?.code !== itemCode) return ls
      // Gỡ nhóm con cũ (nếu đổi từ BOM này sang BOM khác / hàng thường)
      const withoutOld = parent.bomGroupKey
        ? ls.filter((l) => l.key === parentKey || l.bomGroupKey !== parent.bomGroupKey)
        : ls
      const isBom = def?.bomType === 'template' || def?.bomType === 'production' || def?.bomType === 'assembly'
      const groupKey = `bom_${parentKey}`
      const parentQty = Number(parent.quantity) || 0
      const children: DraftLine[] = isBom
        ? (def!.components ?? []).map((c) => ({
            key: nextKey(),
            item: { code: c.childItemCode, name: c.childItemName || c.childItemCode, uom: c.uom || '' },
            quantity: Math.round(parentQty * Number(c.qtyPerParent || 0) * 1000) / 1000,
            unitPrice: 0, // thành phần con giá bán luôn = 0
            discPct: 0,
            vatPct: 0,
            uom: c.uom || undefined,
            warehouseCode: parent.warehouseCode || wh,
            isBomChild: true,
            bomGroupKey: groupKey,
            bomEditable: def!.bomType === 'template',
            bomQtyPerParent: Number(c.qtyPerParent || 0),
          }))
        : []
      const idx = withoutOld.findIndex((l) => l.key === parentKey)
      const next = [...withoutOld]
      next.splice(idx + 1, 0, ...children)
      next[idx] = {
        ...next[idx],
        bomType: isBom ? (def!.bomType as 'template' | 'production' | 'assembly') : undefined,
        bomGroupKey: isBom ? groupKey : undefined,
      }
      newChildren = children.map((ch) => ({ key: ch.key, code: ch.item!.code, wh: ch.warehouseCode }))
      return next
    })
    // Kiểm tra ATP cho các thành phần con mới bung
    for (const ch of newChildren) void checkAtp(ch.key, ch.code, ch.wh)
    setFieldErr((fe) => ({ ...fe, [parentKey]: '' }))
  }

  /** Dòng đang mở chi tiết (ĐVT, kho, ATP, thuế) */
  const expandedLines = useExpandedLines()

  /** Chọn mặt hàng cho dòng (dùng chung ô tìm trong dòng và ô thêm dòng nhanh) */
  const selectItem = (key: number, v: ACOption | null, whOverride?: string) => {
    const cur = lines.find((x) => x.key === key)
    // chọn mặt hàng → tự load đơn giá (Price List 1 / OSPP), VAT% (qua mã thuế),
    // mã nhóm thuế (SalesVATGroup), đơn vị tính (SalesUnit) + KHO theo header
    const vat = typeof v?.vatRate === 'number' ? v.vatRate : null
    const wh = whOverride || cur?.warehouseCode || headerWh || undefined
    updateLine(key, {
      item: v,
      unitPrice: v?.price ?? 0,
      priceSource: v ? 'pricelist' : undefined,
      refPrice: v?.price && v.price > 0 ? v.price : undefined,
      taxCode: v?.taxCode || undefined,
      uom: v?.uom || undefined,
      warehouseCode: wh,
      ...(vat !== null ? { vatPct: vat, vatOverridden: false } : {}),
    })
    if (v) {
      void resolvePrice(key, v.code, partner?.code ?? null)
      void checkAtp(key, v.code, wh) // ATP check tự động sau khi chọn mặt hàng
      // Mặt hàng BOM → tự bung thành phần con (Template/Production)
      void expandBom(key, v.code)
    } else {
      // Xóa mặt hàng → gỡ luôn nhóm con BOM cũ
      void expandBom(key, '')
    }
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
    const cur = lines.find((x) => x.key === key)
    const wh = cur?.warehouseCode || headerWh || undefined
    updateLine(key, {
      item: v,
      uom: v.uom || undefined,
      taxCode: v.taxCode || undefined,
      ...(typeof v.vatRate === 'number' ? { vatPct: v.vatRate, vatOverridden: false } : {}),
    })
    void checkAtp(key, v.code, wh)
    setSwapKey(null)
  }

  /**
   * "Đặt lại đơn gần nhất": thêm nhiều mặt hàng 1 lượt (thay toàn bộ dòng hoặc nối thêm).
   * Mỗi dòng đi qua selectItem như khi chọn tay → giá đặc biệt/bảng giá, thuế, ATP,
   * bung BOM theo công thức hiện hành.
   */
  /**
   * Thêm nhiều mặt hàng 1 lượt (dán danh sách / đặt lại đơn cũ): mỗi dòng đi qua
   * selectItem như khi chọn tay → giá, thuế, ĐVT, kho, ATP, bung BOM.
   */
  const addItemsBatch = (
    entries: { item: ACOption; quantity: number; warehouseCode?: string | null }[],
    mode: 'replace' | 'append' = 'append',
  ) => {
    const fresh = entries.map((e) => ({
      key: nextKey(), item: null, quantity: e.quantity, unitPrice: 0, discPct: 0, vatPct: 8,
      warehouseCode: e.warehouseCode || headerWh || undefined,
    }))
    // Bỏ dòng trống đang nhập dở khi nối thêm
    setLines((ls) => [...(mode === 'replace' ? [] : ls.filter((x) => x.item || x.isBomChild)), ...fresh])
    if (mode === 'replace') setAtp({})
    fresh.forEach((nl, i) => selectItem(nl.key, entries[i].item, nl.warehouseCode))
  }

  const applyRecentOrder = (order: RecentOrder, mode: 'replace' | 'append') => {
    const usable = order.lines.filter((l) => l.available && l.quantity > 0)
    addItemsBatch(usable.map((l) => ({ item: recentLineToOption(l), quantity: l.quantity, warehouseCode: l.warehouseCode })), mode)
    const skipped = order.lines.length - usable.length
    setTplMsg({
      type: 'success',
      text: `${mode === 'replace' ? 'Đã dùng lại' : 'Đã thêm'} ${usable.length} dòng từ đơn #${order.docNum ?? ''}`
        + (skipped ? ` — bỏ qua ${skipped} mặt hàng không còn trong danh mục bán.` : '.')
        + ' Giá đã tính lại theo bảng giá hiện tại.',
    })
  }

  /** Thêm dòng nhanh: điền vào dòng trống đầu tiên (nếu có) hoặc thêm dòng mới cuối bảng */
  const quickAddLine = (v: ACOption, quantity: number) => {
    const empty = lines.find((x) => !x.item && !x.isBomChild)
    const key = empty?.key ?? nextKey()
    setLines((ls) =>
      empty
        ? ls.map((x) => (x.key === key ? { ...x, quantity } : x))
        : [...ls, { key, item: null, quantity, unitPrice: 0, discPct: 0, vatPct: 8, warehouseCode: headerWh || undefined }],
    )
    selectItem(key, v)
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

  const removeLine = (key: number) => {
    setAtp((m) => {
      const nv = { ...m }
      delete nv[key]
      return nv
    })
    // Xóa dòng cha BOM → xóa cả nhóm thành phần con
    setLines((ls) => {
      const target = ls.find((l) => l.key === key)
      const gk = target?.bomGroupKey
      const next = gk ? ls.filter((l) => l.bomGroupKey !== gk) : ls.filter((l) => l.key !== key)
      return next.length > 0
        ? next
        : [{ key: nextKey(), item: null, quantity: 1, unitPrice: 0, discPct: 0, vatPct: 8, warehouseCode: headerWh || undefined }]
    })
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
        /* chưa cấu hình SAP / lỗi mạng — để trống, user vẫn nhập đơn được */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Đổi kho trên header → áp dụng cho TẤT CẢ dòng hàng + kiểm tra lại ATP
  const applyHeaderWarehouse = (code: string) => {
    setHeaderWh(code)
    // checkAtp GỌI NGOÀI updater: updater của setState phải pure —
    // StrictMode double-invoke updater sẽ làm API ATP bị gọi trùng lặp
    for (const l of lines) {
      if (l.item) void checkAtp(l.key, l.item.code, code)
    }
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

  // Đổi ngày chứng từ → Ngày tính thuế (SAP TaxDate) mặc định theo;
  // chỉ tự đồng bộ khi user chưa sửa tay ô Ngày tính thuế
  const onDocDateChange = (v: string) => {
    setDocDate(v)
    setB2b((b) => (b.taxDateManual ? b : { ...b, taxDate: v }))
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
            l.key === key && l.item?.code === itemCode ? { ...l, unitPrice: json.price, priceSource: json.source, refPrice: json.price } : l,
          ),
        )
      }
    } catch {
      /* giữ nguyên đơn giá hiện tại */
    }
  }

  // Phím tắt nhập liệu: Alt+N/Alt+K, Ctrl+Enter lưu, Ctrl+Shift+Enter lưu nháp, Enter giữa các dòng, ?
  const shortcuts = useFormShortcuts({
    onSave: () => void save(isEdit && Boolean(editOrder?.isDraft)),
    onSaveDraft: !isEdit ? () => void save(true) : undefined,
    disabled: saving,
  })

  /** Kiểm tra trước khi lưu: danh sách lỗi + cảnh báo đang hiển thị (null = đóng) */
  const [precheck, setPrecheck] = useState<PrecheckIssue[] | null>(null)

  /** Phase 2 — asDraft=true → gọi API với ?draft=true (lưu nháp) */
  const save = async (asDraft = false, opts?: { skipPrecheck?: boolean }) => {
    // Lưu chính thức: gom mọi lỗi/cảnh báo 1 lần trước khi gửi (nháp thì bỏ qua)
    if (!asDraft && !opts?.skipPrecheck) {
      const issues = precheckOrder({
        hasPartner: Boolean(partner),
        docDate,
        docDueDate,
        today: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }),
        lines: lines.filter((l) => l.item).map((l) => ({
          key: l.key,
          itemCode: l.item!.code,
          itemName: l.item!.name,
          quantity: l.quantity,
          unitPrice: l.isBomChild ? 0 : l.unitPrice,
          refPrice: l.refPrice,
          priceSource: l.priceSource,
          isBomChild: l.isBomChild,
          warehouseCode: l.warehouseCode || headerWh || null,
          atpAvailable: atp[l.key]?.status === 'ok' ? (pickAtpRow(atp[l.key], l, headerWh)?.available ?? 0) : null,
        })),
      })
      if (issues.length > 0) { setPrecheck(issues); return }
    }
    setError('')
    setVersionConflict(false)
    setPartnerErr('')
    if (!partner) { setPartnerErr('Vui lòng chọn khách hàng từ danh sách'); return }
    const valid = lines.filter((l) => l.item && l.quantity > 0)
    if (valid.length === 0) {
      setError('Đơn hàng cần ít nhất 1 dòng hàng hóa có mã hàng và số lượng > 0')
      return
    }
    const negPrice = valid.find((l) => l.unitPrice < 0)
    if (negPrice) {
      setError(`Đơn giá không được âm (dòng ${negPrice.item?.code ?? ''}) — hãy sửa lại trước khi lưu`)
      return
    }
    // B2B / SAP B1: validate + dựng payload (tỷ giá bắt buộc > 0 khi tiền tệ ≠ VND)
    const { payload: b2bPayload, error: b2bError } = buildB2BPayload(b2b)
    if (b2bError) {
      setError(b2bError)
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
        ...b2bPayload,
        ...(isEdit && typeof editOrder!.version === 'number' ? { version: editOrder!.version } : {}),
        lines: valid.map((l) => ({
          ...(isEdit ? { dbId: l.dbId, sapLineNum: l.sapLineNum } : {}),
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
          isBomChild: l.isBomChild ?? false,
          bomGroupKey: l.bomGroupKey ?? null,
          bomEditable: l.bomEditable ?? true,
          bomQtyPerParent: l.bomQtyPerParent ?? null,
          // Copy-from báo giá: giữ liên kết dòng nguồn để đẩy SAP gắn BaseType/BaseEntry/BaseLine
          sourceLineId: l.sourceLineId ?? null,
        })),
      }
      const baseUrl = isEdit ? `/api/orders/${editOrder!.id}` : '/api/orders'
      const res = await api(asDraft ? `${baseUrl}?draft=true` : baseUrl, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()
      if (!res.ok) {
        // 409 VERSION_CONFLICT: đơn đã bị sửa bởi người khác
        if (res.status === 409 && json.code === 'VERSION_CONFLICT') {
          setVersionConflict(true)
          setError('Đơn hàng đã bị sửa bởi người khác — vui lòng tải lại đơn hàng rồi thử lại')
        } else {
          setError(json.error ?? (isEdit ? 'Không thể cập nhật đơn hàng bán' : 'Không thể tạo đơn hàng bán'))
        }
        return
      }
      const o = json.order
      clearDraft() // lưu thành công → xóa nháp
      onSaved({
        id: o.id ?? null,
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

  // Tải lại dữ liệu mới nhất của đơn sau xung đột 409 — form reset về
  // trạng thái server mới nhất (kèm version mới) để user xem lại rồi sửa tiếp.
  const reloadLatest = async () => {
    if (!isEdit || !editOrder?.id) return
    setReloading(true)
    try {
      const r = await api(`/api/orders/${editOrder.id}`)
      if (r.ok) {
        const j = await r.json()
        const o = j.order ?? j
        applyEditData(toEditData(o))
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
  // (contract: PATCH /api/orders/{id}/finalize { version } — do WORKER A triển khai)
  const finalizeOrder = async () => {
    if (!isEdit || !editOrder?.id || finalizing) return
    setFinalizing(true)
    try {
      const r = await api(`/api/orders/${editOrder.id}/finalize`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: editOrder.version ?? 0 }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.ok) {
        setError(j.error ?? 'Không thể chuyển đơn hàng bán thành chứng từ chính thức')
        return
      }
      // Tải lại dữ liệu mới nhất — bản ghi giờ đã là chính thức (isDraft=false)
      await reloadLatest()
      setError('')
    } catch {
      setError('Không thể kết nối máy chủ')
    } finally {
      setFinalizing(false)
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

  // M4: paddingBottom = chỗ cuộn thêm để sticky action bar không che nội dung cuối form
  return (
    <div style={{ paddingBottom: 96 }}>
      <PageHeader
        breadcrumb={['Chức năng chính', isEdit ? `Sửa đơn hàng bán #${editOrder?.docNum}` : 'Tạo đơn hàng bán mới']}
        title={isEdit ? `Cập nhật đơn hàng bán #${editOrder?.docNum}` : 'Tạo đơn hàng bán mới'}
/>
      {error && (
        <div className="fm-alert fm-alert--error" role="alert">
          <div><b>{isEdit ? 'Không thể cập nhật đơn hàng bán' : 'Không thể lưu đơn hàng bán'}</b>{error}</div>
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

      {draftRestored && (
        <div className="fm-alert fm-alert--info" role="status" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>Đã khôi phục bản nháp chưa lưu của bạn.</div>
          <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={discardDraft}>Bỏ nháp</button>
        </div>
      )}

      {/* "Sao chép từ…" (copy-from): dữ liệu đã điền sẵn từ chứng từ nguồn */}
      {!isEdit && copyFromInfo && (
        <div className="fm-alert fm-alert--info" role="status" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>
            <b>Tạo từ {copyFromInfo.sourceLabel}
              {copyFromInfo.sourceDocNum != null ? ` #${copyFromInfo.sourceDocNum}` : ''} — {copyFromInfo.cardName}</b>
            {' '}— dữ liệu đã điền sẵn (giữ giá/CK/thuế/kho của chứng từ nguồn). Kiểm tra lại rồi bấm Lưu.
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
        <CopyFromPicker targetType="order" onPick={applyCopyFrom} onClose={() => setPickerOpen(false)} />
      )}

      {/* Phase 2 — banner bản nháp máy chủ + nút chuyển thành chứng từ chính thức */}
      {isEdit && editOrder?.isDraft && (
        <div className="fm-alert fm-alert--warning" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }} role="status">
          <div style={{ flex: 1 }}>
            <b><span className="fm-chip fm-chip--warn">Nháp</span></b>{' '}
            Đây là bản nháp — chưa có hiệu lực, chưa đẩy được sang SAP B1.
          </div>
          <button
            type="button"
            className="fm-btn fm-btn--primary fm-btn--sm"
            onClick={() => void finalizeOrder()}
            disabled={finalizing || saving}
          >
            {finalizing ? 'Đang chuyển…' : 'Chuyển thành chứng từ chính thức'}
          </button>
        </div>
      )}

      {isEdit && editOrder && (
        <div className="fm-alert fm-alert--success" style={{ marginBottom: 14 }}>
          <div>
            <b>Đang sửa đơn hàng bán #{editOrder.docNum}</b>
            {editOrder.sapSyncStatus === 'synced'
              ? ' — Lưu thay đổi sẽ cập nhật trực tiếp chứng từ trên SAP B1 (PATCH /Orders). Chỉ được sửa khi chứng từ còn Mở trên SAP.'
              : ' — Đơn chưa đẩy sang SAP B1, lưu thay đổi chỉ áp dụng trên hệ thống này.'}
          </div>
        </div>
      )}

      {/* Bước 1 — Khách hàng & thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingCart size={18} /> Bước 1 — Thông tin chung
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
              disabled={saving}
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
            <button
              type="button"
              className="fm-btn fm-btn--secondary fm-btn--sm"
              onClick={() => setPickerOpen(true)}
              disabled={saving}
              title="Sao chép dữ liệu từ báo giá bán hàng (không tạo chứng từ ngay)"
            >
              <Copy size={14} /> Sao chép từ…
            </button>
          </div>
        )}
        {tplMsg && (
          <div className={`fm-alert ${tplMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} style={{ marginBottom: 12 }} role={tplMsg.type === 'error' ? 'alert' : 'status'}>
            <div>{tplMsg.text}</div>
            <button className="fm-btn fm-btn--ghost fm-btn--sm fm-ml-auto" aria-label="Đóng thông báo" onClick={() => setTplMsg(null)}>✕</button>
          </div>
        )}

        <div className="fm-form-grid">
          <Autocomplete
            label="Khách hàng"
            required
            placeholder="Gõ mã khách hàng hoặc tên khách hàng…"
            fetchUrl="/api/partners"
            value={partner}
            disabled={saving}
            onChange={(v) => {
              // người dùng chọn KH khác → điền địa chỉ/người liên hệ mặc định của KH mới
              if (v?.code !== partner?.code) party.requestDefaults()
              setPartner(v)
              setPartnerErr('')
              // đổi khách hàng → tính lại giá (đặc biệt → bảng giá) cho các dòng chưa sửa giá tay
              if (v) for (const line of lines) if (line.item && line.priceSource !== 'manual') void resolvePrice(line.key, line.item.code, v.code)
            }}
            error={partnerErr || undefined}
          />
          {/* Thông tin khách hàng: địa chỉ + người liên hệ (từ đồng bộ SAP B1) */}
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-partner-addr">Địa chỉ</label>
            <input id="fm-partner-addr" className="fm-input" value={partner?.address || ''} readOnly placeholder="—" tabIndex={-1} />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-doc-date">Ngày chứng từ <span className="fm-label__req">*</span></label>
            <input id="fm-doc-date" type="date" className="fm-datepicker" value={docDate} onChange={(e) => onDocDateChange(e.target.value)} disabled={saving} />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-doc-due-date">Ngày giao hàng <span className="fm-label__req">*</span></label>
            <input id="fm-doc-due-date" type="date" className="fm-datepicker" value={docDueDate} onChange={(e) => setDocDueDate(e.target.value)} disabled={saving} />
            {!isEdit && (
              <DeliveryHint
                cardCode={partner?.code}
                docDate={docDate}
                docDueDate={docDueDate}
                headerWh={headerWh}
                warehouseCodes={warehouses.map((w) => w.warehouseCode)}
                disabled={saving}
                onApply={(due, wh) => {
                  setDocDueDate(due)
                  if (wh && wh !== headerWh) applyHeaderWarehouse(wh)
                }}
              />
            )}
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-header-wh" title="Kho hàng xuất bán (OWHS) — mặc định áp dụng cho toàn bộ dòng hàng ở Bước 2">Kho hàng xuất bán</label>
            <select
              id="fm-header-wh"
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
              disabled={saving}
            />
          </div>
        </div>

        <div className="fm-field">
          <label className="fm-label" htmlFor="fm-remarks">Ghi chú</label>
          <textarea id="fm-remarks" className="fm-input" rows={2} placeholder="Yêu cầu giao hàng, hóa đơn VAT…" value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={saving} />
        </div>
      </div>

      {/* Thông tin B2B / SAP B1 (Đợt 2+3) */}
      <B2BFieldsSection
        b2b={b2b}
        onChange={setB2bField}
        saving={saving}
        idPrefix="fm-b2b"
        salesPersons={salesPersons}
        spListFailed={spListFailed}
        paymentTerms={paymentTerms}
        ptListFailed={ptListFailed}
        partyInfo={party.info}
        partyLoading={party.loading}
        hasPartner={!!partner}
      />

      {/* Bước 2 — Dòng hàng hóa (CK% + VAT% theo từng dòng) */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingBasket size={18} /> Bước 2 — Hàng hóa
        </h2>

        {/* Đặt lại đơn gần nhất của khách (chỉ khi TẠO đơn mới) */}
        {!isEdit && <RecentOrdersPanel cardCode={partner?.code} disabled={saving} onUse={applyRecentOrder} />}

        {/* Giỏ hàng quen: nhập SL nhiều mặt hàng khách hay mua → thêm 1 lượt */}
        <CustomerBasket
          cardCode={partner?.code}
          disabled={saving}
          inOrder={new Set(lines.filter((l) => l.item && !l.isBomChild).map((l) => l.item!.code))}
          onAdd={(entries) => addItemsBatch(entries)}
        />

        <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
          <table className="fm-table fm-stack-table fm-stack-table--form fm-line-table">
            <thead>
              <tr>
                <th className="fm-col-no">#</th>
                <th style={{ minWidth: 240 }}>Hàng hóa</th>
                <th className="fm-col-barcode" title="Mã vạch (BarCode) của mặt hàng — quét/gõ mã vạch ở ô tìm để chọn nhanh">Barcode</th>
                <th className="fm-col-qty fm-num">Số lượng</th>
                <th className="fm-col-price fm-num" style={{ width: 170 }}>Đơn giá (₫)</th>
                <th className="fm-col-disc fm-num" title="Chiết khấu áp dụng riêng cho dòng này">CK (%)</th>
                <th className="fm-col-total fm-num">Thành tiền (₫)</th>
                <th className="fm-col-del"><span className="fm-sr-only">Xóa dòng</span></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                // Chỉ vẽ dòng con của BOM Template (Production/Assembly ẩn — vẫn
                // giữ trong data để submit/validate) và nhóm đang mở rộng.
                const vis = visibleBomLines(lines, bomCollapsed)
                const childCounts = bomChildCounts(lines)
                const parentCodes = new Map(
                  lines.filter((x) => !x.isBomChild && x.bomGroupKey).map((x) => [x.bomGroupKey as string, x.item?.code ?? '']),
                )
                let stt = 0
                return vis.map((l) => {
                const invalid = Boolean(fieldErr[l.key])
                /** Số lượng: dòng đã chọn hàng mà SL ≤ 0 thì không lưu được → coi là lỗi validate */
                const qtyInvalid = Boolean(l.item) && l.quantity <= 0
                /** Đơn giá âm: không cho lưu */
                const priceInvalid = !l.isBomChild && l.unitPrice < 0
                const lineTotal = l.quantity * l.unitPrice
                const discAmt = Math.round((lineTotal * clampPct(l.discPct)) / 100)
                const afterDisc = lineTotal - discAmt
                const isChild = Boolean(l.isBomChild)
                if (!isChild) stt += 1
                /** Dòng cha BOM Template có thành phần hiển thị → nút thu gọn/mở rộng */
                const showToggle = !isChild && l.bomType === 'template' && (childCounts.get(l.bomGroupKey as string) ?? 0) > 0
                const detailId = `fm-line-detail-${l.key}`
                const expanded = expandedLines.isOpen(l.key)
                const atpLow = (() => {
                  const a = atp[l.key]
                  if (!l.item || a?.status !== 'ok') return false
                  const row = pickAtpRow(a, l, headerWh)
                  return !row || row.available - l.quantity < 0
                })()
                return (
                  <Fragment key={l.key}>
                  <tr data-line-key={l.key} className={`${l.item ? '' : 'is-draft'}${isChild ? ' is-bom-child' : ''}${showToggle ? ' is-bom-parent' : ''}`}>
                    <td data-label="Dòng">
                      <div className="fm-bom-parent-no">
                        <LineExpandButton
                          expanded={expanded}
                          onToggle={() => expandedLines.toggle(l.key)}
                          lineNo={stt}
                          controls={detailId}
                          hideNo={isChild}
                          hasIssue={Boolean(l.vatOverridden) || atpLow}
                        />
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
                          uom={l.uom || l.item?.uom}
                          parentCode={parentCodes.get(l.bomGroupKey as string)}
                          onSwap={canSwapBom && l.bomEditable !== false ? () => setSwapKey(l.key) : undefined}
                          disabled={saving}
                        />
                      ) : (
                      <>
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
                      </>
                    )}
                      {l.item && !expanded && (
                        <div className="fm-line-summary">
                          {[l.uom || l.item.uom, (l.warehouseCode || headerWh) && `Kho ${l.warehouseCode || headerWh}`, l.taxCode && `${l.taxCode} · ${l.vatPct ?? '?'}%`].filter(Boolean).join(' · ')}
                          {(() => {
                            const a = atp[l.key]
                            if (a?.status !== 'ok') return null
                            const row = pickAtpRow(a, l, headerWh)
                            if (!row) return null
                            const enough = row.available - l.quantity >= 0
                            return (
                              <span className={`fm-line-meta ${enough ? 'fm-atp--ok' : 'fm-atp--low'}`} style={{ marginLeft: 6 }} title={atpTooltip(a, row)}>
                                {enough ? 'ATP ' : 'Thiếu '}{formatNum(enough ? row.available : -(row.available - l.quantity))}
                              </span>
                            )
                          })()}
                        </div>
                      )}
                    </td>
                    <td data-label="Barcode" className="fm-line-barcode">{l.item?.barcode || '—'}</td>
                    <td data-label="Số lượng" className="fm-num">
                      <input
                        type="number"
                        min={0}
                        step="0.5"
                        inputMode="decimal"
                        aria-label={`Số lượng dòng ${l.key}`}
                        aria-invalid={qtyInvalid || undefined}
                        aria-describedby={qtyInvalid ? `fm-line-${l.key}-qty-err` : undefined}
                        className="fm-line-input"
                        style={{ ...(qtyInvalid ? { borderColor: 'var(--fm-coral)', background: 'var(--fm-coral-soft)' } : {}) }}
                        value={l.quantity || ''}
                        disabled={saving || (l.isBomChild && l.bomEditable === false)}
                        title={qtyInvalid ? 'Số lượng phải lớn hơn 0' : l.isBomChild && l.bomEditable === false ? 'BOM Production/Assembly: số lượng khóa theo công thức (đổi số lượng dòng cha để quy đổi)' : l.isBomChild ? 'BOM Template: được chỉnh số lượng thành phần' : undefined}
                        onChange={(e) => updateLine(l.key, { quantity: Number(e.target.value) || 0 })}
                      />
                      {qtyInvalid && (
                        <span id={`fm-line-${l.key}-qty-err`} className="fm-sr-only">
                          Số lượng dòng {l.key} phải lớn hơn 0 thì dòng mới được lưu
                        </span>
                      )}
                    </td>
                    <td data-label="Đơn giá (₫)" className="fm-num">
                      {l.isBomChild ? (
                        <span className="fm-line-meta" title="Thành phần BOM: giá bán luôn = 0đ">0</span>
                      ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <input
                          type="number"
                          min={0}
                          step="1000"
                          inputMode="decimal"
                          aria-label={`Đơn giá dòng ${l.key}`}
                          aria-invalid={priceInvalid || undefined}
                          aria-describedby={priceInvalid ? `fm-line-${l.key}-price-err` : undefined}
                          className="fm-line-input"
                          style={{ flex: 1, minWidth: 0, ...(priceInvalid ? { borderColor: 'var(--fm-coral)', background: 'var(--fm-coral-soft)' } : {}) }}
                          value={l.unitPrice || ''}
                          title={priceInvalid ? 'Đơn giá không được âm' : l.priceSource === 'special' ? 'Giá đặc biệt theo khách hàng (SAP OSPP)' : l.item ? 'Giá từ Price List 1' : undefined}
                          disabled={saving}
                          onChange={(e) => updateLine(l.key, { unitPrice: Number(e.target.value) || 0, priceSource: l.item ? 'manual' : undefined })}
                        />
                        {priceInvalid && (
                          <span id={`fm-line-${l.key}-price-err`} className="fm-sr-only">
                            Đơn giá dòng {l.key} không được âm
                          </span>
                        )}
                        {l.priceSource === 'special' && (
                          <span className="fm-price-star" title="Giá đặc biệt theo khách hàng (SAP OSPP)">★</span>
                        )}
                        {l.item && partner?.code && (() => {
                          const it = l.item
                          return (
                            <button
                              type="button"
                              className="fm-icon-btn fm-icon-btn--xs"
                              title="Lịch sử giá đã bán cho khách hàng này"
                              aria-label={`Lịch sử giá ${it.code}`}
                              disabled={saving}
                              onClick={() => openPriceHist(l.key, it.code, it.name)}
                            >
                              <History size={14} />
                            </button>
                          )
                        })()}
                      </div>
                      )}
                    </td>
                    <td data-label="CK (%)" className="fm-num">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="1"
                        inputMode="decimal"
                        aria-label={`Chiết khấu % dòng ${l.key}`}
                        className="fm-line-input fm-line-input--pct"
                        value={l.discPct || ''}
                        disabled={saving || Boolean(l.isBomChild)}
                        title={l.isBomChild ? 'Thành phần BOM: không chiết khấu (giá = 0)' : undefined}
                        onChange={(e) => updateLine(l.key, { discPct: clampPct(Number(e.target.value)) })}
                      />
                    </td>
                    <td className="fm-num fm-line-total" data-label="Thành tiền (₫)">{l.item ? formatVND(afterDisc) : '—'}</td>
                    <td data-label="Xóa dòng">
                      {l.isBomChild ? (
                        <span className="fm-line-meta" title="Xóa dòng cha để gỡ cả nhóm BOM">—</span>
                      ) : (
                      <button className="fm-row-del" title="Xóa dòng" aria-label={`Xóa dòng ${l.key}`} onClick={() => removeLine(l.key)} disabled={saving || lines.length <= 1}>
                        <Trash2 size={14} />
                      </button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <LineDetailRow id={detailId} colSpan={8}>
                        <LineDetailField label="Đơn vị tính" title="Đơn vị tính (MeasureUnit) — để trống để SAP dùng mặc định của mặt hàng">
                          {l.item ? (
                            <input
                              className="fm-line-input"
                              style={{ maxWidth: 80 }}
                              value={l.uom || l.item.uom || ''}
                              onChange={(e) => updateLine(l.key, { uom: e.target.value || undefined })}
                              disabled={saving}
                              title="Đơn vị tính (MeasureUnit) — có thể sửa; để trống để SAP dùng mặc định của mặt hàng"
                              aria-label={`Đơn vị tính dòng ${l.key}`}
                            />
                          ) : (
                            '—'
                          )}
                        </LineDetailField>
                        <LineDetailField label="Kho" title="Kho xuất của dòng (WarehouseCode) — mặc định theo header">
                          <select
                            className="fm-line-select"
                            value={l.warehouseCode ?? headerWh ?? ''}
                            title="Kho xuất của dòng (WarehouseCode) — mặc định theo header"
                            disabled={saving || warehouses.length === 0}
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
                        </LineDetailField>
                        <LineDetailField label="Tồn kho (ATP)" title="ATP — tồn kho khả dụng: Tồn − đã cam kết + đang đặt">
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
                                disabled={saving}
                                onClick={() => l.item && checkAtp(l.key, l.item.code, l.warehouseCode || headerWh || undefined)}
                              >
                                <RefreshCw size={14} />
                              </button>
                            </div>
                          )}
                        </LineDetailField>
                        <LineDetailField label="Mã thuế" title="Mã nhóm thuế (SalesVATGroup) của mặt hàng trong SAP B1">
                          {l.item && l.taxCode ? (
                            <span className="fm-line-meta" title={`Mã nhóm thuế SAP (SalesVATGroup) — thuế suất ${l.vatPct ?? '?'}%`}>
                              {l.taxCode}
                              <small style={{ color: 'var(--fm-text-3)' }}> · {l.vatPct ?? '?'}%</small>
                            </span>
                          ) : (
                            '—'
                          )}
                        </LineDetailField>
                        <LineDetailField label="Thuế (%)" title="Thuế suất VAT của dòng — tự điền theo mã thuế, có thể sửa tay">
                          <input
                            type="number"
                            aria-label={`VAT % dòng ${l.key}`}
                            className="fm-line-input fm-line-input--pct"
                            value={l.vatPct || ''}
                            disabled={saving}
                            title={l.vatOverridden ? 'Đã ghi đè thuế suất từ mã thuế' : 'VAT % tự điền theo mã thuế — có thể sửa tay'}
                            onChange={(e) => updateLine(l.key, { vatPct: clampPct(Number(e.target.value)), vatOverridden: true })}
                          />
                          {l.vatOverridden && (
                            <div style={{ fontSize: 11, color: 'var(--fm-gold-ink)', lineHeight: 1.3, marginTop: 2 }}>
                              Đã ghi đè thuế suất từ mã thuế
                            </div>
                          )}
                        </LineDetailField>
                    </LineDetailRow>
                  )}
                  </Fragment>
                )
                })
              })()}
            </tbody>
          </table>
        </div>

        {precheck && (
          <PrecheckDialog
            issues={precheck}
            onClose={() => setPrecheck(null)}
            onProceed={() => { setPrecheck(null); void save(isEdit && Boolean(editOrder?.isDraft), { skipPrecheck: true }) }}
          />
        )}
        <LineQuickAdd
          onAdd={quickAddLine}
          onAddMany={(entries) => {
            addItemsBatch(entries)
            setTplMsg({ type: 'success', text: `Đã thêm ${entries.length} dòng từ danh sách dán. Giá đã tính theo bảng giá hiện tại.` })
          }}
          disabled={saving}
        />
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
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => fileRef.current?.click()} disabled={saving || importProgress !== null}>
            <Upload size={14} /> {importProgress ? 'Đang nhập…' : 'Nhập từ Excel'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={handleExcelImport}
          />
        </div>
        {importProgress && (
          <div className="fm-alert fm-alert--info" style={{ marginTop: 10 }} role="status">
            <div>Đang tra cứu mã hàng {importProgress.current}/{importProgress.total}…</div>
          </div>
        )}
        {importMsg && (
          <div className={`fm-alert ${importMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} style={{ marginTop: 10 }} role={importMsg.type === 'error' ? 'alert' : 'status'}>
            <div>{importMsg.text}</div>
            <button className="fm-btn fm-btn--ghost fm-btn--sm fm-ml-auto" aria-label="Đóng thông báo" onClick={() => setImportMsg(null)}>✕</button>
          </div>
        )}
        {importErrors && importErrors.length > 0 && (
          <div className="fm-alert fm-alert--error" style={{ marginTop: 10 }} role="alert">
            <div>
              <b>{importErrors.length} dòng lỗi:</b>{' '}
              {importErrors.slice(0, 5).join('; ')}
              {importErrors.length > 5 ? ` (+${importErrors.length - 5} dòng nữa)` : ''}
            </div>
            <button className="fm-btn fm-btn--ghost fm-btn--sm fm-ml-auto" aria-label="Đóng thông báo" onClick={() => setImportErrors(null)}>✕</button>
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
            <div className="fm-totals__row"><span>Thuế các dòng</span><b>{formatVND(totals.vatAmt)}</b></div>
            <div className="fm-totals__grand"><span>Tổng chứng từ</span><span>{formatVND(totals.grand)}</span></div>
          </div>
        </div>

        {lines.some((l) => l.item && atp[l.key]?.status === 'error') && (
          <div className="fm-alert fm-alert--warning" role="alert" style={{ marginTop: 14 }}>
            <div><b>Lưu ý tồn kho (ATP):</b> có dòng hàng không kiểm tra được tồn kho khả dụng — kiểm tra lại tồn kho trên SAP B1 trước khi đẩy đơn.</div>
          </div>
        )}

        {/* M4: cụm Lưu/Hủy cuối form đã chuyển xuống sticky action bar bên dưới;
            ở Bước 3 chỉ giữ lại nút "Lưu thành mẫu" (chế độ tạo mới) */}
        {!isEdit && (
          <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="fm-btn fm-btn--secondary"
              onClick={() => { setTplModal(true); setTplMsg(null) }}
              disabled={saving}
              title="Lưu đơn hàng hiện tại thành mẫu để tạo nhanh lần sau"
            >
              <BookmarkPlus size={16} />
              Lưu thành mẫu
            </button>
          </div>
        )}
      </div>

      {/* M4 — Sticky action bar: luôn hiện khi cuộn form, chứa Lưu + Hủy/Nhập lại
          (dùng đúng handler + state disabled/busy của nút cũ, không đổi logic) */}
      <div
        role="toolbar"
        aria-label="Thao tác đơn hàng bán"
        style={{
          position: 'sticky',
          bottom: 0,
          zIndex: 30,
          background: 'var(--fm-surface)',
          borderTop: '1px solid var(--fm-line)',
          marginTop: 16,
          padding: '12px 16px calc(12px + env(safe-area-inset-bottom, 0px))',
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
        }}
      >
        {isEdit ? (
          <button
            className="fm-btn fm-btn--secondary"
            onClick={() => setConfirmCfg({
              title: 'Hủy thay đổi?',
              message: 'Xóa bản nháp và bỏ mọi thay đổi chưa lưu trên form này?\nĐơn hàng gốc trên hệ thống không bị thay đổi.',
              confirmLabel: 'Hủy thay đổi',
              tone: 'warning',
              run: () => { clearDraft(); onCancel?.() },
            })}
            disabled={saving}
          >
            Hủy — không lưu thay đổi
          </button>
        ) : (
          <button
            className="fm-btn fm-btn--secondary"
            onClick={() => setConfirmCfg({
              title: 'Nhập lại đơn hàng',
              message: 'Xóa toàn bộ dữ liệu đã nhập và bắt đầu lại?\nDữ liệu đã nhập trên form sẽ mất.',
              confirmLabel: 'Nhập lại',
              tone: 'danger',
              run: resetForm,
            })}
            disabled={saving}
          >
            Nhập lại
          </button>
        )}
        {/* Phase 2 — Lưu nháp: gọi API với ?draft=true (chỉ khi tạo mới; khi sửa
            bản nháp, nút Lưu chính đã giữ trạng thái nháp) */}
        <ShortcutHelp open={shortcuts.helpOpen} onOpen={shortcuts.openHelp} onClose={shortcuts.closeHelp} />
        {!isEdit && (
          <button className="fm-btn fm-btn--secondary" onClick={() => save(true)} disabled={saving}>
            <Save size={16} />
            {saving ? 'Đang lưu nháp…' : 'Lưu nháp'}
          </button>
        )}
        <button className="fm-btn fm-btn--primary" onClick={() => save(isEdit && Boolean(editOrder?.isDraft))} disabled={saving}>
          <Save size={16} />
          {saving ? 'Đang lưu…' : isEdit ? (editOrder?.isDraft ? 'Lưu bản nháp' : 'Lưu thay đổi') : 'Lưu đơn hàng bán'}
        </button>
      </div>

      {/* Modal lưu thành mẫu đơn hàng */}
      {tplModal && (
        <div className="fm-backdrop" onClick={() => setTplModal(false)}>
          <div ref={tplTrapRef} className="fm-modal" role="dialog" aria-modal="true" aria-label="Lưu thành mẫu đơn hàng" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <BookmarkPlus size={18} /> Lưu thành mẫu đơn hàng
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
              <div className={`fm-alert ${tplMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} style={{ marginBottom: 12 }} role={tplMsg.type === 'error' ? 'alert' : 'status'}>
                <div>{tplMsg.text}</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--ghost" onClick={() => setTplModal(false)} disabled={tplSaving}>
                Hủy
              </button>
              <button className="fm-btn fm-btn--primary" onClick={saveAsTemplate} disabled={tplSaving}>
                <BookmarkPlus size={14} />
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
                        <div style={{ fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--fm-text-2)' }}>{t.lines.length} dòng{t.cardName ? ` — ${t.cardName}` : ''}</div>
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
                        onClick={() => setConfirmCfg({
                          title: 'Xóa mẫu đơn hàng',
                          message: `Xóa mẫu "${t.name}"?\nHành động không thể hoàn tác.`,
                          confirmLabel: 'Xóa',
                          tone: 'danger',
                          run: () => { void deleteTemplate(t.id, t.name) },
                        })}
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
          <div ref={priceHistTrapRef} className="fm-modal" role="dialog" aria-modal="true" aria-label="Lịch sử giá" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <History size={18} /> Lịch sử giá
            </h3>
            <p style={{ fontSize: 12.5, color: 'var(--fm-text-2)', margin: '0 0 14px' }}>
              {priceHistFor.itemName} ({priceHistFor.itemCode}) — {partner?.name} ({partner?.code})
            </p>
            {priceHistLoading ? (
              <div style={{ textAlign: 'left', padding: 24, color: 'var(--fm-text-2)' }}>Đang tải…</div>
            ) : priceHist.length === 0 ? (
              <div style={{ textAlign: 'left', padding: 24, color: 'var(--fm-text-2)' }}>
                Chưa có lịch sử bán mặt hàng này cho khách hàng.
              </div>
            ) : (
              <div className="fm-table-wrap" style={{ overflowX: 'auto' }}>
                <table className="fm-table fm-stack-table">
                  <thead>
                    <tr>
                      <th>Ngày</th>
                      <th>Số chứng từ</th>
                      <th style={{ textAlign: 'right' }}>Số lượng</th>
                      <th style={{ textAlign: 'right' }}>Đơn giá (₫)</th>
                      <th style={{ textAlign: 'right' }}>Chiết khấu %</th>
                      <th style={{ width: 90 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceHist.map((h, i) => (
                      <tr key={`${h.docNum}-${i}`}>
                        <td data-label="Ngày">{formatDateVN(h.docDate)}</td>
                        <th scope="row" data-label="Số chứng từ">#{h.docNum}</th>
                        <td data-label="Số lượng" style={{ textAlign: 'right' }}>{formatNum(h.quantity)} {h.uom}</td>
                        <td data-label="Đơn giá (₫)" style={{ textAlign: 'right', fontWeight: 600 }}>{formatVND(h.unitPrice)}</td>
                        <td data-label="Chiết khấu %" style={{ textAlign: 'right' }}>{h.discPct}%</td>
                        <td data-label="">
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
      {/* Dialog xác nhận chung thay window.confirm() */}
      {confirmCfg && (
        <ConfirmDialog
          open
          title={confirmCfg.title}
          message={confirmCfg.message}
          confirmLabel={confirmCfg.confirmLabel}
          tone={confirmCfg.tone}
          onConfirm={confirmCfg.run}
          onCancel={() => setConfirmCfg(null)}
        />
      )}
    </div>
  )
}
