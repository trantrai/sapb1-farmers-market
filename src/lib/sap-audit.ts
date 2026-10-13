// ============================================================
// SAP SERVICE LAYER AUDIT — ghi nhật ký mọi lệnh gọi Service Layer
// vào bảng SapAuditLog để xem trên màn hình "Service Layer Audit"
// và RETRY (gửi lại) các lệnh POST/GET khi cần.
// Quy tắc:
//  - POST (đẩy dữ liệu / Login)  → LUÔN ghi (cả thành công lẫn lỗi)
//  - GET                          → chỉ ghi khi LỖI (tránh tràn log khi
//                                   sapGetAll lặp hàng chục trang)
//  - Ghi log KHÔNG BAO GIỜ ném exception — lỗi log không được ảnh hưởng
//    tới luồng nghiệp vụ chính.
//  - Mật khẩu luôn được CHE trước khi lưu payload.
// ============================================================

import { db as prisma } from '@/lib/db'

export interface SapAuditEntry {
  method: 'POST' | 'GET' | 'PATCH'
  path: string
  ok: boolean
  httpStatus?: number
  durationMs?: number
  error?: string
  /** JSON body đã gửi (POST) — sẽ được che mật khẩu trước khi lưu */
  payload?: unknown
  /** Tóm tắt kết quả: DocEntry/DocNum, số bản ghi… */
  resultSummary?: string
  /** id bản ghi gốc nếu đây là lệnh Retry */
  retryOf?: string
  /** Id của SapDatabase đã dùng cho lệnh gọi này (ghi vào SapAuditLog.sapDatabaseId) */
  sapDatabaseId?: string | null
}

/** Đệ quy che các trường mật khẩu trước khi lưu payload vào audit */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 6) return value
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^(password|password2|sapPassword)$/i.test(k) ? '***' : scrubSecrets(v, depth + 1)
    }
    return out
  }
  return value
}

const MAX_PAYLOAD_LEN = 8000

/** Ghi 1 dòng audit — best effort, không bao giờ ném exception */
export async function logSapAudit(entry: SapAuditEntry): Promise<void> {
  try {
    let payloadStr: string | null = null
    if (entry.payload !== undefined) {
      const scrubbed = JSON.stringify(scrubSecrets(entry.payload))
      payloadStr = scrubbed.length > MAX_PAYLOAD_LEN ? `${scrubbed.slice(0, MAX_PAYLOAD_LEN)}…(cắt)` : scrubbed
    }
    await prisma.sapAuditLog.create({
      data: {
        method: entry.method,
        path: entry.path.slice(0, 500),
        ok: entry.ok,
        httpStatus: entry.httpStatus ?? null,
        durationMs: Math.round(entry.durationMs ?? 0),
        error: entry.error?.slice(0, 1000) ?? null,
        payload: payloadStr,
        resultSummary: entry.resultSummary?.slice(0, 500) ?? null,
        retryOf: entry.retryOf ?? null,
        // DB đã dùng cho lệnh gọi — để Retry dùng đúng DB gốc thay vì DB của phiên hiện tại
        sapDatabaseId: entry.sapDatabaseId ?? null,
      },
    })
  } catch {
    /* audit không bao giờ phá nghiệp vụ chính */
  }
}
