'use client'

import { useEffect, useState } from 'react'
import type { SessionUser } from '@/lib/fm-shared'
import { api, setToken } from '@/lib/fm-client'
import LoginView from '@/components/fm/login-view'
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
  }, [])

  if (loading) {
    return (
      <div className="fm-login">
        <div style={{ textAlign: 'center', color: 'var(--fm-text-2)', fontSize: 14 }}>
          { }
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
