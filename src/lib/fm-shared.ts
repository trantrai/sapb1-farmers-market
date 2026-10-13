// ============================================================
// FARMERS MARKET — Shared types & helpers (client + server safe)
// ============================================================

export type ModuleKey = 'orders' | 'ordersNew' | 'deliveries' | 'users' | 'settings' | 'roles' | 'excelTemplates' | 'orderTemplates'
export type ActionKey = 'view' | 'create' | 'edit' | 'delete'

export type PermMap = Record<ModuleKey, Record<ActionKey, boolean>>

export interface SessionUser {
  id: string
  username: string
  fullName: string
  role: string
  roleLabel: string
  permissions: PermMap
  /** Id + label SapDatabase đã chọn khi đăng nhập (null = dùng DB mặc định) */
  databaseId: string | null
  databaseLabel: string | null
}

export const MODULE_LABELS: Record<ModuleKey, string> = {
  orders: 'Danh sách đơn hàng',
  ordersNew: 'Tạo đơn hàng (SO)',
  deliveries: 'Quản lý giao hàng',
  users: 'Người dùng hệ thống',
  settings: 'Cài đặt kết nối SAP B1',
  roles: 'Phân quyền (RBAC)',
  excelTemplates: 'Mẫu Excel',
  orderTemplates: 'Đơn hàng mẫu',
}

export const ACTION_LABELS: Record<ActionKey, string> = {
  view: 'Xem',
  create: 'Tạo',
  edit: 'Sửa',
  delete: 'Xóa',
}

export function emptyPerm(): PermMap {
  const mk = (): Record<ActionKey, boolean> => ({ view: false, create: false, edit: false, delete: false })
  return { orders: mk(), ordersNew: mk(), deliveries: mk(), users: mk(), settings: mk(), roles: mk(), excelTemplates: mk(), orderTemplates: mk() }
}

export function parsePerm(json: string | null | undefined): PermMap {
  const base = emptyPerm()
  if (!json) return base
  try {
    const raw = JSON.parse(json) as Partial<PermMap>
    for (const mod of Object.keys(base) as ModuleKey[]) {
      for (const act of Object.keys(base[mod]) as ActionKey[]) {
        base[mod][act] = Boolean(raw?.[mod]?.[act])
      }
    }
  } catch {
    /* keep empty */
  }
  return base
}

// ---------- Formatting ----------
export function formatVND(n: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' ₫'
}
export function formatNum(n: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(n)
}
export function formatDateVN(d: string | Date): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  return dt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}
export function toInputDate(d: string | Date): string {
  const dt = typeof d === 'string' ? new Date(d) : d
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
export const ROLE_OPTIONS = ['Admin', 'KeToan', 'NhanVien'] as const

export function isOverdue(due: string | Date, status: string): boolean {
  if (status !== 'Open') return false
  const dueDate = new Date(due)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return dueDate < today
}

/** Số ngày đã quá hạn giao (0 nếu chưa quá hạn). Chỉ tính khi due < hôm nay. */
export function daysOverdue(due: string | Date): number {
  const dueDate = new Date(due)
  dueDate.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((today.getTime() - dueDate.getTime()) / 86400000))
}

/** Số ngày còn lại đến hạn giao (0 = hôm nay, âm = đã quá hạn). */
export function daysUntilDue(due: string | Date): number {
  const dueDate = new Date(due)
  dueDate.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((dueDate.getTime() - today.getTime()) / 86400000)
}

/** Đơn Open và hạn giao trong `days` ngày tới (chưa quá hạn). */
export function isDueSoon(due: string | Date, status: string, days = 3): boolean {
  if (status !== 'Open') return false
  const n = daysUntilDue(due)
  return n >= 0 && n <= days
}

// ============================================================
// NHÓM THUẾ — chọn thuế suất % từ VatGroups_Lines (bảng con VTG1)
// NGUỒN ĐÚNG của %VAT: từng dòng lịch sử suất trong VTG1 có trường
// Rate + khoảng hiệu lực (DateFrom/DateTo — bản SL cũ ghi StartDate/
// EndDate). Cột Rate trên OVTG chỉ là dự phòng cho bản SL/mock cũ.
// Helper thuần (client + server safe) để fm-master và fm-items dùng chung.
// ============================================================

export interface B1VatLineRow {
  Code?: string
  Category?: string
  Rate?: number | string
  DateFrom?: string | null
  DateTo?: string | null
  StartDate?: string | null // tên thay thế trên một số bản SL
  EndDate?: string | null
}

/** Chuẩn hóa ngày SL ("/Date(946684800000)/" hoặc "2024-01-01T00:00:00") → 'YYYY-MM-DD' */
export function vatLineDay(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null
  const m = v.match(/^\/Date\((-?\d+)/)
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : v.slice(0, 10)
}

/** Hôm nay theo múi giờ máy chủ (đúng ngày "hiệu lực" người dùng đang thấy) */
export function vatToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Chọn thuế suất % hiệu lực HÔM NAY từ các dòng VatGroups_Lines:
 *  ① dòng có DateFrom/StartDate ≤ hôm nay ≤ DateTo/EndDate (null = mở)
 *  ② không dòng nào lọt → lấy dòng có mốc bắt đầu muộn nhất (vẫn hơn bỏ trống)
 * Trả về null khi không có dòng nào có Rate.
 */
export function pickEffectiveVatRate(ls: B1VatLineRow[] | null | undefined): number | null {
  if (!ls || ls.length === 0) return null
  const today = vatToday()
  const fromOf = (l: B1VatLineRow) => vatLineDay(l.DateFrom ?? l.StartDate)
  const toOf = (l: B1VatLineRow) => vatLineDay(l.DateTo ?? l.EndDate)
  const inRange = ls.filter((l) => {
    const from = fromOf(l)
    const to = toOf(l)
    if (from && today < from) return false
    if (to && today > to) return false
    return true
  })
  const pool = inRange.length > 0 ? inRange : ls
  let best = pool[0]
  for (const l of pool.slice(1)) {
    if ((fromOf(l) ?? '') >= (fromOf(best) ?? '')) best = l
  }
  const r = best.Rate
  return r == null ? null : (Number.isFinite(Number(r)) ? Number(r) : null)
}

/**
 * Parse số trang / kích thước trang từ query string — an toàn với giá trị
 * không phải số ("abc", ""): rơi về default thay vì NaN (NaN làm slice()
 * trả mảng rỗng và totalPages thành null).
 */
export function parsePageParam(v: string | null, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v ?? def))
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}
