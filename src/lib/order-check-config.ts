// ============================================================
// Thiết lập "Kiểm tra đơn hàng trước khi lưu" (Cài đặt → AppSettings.orderCheckConfig, JSON)
// Chỉ bật/tắt CẢNH BÁO; lỗi bắt buộc (thiếu khách, SL ≤ 0, ngày giao trước
// ngày chứng từ, mặt hàng không có trong danh mục…) luôn kiểm tra.
// ============================================================
import type { PrecheckIssue } from '@/lib/order-precheck'

export const ORDER_CHECK_RULES = [
  { key: 'atp', label: 'Tồn kho khả dụng (ATP) không đủ', codes: ['atp'] },
  { key: 'belowPrice', label: 'Giá bán thấp hơn bảng giá', codes: ['below-price'] },
  { key: 'duplicateLine', label: 'Trùng mặt hàng giữa các dòng (cùng kho)', codes: ['duplicate'] },
  { key: 'dueDate', label: 'Ngày giao đã qua hoặc là Chủ nhật', codes: ['due-past', 'due-sunday'] },
  { key: 'dupOrder', label: 'Đơn trùng: cùng khách, cùng ngày giao', codes: ['dup-order'], history: true },
  { key: 'qtyAnomaly', label: 'Số lượng bất thường so với lịch sử khách', codes: ['qty-anomaly'], history: true },
  { key: 'priceChange', label: 'Giá lệch nhiều so với lần bán trước', codes: ['price-change'], history: true },
] as const satisfies readonly { key: string; label: string; codes: readonly PrecheckIssue['code'][]; history?: boolean }[]

export type OrderCheckRuleKey = (typeof ORDER_CHECK_RULES)[number]['key']

export interface OrderCheckConfig {
  /** Công tắc tổng — tắt = không hiện cảnh báo nào (lỗi vẫn kiểm) */
  enabled: boolean
  /** Thông báo nổi khi vừa phát hiện cảnh báo theo lịch sử khách */
  notices: boolean
  rules: Record<OrderCheckRuleKey, boolean>
}

export const DEFAULT_ORDER_CHECK_CONFIG: OrderCheckConfig = {
  enabled: true,
  notices: true,
  rules: Object.fromEntries(ORDER_CHECK_RULES.map((r) => [r.key, true])) as Record<OrderCheckRuleKey, boolean>,
}

/** Chuỗi JSON (DB) hoặc object (body PUT) → cấu hình hợp lệ; thiếu/sai kiểu → mặc định (bật) */
export function parseOrderCheckConfig(raw: unknown): OrderCheckConfig {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try { v = raw ? JSON.parse(raw) : null } catch { v = null }
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const rulesIn = o.rules && typeof o.rules === 'object' ? (o.rules as Record<string, unknown>) : {}
  const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d)
  return {
    enabled: bool(o.enabled, true),
    notices: bool(o.notices, true),
    rules: Object.fromEntries(ORDER_CHECK_RULES.map((r) => [r.key, bool(rulesIn[r.key], true)])) as Record<OrderCheckRuleKey, boolean>,
  }
}

const RULE_BY_CODE = new Map<string, OrderCheckRuleKey>(ORDER_CHECK_RULES.flatMap((r) => r.codes.map((c) => [c, r.key] as const)))

/** Có hiển thị vấn đề này không — lỗi luôn hiển thị */
export function isIssueEnabled(cfg: OrderCheckConfig, issue: Pick<PrecheckIssue, 'level' | 'code'>): boolean {
  if (issue.level === 'error') return true
  if (!cfg.enabled) return false
  const rule = RULE_BY_CODE.get(issue.code)
  return rule ? cfg.rules[rule] : true
}

/** Cần tải lịch sử khách không (đơn trùng / SL / giá) */
export function historyNeeds(cfg: OrderCheckConfig): { duplicates: boolean; items: boolean } {
  const on = (k: OrderCheckRuleKey) => cfg.enabled && cfg.rules[k]
  return { duplicates: on('dupOrder'), items: on('qtyAnomaly') || on('priceChange') }
}
