'use client'

import { useState } from 'react'
import { Lock, ShieldCheck } from 'lucide-react'
import { api } from '@/lib/fm-client'

interface Props {
  /** Gọi sau khi đổi mật khẩu thành công — nhận mật khẩu mới đã nhập */
  onDone: () => void
}

/**
 * Màn hình BẮT BUỘC đổi mật khẩu lần đầu (user.mustChangePassword === true).
 * Full-screen, không nút đóng, không nút bỏ qua — page.tsx chỉ render
 * AppShell sau khi user thoát trạng thái này.
 */
export default function ChangePasswordView({ onDone }: Props) {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) {
      setError('Mật khẩu nhập lại không khớp')
      return
    }
    setLoading(true)
    try {
      const res = await api('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError((json as { error?: string }).error ?? 'Đổi mật khẩu thất bại')
        return
      }
      onDone()
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
          <div className="fm-login__logo" aria-hidden="true">
            <ShieldCheck size={22} />
          </div>
          <h1 className="fm-login__title">ĐỔI MẬT KHẨU</h1>
          <p className="fm-login__subtitle">
            Tài khoản của bạn đang dùng mật khẩu ban đầu — vui lòng đặt mật khẩu mới
            để tiếp tục sử dụng hệ thống
          </p>
        </div>

        {error && (
          <div className="fm-alert fm-alert--error" role="alert">
            <div>
              <b>Không đổi được mật khẩu</b>
              {error}
            </div>
          </div>
        )}

        <form onSubmit={submit}>
          <div className="fm-field">
            <label className="fm-label" htmlFor="cp-old">Mật khẩu hiện tại</label>
            <div style={{ position: 'relative' }}>
              <input
                id="cp-old"
                type="password"
                className="fm-input"
                style={{ paddingLeft: 34 }}
                placeholder="Mật khẩu do quản trị viên cấp"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Lock size={16} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} aria-hidden="true" />
            </div>
          </div>

          <div className="fm-field">
            <label className="fm-label" htmlFor="cp-new">Mật khẩu mới</label>
            <div style={{ position: 'relative' }}>
              <input
                id="cp-new"
                type="password"
                className="fm-input"
                style={{ paddingLeft: 34 }}
                placeholder="Tối thiểu 8 ký tự, gồm chữ và số"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
              <Lock size={16} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} aria-hidden="true" />
            </div>
          </div>

          <div className="fm-field">
            <label className="fm-label" htmlFor="cp-confirm">Nhập lại mật khẩu mới</label>
            <div style={{ position: 'relative' }}>
              <input
                id="cp-confirm"
                type="password"
                className="fm-input"
                style={{ paddingLeft: 34 }}
                placeholder="Nhập lại mật khẩu mới"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
              <Lock size={16} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} aria-hidden="true" />
            </div>
          </div>

          <button type="submit" className="fm-login__submit" disabled={loading}>
            {loading ? 'Đang đổi…' : 'Đổi mật khẩu và tiếp tục →'}
          </button>
        </form>
      </div>
    </div>
  )
}
