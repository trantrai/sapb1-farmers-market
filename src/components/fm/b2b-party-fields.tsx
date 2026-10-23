'use client'

// ============================================================
// ĐỊA CHỈ GIAO HÀNG / GHI HÓA ĐƠN / NGƯỜI LIÊN HỆ trên form chứng từ
//  - useBpB2BInfo: tải địa chỉ + người liên hệ của KH đã chọn, tự điền mặc
//    định của KH (SAP ShipToDefault / BilltoDefault / ContactPerson).
//  - B2BPartyFields: 3 dropdown cho phép người dùng đổi lựa chọn.
// Giá trị lưu xuống DB và đẩy lên SAP: ShipToCode, BillToCode, ContactPersonCode.
// ============================================================

import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { api } from '@/lib/fm-client'
import {
  applyB2BPartyDefaults,
  billAddresses,
  bpB2BInfoFromRow,
  EMPTY_BP_B2B_INFO,
  shipAddresses,
  type B2BAddress,
  type B2BPartySelection,
  type BpB2BInfo,
} from '@/lib/bp-b2b'

/**
 * Tải địa chỉ + người liên hệ của KH `cardCode` rồi gọi `apply` để cập nhật
 * lựa chọn trên form. Gọi `requestDefaults()` ngay khi NGƯỜI DÙNG chọn KH
 * khác → lần tải kế tiếp ghi đè bằng mặc định của KH mới; các trường hợp
 * khác (mở chứng từ đã lưu, sao chép từ nguồn) giữ giá trị đã có nếu hợp lệ.
 */
export function useBpB2BInfo(
  cardCode: string | null | undefined,
  apply: (update: (cur: B2BPartySelection) => B2BPartySelection) => void,
) {
  const code = cardCode?.trim() || ''
  // Dữ liệu gắn với mã KH đã tải — đổi KH thì dữ liệu cũ tự bị bỏ qua
  const [loaded, setLoaded] = useState<{ code: string; info: BpB2BInfo } | null>(null)
  const forceRef = useRef(false)
  const onLoaded = useEffectEvent((forCode: string, next: BpB2BInfo, ok: boolean) => {
    setLoaded({ code: forCode, info: next })
    // Lỗi tải → giữ nguyên lựa chọn hiện tại (không xóa dữ liệu đã lưu)
    if (!ok) return
    const force = forceRef.current
    forceRef.current = false
    apply((cur) => applyB2BPartyDefaults(next, cur, force))
  })

  useEffect(() => {
    if (!code) return
    let cancelled = false
    api(`/api/partners?q=${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        const rows = (Array.isArray(j?.data) ? j.data : []) as Record<string, unknown>[]
        const row = rows.find((d) => String(d.cardCode ?? '').toLowerCase() === code.toLowerCase())
        onLoaded(code, bpB2BInfoFromRow(row), j != null)
      })
      .catch(() => { if (!cancelled) onLoaded(code, EMPTY_BP_B2B_INFO, false) })
    return () => { cancelled = true }
  }, [code])

  const current = code && loaded?.code === code ? loaded.info : EMPTY_BP_B2B_INFO
  return {
    info: current,
    loading: !!code && loaded?.code !== code,
    /** Gọi khi người dùng chọn KH khác → áp mặc định của KH mới sau khi tải xong */
    requestDefaults: () => { forceRef.current = true },
  }
}

interface Props {
  value: B2BPartySelection
  onChange: (patch: Partial<B2BPartySelection>) => void
  info: BpB2BInfo
  loading?: boolean
  disabled?: boolean
  /** Đã chọn khách hàng chưa — chưa chọn thì dropdown khóa + gợi ý chọn KH */
  hasPartner: boolean
  idPrefix: string
}

const addrLabel = (a: B2BAddress) => (a.name && a.name !== a.code ? `${a.code} · ${a.name}` : a.code || a.name)

/** 3 ô chọn: Người liên hệ · Địa chỉ giao hàng · Địa chỉ ghi hóa đơn (kèm dòng chi tiết bên dưới) */
export function B2BPartyFields({ value, onChange, info, loading, disabled, hasPartner, idPrefix }: Props) {
  const ships = shipAddresses(info.addresses)
  const bills = billAddresses(info.addresses)
  const contact = info.contacts.find((c) => String(c.code) === value.contactPersonCode)
  const ship = ships.find((a) => a.code === value.shipToCode)
  const bill = bills.find((a) => a.code === value.billToCode)

  const emptyText = (n: number, what: string) =>
    !hasPartner ? '— Chọn khách hàng trước —' : loading ? 'Đang tải…' : n === 0 ? `— KH chưa có ${what} —` : '— Chưa chọn —'
  const missingHint = 'Chưa có dữ liệu — hãy đồng bộ lại Khách hàng từ SAP B1.'

  /** Mã đã lưu nhưng không có trong danh sách hiện tại (mirror chưa đồng bộ) → vẫn hiển thị */
  const savedOption = (val: string, exists: boolean) =>
    val && !exists ? <option value={val}>{val} (mã đã lưu)</option> : null

  return (
    <>
      <div className="fm-field">
        <label className="fm-label" htmlFor={`${idPrefix}-contact`} title="Người liên hệ của khách hàng (SAP: ContactPersonCode)">Người liên hệ</label>
        <select
          id={`${idPrefix}-contact`}
          className="fm-input"
          value={value.contactPersonCode}
          onChange={(e) => onChange({ contactPersonCode: e.target.value })}
          disabled={disabled || !hasPartner}
          aria-describedby={`${idPrefix}-contact-hint`}
        >
          <option value="">{emptyText(info.contacts.length, 'người liên hệ')}</option>
          {info.contacts.map((c) => (
            <option key={c.code} value={String(c.code)}>
              {c.name}{c.isDefault ? ' (mặc định)' : ''}
            </option>
          ))}
          {savedOption(value.contactPersonCode, !!contact)}
        </select>
        <div className="fm-hint" id={`${idPrefix}-contact-hint`}>
          {contact
            ? [contact.phone, contact.email].filter(Boolean).join(' · ') || ' '
            : hasPartner && !loading && info.contacts.length === 0 ? missingHint : ' '}
        </div>
      </div>
      <div className="fm-field">
        <label className="fm-label" htmlFor={`${idPrefix}-shipto`} title="Địa chỉ giao hàng của khách (SAP: ShipToCode)">Địa chỉ giao hàng</label>
        <select
          id={`${idPrefix}-shipto`}
          className="fm-input"
          value={value.shipToCode}
          onChange={(e) => onChange({ shipToCode: e.target.value })}
          disabled={disabled || !hasPartner}
          aria-describedby={`${idPrefix}-shipto-hint`}
        >
          <option value="">{emptyText(ships.length, 'địa chỉ giao hàng')}</option>
          {ships.map((a) => (
            <option key={a.code || a.name} value={a.code} title={a.detail || addrLabel(a)}>
              {addrLabel(a)}{a.code === info.shipToDefault ? ' (mặc định)' : ''}
            </option>
          ))}
          {savedOption(value.shipToCode, !!ship)}
        </select>
        <div className="fm-hint" id={`${idPrefix}-shipto-hint`}>
          {ship?.detail || (hasPartner && !loading && ships.length === 0 ? missingHint : ' ')}
        </div>
      </div>
      <div className="fm-field">
        <label className="fm-label" htmlFor={`${idPrefix}-billto`} title="Địa chỉ ghi hóa đơn của khách (SAP: BillToCode)">Địa chỉ ghi hóa đơn</label>
        <select
          id={`${idPrefix}-billto`}
          className="fm-input"
          value={value.billToCode}
          onChange={(e) => onChange({ billToCode: e.target.value })}
          disabled={disabled || !hasPartner}
          aria-describedby={`${idPrefix}-billto-hint`}
        >
          <option value="">{emptyText(bills.length, 'địa chỉ ghi hóa đơn')}</option>
          {bills.map((a) => (
            <option key={a.code || a.name} value={a.code} title={a.detail || addrLabel(a)}>
              {addrLabel(a)}{a.code === info.billToDefault ? ' (mặc định)' : ''}
            </option>
          ))}
          {savedOption(value.billToCode, !!bill)}
        </select>
        <div className="fm-hint" id={`${idPrefix}-billto-hint`}>
          {bill?.detail || (hasPartner && !loading && bills.length === 0 ? missingHint : ' ')}
        </div>
      </div>
    </>
  )
}
