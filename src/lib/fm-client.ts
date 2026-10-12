// ============================================================
// FARMERS MARKET — API client (Bearer token)
// Website chạy trong iframe preview (cross-site) nên cookie
// SameSite=Lax không được gửi — dùng Bearer token qua localStorage.
// ============================================================

const TOKEN_KEY = 'fm_token'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* localStorage bị chặn */
  }
}

/** Sự kiện bắn ra khi API trả 401 — page.tsx lắng nghe để đăng xuất */
export const UNAUTHORIZED_EVENT = 'fm:unauthorized'

function notifyUnauthorized() {
  try {
    setToken(null)
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
  } catch {
    /* SSR / môi trường không có window */
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const SYNC_TIMEOUT_MS = 120_000

interface ApiOptions extends RequestInit {
  /** timeout riêng (ms) — mặc định 30s; endpoint /sync nên đặt 120s */
  timeoutMs?: number
}

/** Lỗi mạng thân thiện cho người dùng (thay vì TypeError thô của fetch) */
export class ApiNetworkError extends Error {
  constructor() {
    super('Không thể kết nối máy chủ. Vui lòng kiểm tra mạng và thử lại.')
    this.name = 'ApiNetworkError'
  }
}

export async function api(url: string, opts: ApiOptions = {}): Promise<Response> {
  const { timeoutMs, ...init } = opts
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const ms = timeoutMs ?? (url.includes('/sync') ? SYNC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
  // Kết hợp timeout nội bộ với signal của caller (nếu có)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms)
  const onCallerAbort = () => ctrl.abort()
  init.signal?.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const res = await fetch(url, {
      ...init,
      headers,
      credentials: 'include',
      cache: 'no-store',
      signal: ctrl.signal,
    })
    // Token hết hạn/không hợp lệ → xóa token + báo cho app đăng xuất tập trung
    // (trừ chính các endpoint auth để tránh vòng lặp)
    if (res.status === 401 && !url.includes('/api/auth/')) {
      notifyUnauthorized()
    }
    return res
  } catch (e) {
    // Timeout hoặc mất mạng → lỗi thân thiện thay vì TypeError thô
    if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new ApiNetworkError()
    }
    if (e instanceof TypeError) throw new ApiNetworkError()
    throw e
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onCallerAbort)
  }
}

/** Parse JSON an toàn: trả undefined khi body rỗng / không phải JSON */
export async function safeJson(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? ''
  if (res.status === 204 || !ct.includes('application/json')) return undefined
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** GET + parse JSON; trả null khi 401 (đã bắn sự kiện fm:unauthorized) */
export async function apiJson<T = unknown>(url: string, opts: ApiOptions = {}): Promise<T | null> {
  const res = await api(url, opts)
  if (res.status === 401) return null
  return (await safeJson(res)) as T | null
}
