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

interface ApiOptions extends RequestInit {
  /** tự parse JSON và ném lỗi nếu !ok */
  json?: boolean
}

export async function api(url: string, opts: ApiOptions = {}): Promise<Response> {
  const headers = new Headers(opts.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (opts.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  return fetch(url, {
    ...opts,
    headers,
    credentials: 'include',
    cache: 'no-store',
  })
}

/** GET + parse JSON; trả null khi 401 */
export async function apiJson<T = unknown>(url: string, opts: ApiOptions = {}): Promise<T | null> {
  const res = await api(url, opts)
  if (res.status === 401) return null
  return (await res.json()) as T
}
