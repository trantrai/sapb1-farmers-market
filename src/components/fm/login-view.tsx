'use client'

import { useEffect, useState } from 'react'
import { User, Lock, Database } from 'lucide-react'
import type { SessionUser } from '@/lib/fm-shared'

type LoginUser = SessionUser & { token: string }

interface Props {
  onLogin: (user: LoginUser) => void
}

interface DbOption {
  id: string
  label: string
  isDefault: boolean
}

export default function LoginView({ onLogin }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [dbs, setDbs] = useState<DbOption[]>([])
  const [databaseId, setDatabaseId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Danh sách database SAP để chọn khi đăng nhập (public endpoint)
  useEffect(() => {
    fetch('/api/auth/databases')
      .then((r) => r.json())
      .then((j: { databases?: DbOption[] }) => {
        const list = j.databases ?? []
        setDbs(list)
        const def = list.find((d) => d.isDefault) ?? list[0]
        if (def) setDatabaseId(def.id)
      })
      .catch(() => { /* không có database → đăng nhập không chọn DB */ })
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, databaseId: databaseId || undefined }),
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
          <div className="fm-login__live">
            <span className="fm-login__live-dot" />
            SAP B1 Service Layer v1.1
          </div>
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

          {dbs.length > 1 && (
            <div className="fm-field">
              <label className="fm-label" htmlFor="database">Database SAP B1</label>
              <div style={{ position: 'relative' }}>
                <select
                  id="database"
                  className="fm-input"
                  style={{ paddingLeft: 34, appearance: 'auto' }}
                  value={databaseId}
                  onChange={(e) => setDatabaseId(e.target.value)}
                  aria-label="Chọn database SAP B1"
                >
                  {dbs.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}{d.isDefault ? ' (mặc định)' : ''}
                    </option>
                  ))}
                </select>
                <Database size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} />
              </div>
            </div>
          )}

          <button type="submit" className="fm-login__submit" disabled={loading}>
            {loading ? 'Đang xử lý…' : 'Đăng nhập hệ thống →'}
          </button>
        </form>
      </div>
    </div>
  )
}
