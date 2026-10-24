'use client'

// ============================================================
// KHỐI HIỂN THỊ DÙNG CHUNG CHO MỌI MÀN CHI TIẾT CHỨNG TỪ BÁN HÀNG
// (đơn hàng, giao hàng, báo giá, hóa đơn, ghi có, trả hàng, đặt cọc):
//  - DocInfoCards: "Thông tin chung" + "Thông tin B2B / SAP B1" — đủ các trường
//    của form tạo/sửa, cùng thứ tự trên mọi chứng từ
//  - DocLinesCard: bảng dòng hàng thống nhất (Barcode, Kho, Số lô/Tài khoản,
//    CK, Mã thuế · %, tiền sau thuế), nhóm BOM Template, tổng tiền, thẻ mobile
// ============================================================

import { useEffect, useState, type ReactNode } from 'react'
import { useShowLockedBomChildren } from './bom-lines'
import { api } from '@/lib/fm-client'
import { formatDateVN, formatVND } from '@/lib/fm-shared'
import { bpB2BInfoFromRow, EMPTY_BP_B2B_INFO, type BpB2BInfo } from '@/lib/bp-b2b'

// ---------------- Dữ liệu tra cứu (khách hàng, NVBH, ĐKTT) ----------------

interface PartyData { address: string; phone: string; info: BpB2BInfo }

/** Địa chỉ + danh bạ người liên hệ / địa chỉ giao-ghi HĐ của khách hàng (mirror đồng bộ SAP) */
export function useDocParty(cardCode: string | null | undefined) {
  const code = cardCode?.trim() || ''
  const [loaded, setLoaded] = useState<{ code: string; data: PartyData } | null>(null)
  useEffect(() => {
    if (!code) return
    let cancelled = false
    api(`/api/partners?q=${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        const rows = (Array.isArray(j?.data) ? j.data : []) as Record<string, unknown>[]
        const row = rows.find((d) => String(d.cardCode ?? '').toLowerCase() === code.toLowerCase())
        setLoaded({
          code,
          data: { address: String(row?.address ?? ''), phone: String(row?.phone ?? ''), info: bpB2BInfoFromRow(row) },
        })
      })
      .catch(() => { if (!cancelled) setLoaded({ code, data: { address: '', phone: '', info: EMPTY_BP_B2B_INFO } }) })
    return () => { cancelled = true }
  }, [code])
  return loaded?.code === code ? loaded.data : null
}

type NameMap = Record<number, string>
let namesPromise: Promise<{ sp: NameMap; pt: NameMap }> | null = null
async function loadNameMap(url: string): Promise<NameMap> {
  try {
    const r = await api(url)
    if (!r.ok) return {}
    const j = await r.json().catch(() => null)
    const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []
    const m: NameMap = {}
    for (const x of arr as { code?: unknown; name?: unknown }[]) {
      const c = Number(x.code)
      if (Number.isFinite(c)) m[c] = String(x.name ?? '')
    }
    return m
  } catch {
    return {}
  }
}

/** Tên Nhân viên bán hàng / Điều khoản thanh toán (tải 1 lần, dùng chung mọi màn) */
export function useB2BNames() {
  const [names, setNames] = useState<{ sp: NameMap; pt: NameMap }>({ sp: {}, pt: {} })
  useEffect(() => {
    let cancelled = false
    namesPromise ??= Promise.all([loadNameMap('/api/sales-persons'), loadNameMap('/api/payment-terms')]).then(([sp, pt]) => ({ sp, pt }))
    void namesPromise.then((n) => { if (!cancelled) setNames(n) })
    return () => { cancelled = true }
  }, [])
  const label = (m: NameMap, code?: number | null) => (code == null ? '—' : m[code] ? `${code} · ${m[code]}` : String(code))
  return { spLabel: (c?: number | null) => label(names.sp, c), ptLabel: (c?: number | null) => label(names.pt, c) }
}

// ---------------- Thông tin chung + B2B ----------------

export interface DocInfoData {
  cardCode: string
  cardName: string
  docDate: string
  docDueDate?: string | null
  warehouseCode?: string | null
  createdBy?: string | null
  status: string
  isDraft?: boolean
  headerDiscPct?: number | null
  headerDiscAmt?: number | null
  remarks?: string | null
  source?: string | null
  sapSyncStatus?: string | null
  sapDocNum?: number | null
  sapSyncedAt?: string | null
  sapSyncError?: string | null
  salesPersonCode?: number | null
  paymentGroupCode?: number | null
  numAtCard?: string | null
  taxDate?: string | null
  reqDate?: string | null
  docCurrency?: string | null
  docRate?: number | null
  projectCode?: string | null
  shipToCode?: string | null
  billToCode?: string | null
  contactPersonCode?: number | null
  attachmentsJson?: string | null
}

const STATUS_VN: Record<string, string> = { Open: 'Mở', Closed: 'Đã đóng', Cancelled: 'Đã hủy' }

export function DocStatusChip({ status, isDraft }: { status: string; isDraft?: boolean }) {
  if (isDraft) return <span className="fm-chip fm-chip--warn">Nháp</span>
  const cls = status === 'Open' ? 'fm-chip--open' : status === 'Cancelled' ? 'fm-chip--cancelled' : 'fm-chip--closed'
  return <span className={`fm-chip ${cls}`}>{STATUS_VN[status] ?? status}</span>
}

export function SapSyncChip({ doc }: { doc: DocInfoData }) {
  if (doc.source === 'sap') return <span className="fm-chip fm-chip--sap">Từ SAP B1{doc.sapDocNum ? ` — DocNum ${doc.sapDocNum}` : ''}</span>
  if (doc.sapSyncStatus === 'synced') {
    const at = doc.sapSyncedAt ? new Date(doc.sapSyncedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : ''
    return <span className="fm-chip fm-chip--sap" title={at ? `Đẩy thành công lúc ${at}` : undefined}>Đã đẩy{doc.sapDocNum ? ` — DocNum ${doc.sapDocNum}` : ''}</span>
  }
  if (doc.sapSyncStatus === 'pending') return <span className="fm-chip fm-chip--overdue" title={doc.sapSyncError ?? undefined}>Chờ đẩy / đẩy lỗi</span>
  return <span className="fm-chip fm-chip--role">Chưa đẩy</span>
}

function parseAttachments(raw?: string | null): { name: string; url: string }[] {
  try {
    const arr = JSON.parse(raw ?? 'null')
    return Array.isArray(arr) ? arr.filter((a) => a && (a.name || a.url)) : []
  } catch {
    return []
  }
}

const Field = ({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) => (
  <div className={wide ? 'fm-view-detail__wide' : undefined}><dt>{label}</dt><dd>{children}</dd></div>
)

export function DocInfoCards({ doc, dueLabel = 'Ngày giao hàng', showDueDate = true, showReqDate = true, generalExtra, b2bExtra }: {
  doc: DocInfoData
  /** Nhãn ngày thứ 2: 'Ngày giao hàng' (đơn/giao hàng) | 'Hạn' (báo giá, hóa đơn…) */
  dueLabel?: string
  showDueDate?: boolean
  /** "Ngày cần giao" (ReqDate) — đơn hàng, giao hàng */
  showReqDate?: boolean
  /** Trường riêng của loại chứng từ (Loại hóa đơn, Số dư đặt cọc…) — chèn trước Ghi chú */
  generalExtra?: ReactNode
  b2bExtra?: ReactNode
}) {
  const party = useDocParty(doc.cardCode)
  const { spLabel, ptLabel } = useB2BNames()
  const info = party?.info ?? EMPTY_BP_B2B_INFO
  const contact = doc.contactPersonCode != null ? info.contacts.find((c) => c.code === doc.contactPersonCode) : undefined
  const addr = (code?: string | null) => {
    if (!code) return '—'
    const a = info.addresses.find((x) => x.code === code || x.name === code)
    return a?.detail ? `${code} — ${a.detail}` : code
  }
  const attachments = parseAttachments(doc.attachmentsJson)
  const currency = doc.docCurrency || 'VND'

  return (
    <>
      <div className="fm-card fm-detail-card">
        <h2 className="fm-card__title">Thông tin chung</h2>
        <dl className="fm-view-detail">
          <Field label="Mã khách hàng"><b>{doc.cardCode}</b></Field>
          <Field label="Tên khách hàng">{doc.cardName || '—'}</Field>
          <Field label="Địa chỉ">{party ? party.address || '—' : '…'}</Field>
          <Field label="Người liên hệ">
            {doc.contactPersonCode == null ? '—'
              : contact ? `${contact.name}${contact.phone ? ` · ${contact.phone}` : ''}`
                : party ? `#${doc.contactPersonCode}` : '…'}
          </Field>
          <Field label="Ngày chứng từ">{formatDateVN(doc.docDate)}</Field>
          {showDueDate && <Field label={dueLabel}>{doc.docDueDate ? formatDateVN(doc.docDueDate) : '—'}</Field>}
          <Field label="Kho hàng xuất bán">{doc.warehouseCode || '— (theo mặc định SAP)'}</Field>
          <Field label="Chiết khấu đầu chứng từ">
            {(doc.headerDiscPct ?? 0) > 0 ? `${doc.headerDiscPct}%${doc.headerDiscAmt ? ` (${formatVND(doc.headerDiscAmt)})` : ''}` : '—'}
          </Field>
          <Field label="Trạng thái"><DocStatusChip status={doc.status} isDraft={doc.isDraft} /></Field>
          <Field label="Đồng bộ SAP B1"><SapSyncChip doc={doc} /></Field>
          {doc.source !== 'sap' && <Field label="Người tạo">{doc.createdBy || '—'}</Field>}
          {generalExtra}
          <Field label="Ghi chú" wide>{doc.remarks || '—'}</Field>
        </dl>
      </div>

      <div className="fm-card fm-detail-card">
        <h2 className="fm-card__title">Thông tin B2B / SAP B1</h2>
        <dl className="fm-view-detail">
          <Field label="Nhân viên bán hàng">{spLabel(doc.salesPersonCode)}</Field>
          <Field label="Điều khoản thanh toán">{ptLabel(doc.paymentGroupCode)}</Field>
          <Field label="Số PO / Tham chiếu KH">{doc.numAtCard || '—'}</Field>
          <Field label="Ngày tính thuế">{doc.taxDate ? formatDateVN(doc.taxDate) : '—'}</Field>
          {showReqDate && <Field label="Ngày cần giao">{doc.reqDate ? formatDateVN(doc.reqDate) : '—'}</Field>}
          <Field label="Tiền tệ">{currency}</Field>
          <Field label="Tỷ giá">{currency !== 'VND' && doc.docRate != null ? doc.docRate : '—'}</Field>
          <Field label="Mã dự án">{doc.projectCode || '—'}</Field>
          <Field label="Địa chỉ giao hàng">{addr(doc.shipToCode)}</Field>
          <Field label="Địa chỉ ghi hóa đơn">{addr(doc.billToCode)}</Field>
          {b2bExtra}
          <Field label="Đính kèm" wide>
            {attachments.length > 0 ? (
              <ul className="fm-detail-attachments">
                {attachments.map((a, i) => (
                  <li key={i}>{a.url ? <a href={a.url} target="_blank" rel="noreferrer">{a.name || a.url}</a> : a.name}</li>
                ))}
              </ul>
            ) : '—'}
          </Field>
        </dl>
      </div>
    </>
  )
}

/** Một ô thông tin rời (dùng cho generalExtra / b2bExtra của từng loại chứng từ) */
export const DocField = Field

// ---------------- Bảng dòng hàng ----------------

export interface DocLine {
  id?: string
  itemCode: string
  itemName: string
  barcode?: string | null
  quantity: number
  uom?: string | null
  warehouseCode?: string | null
  batchNumber?: string | null
  accountCode?: string | null
  unitPrice: number
  discPct?: number | null
  vatPct?: number | null
  taxCode?: string | null
  isBomChild?: boolean | null
  bomGroupKey?: string | null
  bomEditable?: boolean | null
  /** Loại BOM thật của dòng cha (mirror) — 'template' | 'production' | 'assembly' | 'none' */
  bomType?: string | null
}

export interface DocTotals {
  totalBeforeDisc: number
  discountAmt: number
  headerDiscPct: number
  headerDiscAmt: number
  vatAmt: number
  grandTotal: number
}

const lineAfterDisc = (l: DocLine) => l.unitPrice * l.quantity * (1 - (Number(l.discPct) || 0) / 100)
const lineVat = (l: DocLine) => (typeof l.vatPct === 'number' ? (lineAfterDisc(l) * l.vatPct) / 100 : 0)

/** Tổng chứng từ suy từ dòng (khi API không lưu sẵn — vd phiếu giao hàng) */
export function computeDocTotals(lines: DocLine[], headerDiscPct = 0, grandTotal?: number | null): DocTotals {
  const totalBeforeDisc = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)
  const afterLines = lines.reduce((s, l) => s + lineAfterDisc(l), 0)
  const headerDiscAmt = headerDiscPct > 0 ? Math.round((afterLines * headerDiscPct) / 100) : 0
  const vatAmt = Math.round(lines.reduce((s, l) => s + lineVat(l), 0) * (1 - headerDiscPct / 100))
  return {
    totalBeforeDisc: Math.round(totalBeforeDisc),
    discountAmt: Math.round(totalBeforeDisc - afterLines),
    headerDiscPct,
    headerDiscAmt,
    vatAmt,
    grandTotal: grandTotal ?? Math.round(afterLines - headerDiscAmt + vatAmt),
  }
}

/** BOM: hiện con của BOM Template; con Production/Assembly (khóa) chỉ hiện khi bật thiết lập. STT chỉ đếm dòng không phải con. */
function visibleWithStt(lines: DocLine[], showLocked: boolean) {
  const parentType = new Map(lines.filter((l) => !l.isBomChild && l.bomGroupKey).map((l) => [l.bomGroupKey as string, l.bomType ?? 'none']))
  const visible = lines.filter((l) => {
    if (!l.isBomChild) return true
    const pt = parentType.get(l.bomGroupKey as string)
    if (pt === 'production' || pt === 'assembly') return showLocked
    if (pt === 'template') return true
    return showLocked || l.bomEditable !== false
  })
  const stt = new Map<DocLine, number>()
  let n = 0
  for (const l of visible) if (!l.isBomChild) stt.set(l, ++n)
  return { visible, stt }
}

const taxText = (l: DocLine) => {
  const parts = [l.taxCode?.trim(), typeof l.vatPct === 'number' ? `${l.vatPct}%` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}

export function DocLinesCard({ lines, totals, defaultWarehouse, title = 'Hàng hóa & chi tiết', footerExtra }: {
  lines: DocLine[]
  totals: DocTotals
  /** Kho header — hiển thị khi dòng không có kho riêng */
  defaultWarehouse?: string | null
  title?: string
  /** Dòng tổng bổ sung trong tfoot (vd khấu trừ đặt cọc) */
  footerExtra?: ReactNode
}) {
  const showLockedBom = useShowLockedBomChildren()
  const { visible, stt } = visibleWithStt(lines, showLockedBom)
  const showBatch = lines.some((l) => l.batchNumber)
  const showAccount = lines.some((l) => l.accountCode)
  const colCount = 13 + (showBatch ? 1 : 0) + (showAccount ? 1 : 0)
  const span = colCount - 1
  const footRow = (key: string, label: ReactNode, value: ReactNode, strong?: boolean) => (
    <tr key={key} className={strong ? 'fm-detail-total' : undefined}>
      <td colSpan={span} className="fm-num">{label}</td>
      <td className="fm-num">{value}</td>
    </tr>
  )

  return (
    <div className="fm-card fm-detail-card">
      <h2 className="fm-card__title">{title}</h2>
      <div className="fm-table-wrap">
        <table className="fm-table fm-detail-lines">
          <thead>
            <tr>
              <th>#</th>
              <th>Mã hàng</th>
              <th>Tên hàng</th>
              <th>Barcode</th>
              <th className="fm-num">Số lượng</th>
              <th>Đơn vị tính</th>
              <th>Kho</th>
              {showBatch && <th title="Số lô (SAP BatchNumbers)">Số lô</th>}
              {showAccount && <th title="Tài khoản kế toán (hóa đơn dịch vụ)">Tài khoản</th>}
              <th className="fm-num">Đơn giá</th>
              <th className="fm-num">CK (%)</th>
              <th className="fm-num">Sau chiết khấu</th>
              <th title="Mã nhóm thuế · thuế suất">Thuế</th>
              <th className="fm-num">Tiền thuế</th>
              <th className="fm-num">Tiền dòng (sau thuế)</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((l, i) => {
              const isChild = Boolean(l.isBomChild)
              const isParent = !isChild && Boolean(l.bomGroupKey)
              const after = lineAfterDisc(l)
              const vat = lineVat(l)
              return (
                <tr key={l.id || i} className={isChild ? 'is-bom-child' : isParent ? 'is-bom-parent' : undefined}>
                  <td>{isChild ? '' : stt.get(l)}</td>
                  <th scope="row">
                    {isChild && <span className="fm-bom-branch" aria-hidden>└─ </span>}
                    <b>{l.itemCode || '—'}</b>
                    {isParent && <span className="fm-chip fm-chip--bom" title="Mặt hàng BOM — các dòng con bên dưới thuộc công thức của mặt hàng này">BOM</span>}
                  </th>
                  <td>{l.itemName}</td>
                  <td className="fm-detail-barcode">{l.barcode || '—'}</td>
                  <td className="fm-num">{l.quantity}</td>
                  <td>{l.uom || '—'}</td>
                  <td>{l.warehouseCode || defaultWarehouse || '—'}</td>
                  {showBatch && <td>{l.batchNumber || '—'}</td>}
                  {showAccount && <td>{l.accountCode || '—'}</td>}
                  <td className="fm-num">{formatVND(l.unitPrice)}</td>
                  <td className="fm-num">{Number(l.discPct) || 0}%</td>
                  <td className="fm-num">{formatVND(after)}</td>
                  <td>{taxText(l)}</td>
                  <td className="fm-num">{formatVND(vat)}</td>
                  <td className="fm-num"><b>{formatVND(after + vat)}</b></td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            {footRow('before', 'Tổng trước chiết khấu:', formatVND(totals.totalBeforeDisc))}
            {footRow('disc', 'Chiết khấu các dòng:', totals.discountAmt > 0 ? `−${formatVND(totals.discountAmt)}` : formatVND(0))}
            {totals.headerDiscAmt > 0 && footRow('hdisc', `Chiết khấu đầu chứng từ (${totals.headerDiscPct}%):`, `−${formatVND(totals.headerDiscAmt)}`)}
            {footRow('after', 'Sau chiết khấu:', formatVND(totals.totalBeforeDisc - totals.discountAmt - totals.headerDiscAmt))}
            {footRow('vat', 'Thuế các dòng:', formatVND(totals.vatAmt))}
            {footerExtra}
            {footRow('grand', <b>Tổng chứng từ:</b>, <b>{formatVND(totals.grandTotal)}</b>, true)}
          </tfoot>
        </table>

        {/* Mobile (≤640px): thẻ thay bảng nhiều cột */}
        <div className="fm-lcard-list">
          {visible.filter((l) => !l.isBomChild).map((l, i) => {
            const after = lineAfterDisc(l)
            const vat = lineVat(l)
            const isParent = Boolean(l.bomGroupKey)
            const children = isParent ? visible.filter((c) => c.isBomChild && c.bomGroupKey === l.bomGroupKey) : []
            return (
              <div key={l.id || i} className="fm-lcard">
                <div className="fm-lcard__head">
                  <span className="fm-lcard__num">{stt.get(l)}</span>
                  <div>
                    <div className="fm-lcard__name">{l.itemName}{isParent && <span className="fm-chip fm-chip--bom">BOM</span>}</div>
                    <div className="fm-lcard__code">
                      {[l.itemCode, l.barcode, l.uom, `Kho ${l.warehouseCode || defaultWarehouse || '—'}`].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
                <div className="fm-lcard__grid">
                  <div><span className="k">Số lượng</span><span className="v">{l.quantity}</span></div>
                  <div><span className="k">Đơn giá</span><span className="v">{formatVND(l.unitPrice)}</span></div>
                  <div><span className="k">CK</span><span className="v">{Number(l.discPct) || 0}%</span></div>
                  <div><span className="k">Thuế</span><span className="v">{taxText(l)}</span></div>
                  {showBatch && <div><span className="k">Số lô</span><span className="v">{l.batchNumber || '—'}</span></div>}
                  {showAccount && <div><span className="k">Tài khoản</span><span className="v">{l.accountCode || '—'}</span></div>}
                </div>
                {children.length > 0 && (
                  <div className="fm-lcard__bom">
                    <div className="fm-lcard__bom-title">Thành phần ({children.length}):</div>
                    {children.map((c, ci) => (
                      <div key={c.id || ci} className="fm-lcard__bom-row"><span aria-hidden>└─ </span>{c.itemCode} — {c.itemName} × {c.quantity} {c.uom}</div>
                    ))}
                  </div>
                )}
                <div className="fm-lcard__total"><span>Thành tiền (sau thuế)</span><b>{formatVND(after + vat)}</b></div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
