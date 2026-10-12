'use client'

import { useState } from 'react'
import { LogIn, User, Lock } from 'lucide-react'
import type { SessionUser } from '@/lib/fm-shared'

type LoginUser = SessionUser & { token: string }

interface Props {
  onLogin: (user: LoginUser) => void
}

export default function LoginView({ onLogin }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Đăng nhập thất bại')
        return
      }
      onLogin({ ...json.user, token: json.token })
    } catch {
      setError('Không thể kết nối máy chủ')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fm-login">
      <div className="fm-login__panel">
        <div className="fm-login__brand">
          <div className="fm-login__logo" aria-hidden="true">F</div>
          <h1 className="fm-login__title">FARMERS MARKET</h1>
          <p className="fm-login__subtitle">Hệ thống Sale Order — SAP Business One</p>
        </div>

        {error && (
          <div className="fm-alert fm-alert--error" role="alert">
            <div>
              <b>Đăng nhập thất bại</b>
              {error}
            </div>
          </div>
        )}

        <form onSubmit={submit}>
          <div className="fm-field">
            <label className="fm-label" htmlFor="username">Tên đăng nhập</label>
            <div style={{ position: 'relative' }}>
              <input
                id="username"
                className="fm-input"
                style={{ paddingLeft: 34 }}
                placeholder="vd: admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
              <User size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} />
            </div>
          </div>

          <div className="fm-field">
            <label className="fm-label" htmlFor="password">Mật khẩu</label>
            <div style={{ position: 'relative' }}>
              <input
                id="password"
                type="password"
                className="fm-input"
                style={{ paddingLeft: 34 }}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Lock size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} />
            </div>
          </div>

          <button type="submit" className="fm-btn fm-btn--primary" style={{ width: '100%', marginTop: 6 }} disabled={loading}>
            <LogIn size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {loading ? 'Đang xử lý…' : 'Đăng nhập'}
          </button>
        </form>

        <div className="fm-hint" style={{ textAlign: 'center', marginTop: 16, lineHeight: 1.7 }}>
          Tài khoản demo — bấm để điền nhanh:
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginTop: 8 }}>
            {[['admin', 'admin123', 'Quản trị'], ['ketoan', 'ketoan123', 'Kế toán'], ['nhanvien', 'nhanvien123', 'Nhân viên']].map(([u, p, label]) => (
              <button
                key={u}
                type="button"
                className="fm-demo-chip"
                title={`${label} — ${u} / ${p}`}
                onClick={() => { setUsername(u); setPassword(p); setError('') }}
              >
                <User size={11} /> {u}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
