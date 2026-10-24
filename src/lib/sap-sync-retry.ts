// ============================================================
// CHỐNG TRÙNG & TỰ THỬ LẠI KHI ĐẨY ĐƠN SANG SAP B1 — logic thuần
// Phân loại lỗi đẩy để biết có được tự thử lại hay không:
//   safe      — CHẮC CHẮN chưa tới SAP (login lỗi, không kết nối được, 401,
//               tra marker lỗi, đang có lượt đẩy khác) → tự thử lại
//   unknown   — không rõ SAP đã ghi chưa (timeout, 5xx, mất kết nối giữa
//               chừng) nhưng chứng từ có gắn UDF U_FM_LocalId → lần đẩy sau
//               tra UDF trước, nên tự thử lại vẫn KHÔNG tạo trùng
//   reconcile — không rõ SAP đã ghi chưa và KHÔNG có UDF → không tự thử lại,
//               người dùng đối chiếu thủ công trên SAP
//   business  — SAP từ chối dữ liệu (4xx) → không tự thử lại, cần sửa đơn
// ============================================================

import type { SapCallResult } from './sap-service-layer'

export type SapSyncErrorKind = 'safe' | 'unknown' | 'reconcile' | 'business'

/** Giãn cách giữa các lần tự thử lại (phút) — sau lần thất bại thứ 1..5 */
export const SAP_RETRY_BACKOFF_MIN = [2, 5, 15, 60, 240] as const
/** Số lần tự thử lại tối đa; hết lượt → chờ xử lý tay */
export const SAP_RETRY_MAX_ATTEMPTS = SAP_RETRY_BACKOFF_MIN.length

/** Phân loại lỗi của một lệnh POST tạo chứng từ (chưa xét UDF) */
export function classifySapPostFailure(res: Pick<SapCallResult, 'status' | 'failKind'>): Exclude<SapSyncErrorKind, 'reconcile'> {
  const { status } = res
  if (status === 0) return res.failKind === 'login' || res.failKind === 'connect' ? 'safe' : 'unknown'
  if (status === 401 || status === 429) return 'safe'
  if (status === 408 || status >= 500) return 'unknown'
  return 'business'
}

/** "Không rõ" + chứng từ không mang UDF marker → phải đối chiếu thủ công */
export function withMarker(kind: Exclude<SapSyncErrorKind, 'reconcile'>, udf: boolean): SapSyncErrorKind {
  return kind === 'unknown' && !udf ? 'reconcile' : kind
}

/** Loại lỗi được tự thử lại */
export function isAutoRetryable(kind: string | null | undefined): boolean {
  return kind === 'safe' || kind === 'unknown'
}

export interface SapRetryState {
  sapSyncErrorKind: SapSyncErrorKind | null
  sapSyncAttempts: number
  sapNextRetryAt: Date | null
  sapSyncLastAt: Date
}

/**
 * Trạng thái thử lại sau một lần đẩy.
 * - Thành công / không cấu hình SAP → xoá trạng thái lỗi.
 * - auto=true (job nền): tăng số lần đã tự thử; auto=false (người dùng bấm
 *   đẩy / tạo đơn): đếm lại từ 0 vì người dùng vừa can thiệp.
 * - Lần tự thử kế tiếp chỉ đặt lịch khi lỗi thuộc loại tự thử được và còn lượt.
 */
export function nextRetryState(
  outcome: { ok: boolean; kind?: SapSyncErrorKind | null },
  prevAttempts: number,
  auto: boolean,
  now: Date = new Date(),
): SapRetryState {
  if (outcome.ok) return { sapSyncErrorKind: null, sapSyncAttempts: 0, sapNextRetryAt: null, sapSyncLastAt: now }
  const kind = outcome.kind ?? 'business'
  const attempts = auto ? prevAttempts + 1 : 0
  const delayMin = isAutoRetryable(kind) && attempts < SAP_RETRY_MAX_ATTEMPTS ? SAP_RETRY_BACKOFF_MIN[attempts] : null
  return {
    sapSyncErrorKind: kind,
    sapSyncAttempts: attempts,
    sapNextRetryAt: delayMin === null ? null : new Date(now.getTime() + delayMin * 60_000),
    sapSyncLastAt: now,
  }
}

/** Nhãn tiếng Việt cho loại lỗi (UI) */
export const SAP_ERROR_KIND_LABEL: Record<SapSyncErrorKind, string> = {
  safe: 'Chưa tới SAP — sẽ tự thử lại',
  unknown: 'Không rõ SAP đã nhận — sẽ tự thử lại (có UDF chống trùng)',
  reconcile: 'Cần đối chiếu trên SAP',
  business: 'SAP từ chối — cần sửa đơn',
}

export interface SapMatchOrder {
  DocEntry: number
  DocNum?: number
  DocDate?: string
  DocDueDate?: string
  DocTotal?: number
}

/**
 * Đánh giá ứng viên đối chiếu: so tổng tiền và ngày giao với đơn local.
 * Lệch tổng tiền cho phép = max(1.000đ, 0,5%) vì SAP làm tròn theo dòng.
 */
export function rankSapCandidates(
  local: { grandTotal: number; docDueDate: string },
  rows: SapMatchOrder[],
): (SapMatchOrder & { totalDiff: number; totalMatch: boolean; dueMatch: boolean })[] {
  const tol = Math.max(1000, Math.abs(local.grandTotal) * 0.005)
  const due = local.docDueDate.slice(0, 10)
  return rows
    .map((r) => {
      const totalDiff = (Number(r.DocTotal) || 0) - local.grandTotal
      return { ...r, totalDiff, totalMatch: Math.abs(totalDiff) <= tol, dueMatch: (r.DocDueDate ?? '').slice(0, 10) === due }
    })
    // Khớp tổng tiền là tín hiệu mạnh hơn khớp ngày giao
    .sort((a, b) => 2 * Number(b.totalMatch) + Number(b.dueMatch) - (2 * Number(a.totalMatch) + Number(a.dueMatch)) || b.DocEntry - a.DocEntry)
}
