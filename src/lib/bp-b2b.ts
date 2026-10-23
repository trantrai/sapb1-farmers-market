// ============================================================
// ĐỊA CHỈ GIAO / GHI HÓA ĐƠN + NGƯỜI LIÊN HỆ CỦA KHÁCH HÀNG
// Dùng chung cho mọi form chứng từ bán hàng (đơn hàng, giao hàng, báo giá,
// hóa đơn, ghi có, trả hàng, đặt cọc). Dữ liệu lấy từ mirror BusinessPartner
// (đồng bộ từ SAP B1): addressesJson, contactsJson, shipToDefault, billToDefault.
// ============================================================

/** Địa chỉ đối tác từ BusinessPartner.addressesJson — shape [{code,name,detail,type}] */
export interface B2BAddress {
  code: string
  name: string
  detail?: string
  /** 'S' = giao hàng (ShipTo), 'B' = ghi hóa đơn (BillTo), 'BS' = cả hai */
  type?: string
}

/** Người liên hệ từ BusinessPartner.contactsJson — code = SAP ContactEmployees.InternalCode */
export interface B2BContact {
  code: number
  name: string
  phone?: string
  email?: string
  isDefault?: boolean
}

export interface BpB2BInfo {
  addresses: B2BAddress[]
  contacts: B2BContact[]
  /** AddressName mặc định trên SAP (ShipToDefault / BilltoDefault) */
  shipToDefault: string
  billToDefault: string
}

/** Lựa chọn địa chỉ/người liên hệ trên form — chuỗi rỗng = chưa chọn */
export interface B2BPartySelection {
  shipToCode: string
  billToCode: string
  contactPersonCode: string
}

export const EMPTY_BP_B2B_INFO: BpB2BInfo = { addresses: [], contacts: [], shipToDefault: '', billToDefault: '' }

function parseJsonArray(raw: unknown): Record<string, unknown>[] {
  let arr: unknown = raw
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw) } catch { return [] }
  }
  return Array.isArray(arr) ? arr.filter((a) => a && typeof a === 'object') : []
}

export function parseB2BAddresses(raw?: unknown): B2BAddress[] {
  return parseJsonArray(raw)
    .filter((a) => a.code || a.name)
    .map((a) => ({
      code: String(a.code ?? ''),
      name: String(a.name ?? ''),
      detail: a.detail ? String(a.detail) : undefined,
      type: a.type ? String(a.type) : undefined,
    }))
}

export function parseB2BContacts(raw?: unknown): B2BContact[] {
  return parseJsonArray(raw)
    .filter((c) => Number.isInteger(Number(c.code)) && c.code !== null && c.code !== '')
    .map((c) => ({
      code: Number(c.code),
      name: String(c.name ?? '') || String(c.code),
      phone: c.phone ? String(c.phone) : undefined,
      email: c.email ? String(c.email) : undefined,
      isDefault: c.isDefault === true,
    }))
}

/** Địa chỉ dùng được cho giao hàng ('S'/'BS'; không rõ loại → cho phép) */
export const shipAddresses = (list: B2BAddress[]) => list.filter((a) => !a.type || a.type.includes('S'))
/** Địa chỉ dùng được cho ghi hóa đơn ('B'/'BS'; không rõ loại → cho phép) */
export const billAddresses = (list: B2BAddress[]) => list.filter((a) => !a.type || a.type.includes('B'))

/** Dựng BpB2BInfo từ 1 dòng đối tác (API /api/partners hoặc /api/bpartners/sync) */
export function bpB2BInfoFromRow(row?: Record<string, unknown> | null): BpB2BInfo {
  if (!row) return EMPTY_BP_B2B_INFO
  return {
    addresses: parseB2BAddresses(row.addressesJson),
    contacts: parseB2BContacts(row.contactsJson),
    shipToDefault: typeof row.shipToDefault === 'string' ? row.shipToDefault : '',
    billToDefault: typeof row.billToDefault === 'string' ? row.billToDefault : '',
  }
}

/**
 * Giá trị mặc định theo khách hàng: ưu tiên mặc định trên SAP; KH chỉ có
 * đúng 1 lựa chọn → chọn luôn; còn lại → để trống (SAP tự dùng mặc định).
 */
export function defaultB2BParty(info: BpB2BInfo): B2BPartySelection {
  const pick = (list: B2BAddress[], def: string) =>
    def && list.some((a) => a.code === def) ? def : list.length === 1 ? list[0].code : ''
  const defContact = info.contacts.find((c) => c.isDefault) ?? (info.contacts.length === 1 ? info.contacts[0] : undefined)
  return {
    shipToCode: pick(shipAddresses(info.addresses), info.shipToDefault),
    billToCode: pick(billAddresses(info.addresses), info.billToDefault),
    contactPersonCode: defContact ? String(defContact.code) : '',
  }
}

/**
 * Áp dữ liệu KH vừa tải vào lựa chọn hiện tại.
 *  - force = true (người dùng vừa CHỌN khách hàng): lấy mặc định của KH mới.
 *  - force = false (mở chứng từ đã lưu / sao chép từ nguồn): giữ giá trị đã có
 *    nếu còn thuộc KH; ô trống hoặc không còn hợp lệ → điền mặc định.
 * KH chưa đồng bộ địa chỉ/người liên hệ (danh sách rỗng) → giữ nguyên giá trị
 * đã lưu, tránh xóa mất dữ liệu chỉ vì mirror chưa có.
 */
export function applyB2BPartyDefaults(info: BpB2BInfo, cur: B2BPartySelection, force: boolean): B2BPartySelection {
  const def = defaultB2BParty(info)
  const resolve = (value: string, validCodes: string[], fallback: string) => {
    if (validCodes.length === 0) return force ? '' : value
    if (!force && value && validCodes.includes(value)) return value
    return fallback
  }
  return {
    shipToCode: resolve(cur.shipToCode, shipAddresses(info.addresses).map((a) => a.code), def.shipToCode),
    billToCode: resolve(cur.billToCode, billAddresses(info.addresses).map((a) => a.code), def.billToCode),
    contactPersonCode: resolve(cur.contactPersonCode, info.contacts.map((c) => String(c.code)), def.contactPersonCode),
  }
}
