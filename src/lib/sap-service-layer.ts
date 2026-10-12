// ============================================================
// SAP B1 SERVICE LAYER CLIENT (OData v2)
// Đăng nhập bằng Login endpoint, giữ session trong bộ nhớ máy chủ,
// tự re-login khi session hết hạn (401). Tất cả request chạy
// server-side nên thông tin đăng nhập SAP không bao giờ xuống browser.
// ============================================================

import { db as prisma } from '@/lib/db'
import { logSapAudit } from './sap-audit'

export interface SapConfig {
  serviceLayerUrl: string
  companyDb: string
  sapUser: string
  sapPassword: string
  /** Bỏ qua xác thực chứng chỉ SSL (dành cho Service Layer HTTPS self-signed) */
  sslSkipVerify?: boolean
}

export interface SapSettings extends SapConfig {
  connected: boolean
  lastSyncAt: string | null
}

export interface SapCallResult<T = unknown> {
  ok: boolean
  status: number
  data?: T
  error?: string
}

/** Tùy chọn ghi audit cho từng lệnh gọi */
export interface SapCallOpts {
  /** 'errors' (mặc định GET): chỉ ghi khi lỗi · 'always': luôn ghi · 'off': không ghi */
  audit?: 'errors' | 'always' | 'off'
  /** id bản ghi audit gốc nếu đây là lệnh Retry từ màn hình Audit */
  retryOf?: string
}

const TIMEOUT_MS = 12_000

// ---------- Hỗ trợ bỏ qua xác thực SSL (chứng chỉ self-signed) ----------

interface SslExtra {
  /** Các field bổ sung truyền vào fetch init (tls/dispatcher) */
  init: Record<string, unknown>
  /** True nếu phải dùng biến môi trường NODE_TLS_REJECT_UNAUTHORIZED tạm thời */
  toggleEnv: boolean
}

let sslExtraCache: SslExtra | undefined

/** Chuẩn bị tùy chọn fetch để bỏ qua xác thực SSL, theo runtime hiện tại */
async function sslFetchExtra(skip: boolean): Promise<SslExtra> {
  if (!skip) return { init: {}, toggleEnv: false }
  if (sslExtraCache) return sslExtraCache

  // Runtime Bun (bun run dev / bunx): tùy chọn `tls.rejectUnauthorized` là chính thức
  const isBun = typeof process !== 'undefined' && Boolean((process as unknown as { versions?: { bun?: string } }).versions?.bun)
  if (isBun) {
    sslExtraCache = { init: { tls: { rejectUnauthorized: false } }, toggleEnv: false }
    return sslExtraCache
  }

  // Runtime Node: thử tạo undici Agent (từ chối bundler phân tích tĩnh bằng dynamic import)
  try {
    const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<Record<string, unknown>>
    const mod = (await dynImport('undici')) as { Agent?: new (o: unknown) => unknown }
    if (mod?.Agent) {
      sslExtraCache = { init: { dispatcher: new mod.Agent({ connect: { rejectUnauthorized: false } }) }, toggleEnv: false }
      return sslExtraCache
    }
  } catch {
    /* không có undici — dùng phương án môi trường bên dưới */
  }
  sslExtraCache = { init: {}, toggleEnv: true }
  return sslExtraCache
}

async function withEnvTlsOff<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev
  }
}

// ---------- Mutex cho đường tắt NODE_TLS_REJECT_UNAUTHORIZED ----------
// Biến môi trường là TOÀN CỤC của process: nếu 2 request cùng bật/tắt xen kẽ,
// request khác có thể vô tình chạy với TLS verify bị tắt. Serialize đường này
// để không bao giờ có 2 lần "tắt TLS" chồng lên nhau. (Đường ưu tiên vẫn là
// undici Agent dispatcher — chỉ áp dụng cho 1 request, không ảnh hưởng toàn cục.)
let tlsToggleQueue: Promise<void> = Promise.resolve()

function withTlsToggleMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = tlsToggleQueue.then(fn)
  // Giữ chuỗi không bị đứt khi 1 lượt lỗi — lượt sau vẫn chạy được
  tlsToggleQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** fetch() có hỗ trợ bỏ qua xác thực SSL khi sslSkipVerify bật */
async function sslFetch(url: string, init: RequestInit, skip?: boolean): Promise<Response> {
  const extra = await sslFetchExtra(Boolean(skip))
  const merged = { ...init, ...extra.init } as RequestInit
  if (extra.toggleEnv) return withTlsToggleMutex(() => withEnvTlsOff(() => fetch(url, merged)))
  return fetch(url, merged)
}

/** Đọc cấu hình Service Layer từ bảng AppSettings */
export async function loadSapSettings(): Promise<SapSettings | null> {
  const s = await prisma.appSettings.findUnique({ where: { id: 'main' } })
  if (!s) return null
  return {
    serviceLayerUrl: s.serviceLayerUrl.trim(),
    companyDb: s.companyDb.trim(),
    sapUser: s.sapUser.trim(),
    sapPassword: s.sapPassword,
    sslSkipVerify: s.sslSkipVerify,
    connected: s.connected,
    lastSyncAt: s.lastSyncAt ? s.lastSyncAt.toISOString() : null,
  }
}

/** Cấu hình đã đủ để gọi Service Layer chưa */
export function isSapConfigured(s: SapSettings | null): s is SapSettings {
  return Boolean(s && s.serviceLayerUrl && s.companyDb && s.sapUser && s.sapPassword)
}

// ---------- Session cache (tránh login lại mỗi request) ----------

interface CachedSession {
  cookie: string
  version: string
  expiresAt: number
}
const sessions = new Map<string, CachedSession>()

function sessionKey(c: SapConfig) {
  return `${c.serviceLayerUrl}|${c.companyDb}|${c.sapUser}|${c.sapPassword}`
}

/** Gộp các header Set-Cookie của B1 thành chuỗi Cookie (B1SESSION + ROUTEID…) */
function extractCookies(headers: Headers): string {
  const parts: string[] = []
  for (const sc of headers.getSetCookie()) {
    const nv = sc.split(';')[0]?.trim()
    if (nv && nv.includes('=')) parts.push(nv)
  }
  return parts.join('; ')
}

async function sapLogin(c: SapConfig): Promise<CachedSession> {
  const base = c.serviceLayerUrl.replace(/\/+$/, '')
  let res: Response
  try {
    res = await sslFetch(
      `${base}/Login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CompanyDB: c.companyDb, UserName: c.sapUser, Password: c.sapPassword }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      },
      c.sslSkipVerify,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('TimeoutError') || msg.includes('aborted')) {
      throw new Error(`Service Layer không phản hồi sau ${TIMEOUT_MS / 1000}s — kiểm tra URL/firewall`)
    }
    throw new Error(`Không kết nối được Service Layer tại ${base} (${msg})`)
  }

  if (!res.ok) {
    throw new Error(sapErrorVN(res.status, await safeJson(res)))
  }
  const json = (await res.json()) as { SessionId?: string; Version?: string; SessionTimeout?: number }
  const cookie = extractCookies(res.headers)
  if (!cookie) throw new Error('Service Layer không trả về session (B1SESSION)')

  const timeoutMin = Number(json.SessionTimeout) > 0 ? Number(json.SessionTimeout) : 30
  const session: CachedSession = {
    cookie,
    version: json.Version ?? '',
    expiresAt: Date.now() + Math.max(2, timeoutMin - 2) * 60_000,
  }
  sessions.set(sessionKey(c), session)
  return session
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** Map lỗi HTTP của Service Layer sang thông báo tiếng Việt dễ hiểu */
export function sapErrorVN(status: number, body: unknown): string {
  // SL trả message theo 2 dạng tùy phiên bản:
  //  - {"error":{"message":{"lang":"en-us","value":"…"}}}  (OData v2 chuẩn)
  //  - {"error":{"message":"…"}}                            (một số bản SL trả chuỗi thuần)
  let detail = ''
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error
    if (typeof err === 'string') detail = err
    else if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message
      if (typeof msg === 'string') detail = msg
      else if (msg && typeof msg === 'object') {
        const v = (msg as { value?: unknown }).value
        if (typeof v === 'string') detail = v
      }
    }
  }
  const suffix = detail ? ` — ${detail}` : ''
  switch (status) {
    case 400: return `Service Layer từ chối yêu cầu (400)${suffix}`
    case 401: return `Sai thông tin đăng nhập SAP hoặc session hết hạn (401)${suffix}`
    case 403: return `Tài khoản SAP không có quyền thao tác này (403)${suffix}`
    case 404: return `Không tìm thấy tài nguyên trên Service Layer (404)${suffix}`
    case 429: return `Service Layer quá tải, thử lại sau ít phút (429)${suffix}`
    default:
      if (status >= 500) return `Lỗi phía máy chủ SAP B1 (${status})${suffix}`
      return `Lỗi không xác định (${status})${suffix}`
  }
}

/**
 * GET dữ liệu từ Service Layer.
 * Tự login khi chưa có session, tự re-login 1 lần khi gặp 401.
 */
export async function sapGet<T = unknown>(
  c: SapConfig,
  path: string,
  query: Record<string, string | undefined> = {},
  opts: SapCallOpts = {},
): Promise<SapCallResult<T>> {
  const base = c.serviceLayerUrl.replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&')
  const fullPath = cleanPath + (qs ? `?${qs}` : '')
  const url = `${base}${fullPath}`

  for (let attempt = 0; attempt < 2; attempt++) {
    let session = sessions.get(sessionKey(c))
    if (!session || session.expiresAt < Date.now()) {
      try {
        session = await sapLogin(c)
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        // AUDIT: GET lỗi (kể cả lỗi login) — lưu path+query để Retry được
        if (opts.audit !== 'off')
          void logSapAudit({ method: 'GET', path: fullPath, ok: false, httpStatus: 0, error, retryOf: opts.retryOf })
        return { ok: false, status: 0, error }
      }
    }
    const startedAt = Date.now()
    try {
      const res = await sslFetch(
        url,
        {
          headers: { Cookie: session.cookie, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        },
        c.sslSkipVerify,
      )
      if (res.status === 401 && attempt === 0) {
        sessions.delete(sessionKey(c)) // session hết hạn → login lại rồi thử thêm lần nữa
        continue
      }
      if (!res.ok) {
        const error = sapErrorVN(res.status, await safeJson(res))
        // AUDIT: GET lỗi — lưu path+query đầy đủ để Retry được
        if (opts.audit !== 'off')
          void logSapAudit({ method: 'GET', path: fullPath, ok: false, httpStatus: res.status, durationMs: Date.now() - startedAt, error, retryOf: opts.retryOf })
        return { ok: false, status: res.status, error }
      }
      if (opts.audit === 'always')
        void logSapAudit({ method: 'GET', path: fullPath, ok: true, httpStatus: res.status, durationMs: Date.now() - startedAt, resultSummary: 'HTTP 200', retryOf: opts.retryOf })
      return { ok: true, status: res.status, data: (await res.json()) as T }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const error = msg.includes('TimeoutError') || msg.includes('aborted')
        ? `Service Layer không phản hồi sau ${TIMEOUT_MS / 1000}s`
        : `Không kết nối được Service Layer (${msg})`
      if (opts.audit !== 'off')
        void logSapAudit({ method: 'GET', path: fullPath, ok: false, httpStatus: 0, durationMs: Date.now() - startedAt, error, retryOf: opts.retryOf })
      return { ok: false, status: 0, error }
    }
  }
  const authError = 'Không thể xác thực session với Service Layer'
  if (opts.audit !== 'off')
    void logSapAudit({ method: 'GET', path: fullPath, ok: false, httpStatus: 401, error: authError, retryOf: opts.retryOf })
  return { ok: false, status: 401, error: authError }
}

/**
 * GET TOÀN BỘ bản ghi khớp filter — tự động phân trang ($top/$skip) cho tới
 * khi lấy hết dữ liệu. Xử lý đúng cả trường hợp Service Layer giới hạn số
 * bản ghi/trang nhỏ hơn $top yêu cầu (server-driven paging): skip được tăng
 * theo số dòng THỰC NHẬN từng trang nên không bỏ sót bản ghi nào.
 * $top mỗi lần gọi mặc định 500 (đổi bằng biến môi trường SAP_BATCH_SIZE),
 * giới hạn an toàn 50.000 bản ghi.
 */
export async function sapGetAll<T = unknown>(
  c: SapConfig,
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<{ ok: boolean; data?: T[]; total: number; error?: string }> {
  const startedAt = Date.now()
  const batch = Math.max(1, Number(process.env.SAP_BATCH_SIZE) || 500)
  const MAX_RECORDS = 50_000
  const base: Record<string, string | undefined> = { ...query, $top: undefined, $skip: undefined }
  const all: T[] = []
  let skip = 0
  let prevFirst = '' // JSON của dòng đầu trang trước — để phát hiện server không hỗ trợ $skip
  while (all.length < MAX_RECORDS) {
    const page = await sapGet<{ value?: T[] }>(c, path, { ...base, $top: String(batch), $skip: String(skip) }, { audit: 'off' })
    if (!page.ok || !page.data) {
      // AUDIT: 1 dòng tổng kết cho cả lần lấy-all (không spam từng trang)
      void logSapAudit({
        method: 'GET', path, ok: false, httpStatus: page.status,
        durationMs: Date.now() - startedAt, error: page.error,
        resultSummary: `Lấy-all: nhận ${all.length} bản ghi trước khi lỗi`,
      })
      return { ok: false, total: all.length, error: page.error }
    }
    const rows = page.data.value ?? []
    if (rows.length === 0) break // trang rỗng → đã lấy hết dữ liệu
    all.push(...rows)
    // ⚠ QUAN TRỌNG: Service Layer thật tự giới hạn số bản ghi trả về mỗi trang
    // (server-driven paging) — thường NHỎ HƠN $top yêu cầu (ví dụ chỉ trả ~20 dòng
    // dù client yêu cầu $top=500). Vì vậy bắt buộc tăng skip theo SỐ DÒNG THỰC NHẬN,
    // không tăng theo batch — nếu không sẽ bỏ sót dữ liệu giữa các trang và vòng lặp
    // kết thúc sớm (lỗi "danh sách chỉ load 20 dòng"). Vòng lặp dừng khi gặp 1 trang rỗng.
    if (rows.length < batch && skip > 0) {
      const first = rows.length > 0 ? JSON.stringify(rows[0]) : ''
      if (first && first === prevFirst) break // server lặp lại cùng trang → không hỗ trợ $skip, dừng để tránh tràn
    }
    prevFirst = rows.length > 0 ? JSON.stringify(rows[0]) : ''
    skip += rows.length
  }
  // AUDIT: tổng kết lấy-all thành công (1 dòng cho toàn bộ các trang)
  void logSapAudit({
    method: 'GET', path, ok: true, httpStatus: 200,
    durationMs: Date.now() - startedAt,
    resultSummary: `Đã lấy ${all.length} bản ghi (tự phân trang)`,
  })
  return { ok: true, data: all, total: all.length }
}

/** POST dữ liệu sang Service Layer (dùng cho đẩy đơn hàng sau này). Mọi lần gọi đều được ghi audit */
export async function sapPost<T = unknown>(c: SapConfig, path: string, body: unknown, opts: SapCallOpts = {}): Promise<SapCallResult<T>> {
  const base = c.serviceLayerUrl.replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  let session = sessions.get(sessionKey(c))
  if (!session || session.expiresAt < Date.now()) {
    try {
      session = await sapLogin(c)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      void logSapAudit({ method: 'POST', path: cleanPath, ok: false, httpStatus: 0, error, payload: body, retryOf: opts.retryOf })
      return { ok: false, status: 0, error }
    }
  }
  const startedAt = Date.now()
  try {
    const res = await sslFetch(
      `${base}${cleanPath}`,
      {
        method: 'POST',
        headers: { Cookie: session.cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      },
      c.sslSkipVerify,
    )
    if (!res.ok) {
      const error = sapErrorVN(res.status, await safeJson(res))
      void logSapAudit({ method: 'POST', path: cleanPath, ok: false, httpStatus: res.status, durationMs: Date.now() - startedAt, error, payload: body, retryOf: opts.retryOf })
      return { ok: false, status: res.status, error }
    }
    const data = (await res.json()) as T
    // Tóm tắt kết quả cho audit: DocEntry/DocNum nếu có (POST /Orders…)
    const d = data as { DocEntry?: unknown; DocNum?: unknown } | null
    const summary =
      typeof d?.DocEntry === 'number' || typeof d?.DocNum === 'number'
        ? `Đã tạo chứng từ — DocEntry ${d?.DocEntry ?? '?'} / DocNum ${d?.DocNum ?? '?'}`
        : `HTTP ${res.status}`
    void logSapAudit({ method: 'POST', path: cleanPath, ok: true, httpStatus: res.status, durationMs: Date.now() - startedAt, payload: body, resultSummary: summary, retryOf: opts.retryOf })
    return { ok: true, status: res.status, data }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    void logSapAudit({ method: 'POST', path: cleanPath, ok: false, httpStatus: 0, durationMs: Date.now() - startedAt, error, payload: body, retryOf: opts.retryOf })
    return { ok: false, status: 0, error }
  }
}

/** Xóa session cache (gọi khi đổi mật khẩu/cấu hình) */
export function sapClearSessions() {
  sessions.clear()
}

/**
 * PATCH dữ liệu lên Service Layer (dùng để SỬA chứng từ đã tồn tại — vd /Orders(DocEntry)).
 * Gửi kèm header B1S-ReplaceCollectionsOnPatch=true để các collection con
 * (DocumentLines) được THAY THẾ toàn bộ: dòng có LineNum → cập nhật, dòng
 * không có LineNum → thêm mới, dòng bị bỏ khỏi mảng → bị xóa.
 * SL trả 204 No Content khi thành công (không có body). Luôn ghi audit.
 */
export async function sapPatch<T = unknown>(c: SapConfig, path: string, body: unknown, opts: SapCallOpts = {}): Promise<SapCallResult<T>> {
  const base = c.serviceLayerUrl.replace(/\/+$/, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`
  let session = sessions.get(sessionKey(c))
  if (!session || session.expiresAt < Date.now()) {
    try {
      session = await sapLogin(c)
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      void logSapAudit({ method: 'PATCH', path: cleanPath, ok: false, httpStatus: 0, error, payload: body, retryOf: opts.retryOf })
      return { ok: false, status: 0, error }
    }
  }
  const startedAt = Date.now()
  try {
    const res = await sslFetch(
      `${base}${cleanPath}`,
      {
        method: 'PATCH',
        headers: {
          Cookie: session.cookie,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'B1S-ReplaceCollectionsOnPatch': 'true',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      },
      c.sslSkipVerify,
    )
    if (!res.ok) {
      const error = sapErrorVN(res.status, await safeJson(res))
      void logSapAudit({ method: 'PATCH', path: cleanPath, ok: false, httpStatus: res.status, durationMs: Date.now() - startedAt, error, payload: body, retryOf: opts.retryOf })
      return { ok: false, status: res.status, error }
    }
    // PATCH thành công: SL thường trả 204 không có body — đọc body một cách an toàn nếu có
    let data: T | undefined
    if (res.status !== 204) {
      try {
        data = (await res.json()) as T
      } catch {
        /* body rỗng — bỏ qua */
      }
    }
    void logSapAudit({ method: 'PATCH', path: cleanPath, ok: true, httpStatus: res.status, durationMs: Date.now() - startedAt, payload: body, resultSummary: `Đã cập nhật chứng từ — HTTP ${res.status}`, retryOf: opts.retryOf })
    return { ok: true, status: res.status, data }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    void logSapAudit({ method: 'PATCH', path: cleanPath, ok: false, httpStatus: 0, durationMs: Date.now() - startedAt, error, payload: body, retryOf: opts.retryOf })
    return { ok: false, status: 0, error }
  }
}

/** Thử đăng nhập Service Layer — dùng cho "Kiểm tra kết nối". Ghi audit (che mật khẩu) */
export async function sapTestLogin(
  c: SapConfig,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const startedAt = Date.now()
  try {
    const s = await sapLogin(c)
    void logSapAudit({
      method: 'POST', path: '/Login', ok: true, httpStatus: 200,
      durationMs: Date.now() - startedAt,
      payload: { CompanyDB: c.companyDb, UserName: c.sapUser, Password: c.sapPassword },
      resultSummary: `Đăng nhập OK — SAP Version ${s.version || 'không rõ'}`,
    })
    return { ok: true, version: s.version }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    void logSapAudit({
      method: 'POST', path: '/Login', ok: false, httpStatus: 0,
      durationMs: Date.now() - startedAt, error,
      payload: { CompanyDB: c.companyDb, UserName: c.sapUser, Password: c.sapPassword },
    })
    return { ok: false, error }
  }
}
