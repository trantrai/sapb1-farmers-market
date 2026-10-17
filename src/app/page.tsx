'use client'

import { useEffect, useState } from 'react'
import type { SessionUser } from '@/lib/fm-shared'
import { api, setToken, UNAUTHORIZED_EVENT } from '@/lib/fm-client'
import LoginView from '@/components/fm/login-view'
import ChangePasswordView from '@/components/fm/change-password-view'
import AppShell from '@/components/fm/app-shell'

export default function Page() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 401 chỉ nghĩa là chưa đăng nhập — không phải lỗi
    api('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => setUser(json?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
    // Token hết hạn giữa phiên (API trả 401) → đăng xuất tập trung
    const onUnauthorized = () => setUser(null)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  if (loading) {
    return (
      <div className="fm-login">
        <div role="status" style={{ textAlign: 'center', color: 'var(--fm-text-2)', fontSize: 14 }}>
          <img src="/logo-farmers-market.png" alt="" style={{ width: 72, height: 72, borderRadius: '50%', margin: '0 auto 12px', border: '3px solid var(--fm-yellow)' }} />
          Đang tải hệ thống…
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <LoginView
        onLogin={(loginUser) => {
          setToken(loginUser.token)
          setUser(loginUser)
        }}
      />
    )
  }

  // Tài khoản seed / được cấp mật khẩu lần đầu → BẮT BUỘC đổi mật khẩu,
  // không cho vào app (không có nút bỏ qua) cho tới khi đổi xong.
  if (user && user.mustChangePassword) {
    return (
      <ChangePasswordView
        onDone={() => {
          // Đổi xong → tải lại session (mustChangePassword đã = false)
          api('/api/auth/me')
            .then((r) => (r.ok ? r.json() : null))
            .then((json) => {
              if (json?.user) setUser(json.user)
            })
            .catch(() => { /* giữ nguyên màn hình đổi mật khẩu */ })
        }}
      />
    )
  }

  return (
    <AppShell
      user={user}
      onLogout={async () => {
        try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* bỏ qua */ }
        setToken(null)
        setUser(null)
      }}
    />
  )
}
