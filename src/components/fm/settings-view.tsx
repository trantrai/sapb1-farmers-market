'use client'

import { useEffect, useState } from 'react'
import { PlugZap, Save, Link2, Sparkles, Mail } from 'lucide-react'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

interface SettingsData {
  serviceLayerUrl: string
  companyDb: string
  sapUser: string
  sapPassword: string // luôn rỗng khi load — chỉ có giá trị khi user nhập mới
  hasPassword: boolean // đã có mật khẩu lưu trên server chưa
  sslSkipVerify: boolean
  connected: boolean
  lastSyncAt: string | null
  suggestHistoryDays: number
  suggestMaxItems: number
  smtpHost: string
  smtpPort: number
  smtpUser: string
  smtpPass: string // luôn rỗng khi load — chỉ có giá trị khi user nhập mới
  hasSmtpPass: boolean
  smtpFromEmail: string
  smtpFromName: string
}

export default function SettingsView({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState<SettingsData | null>(null)
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)

  const load = async () => {
    const res = await api('/api/settings')
    if (res.status === 401) { window.location.reload(); return }
    const json = await res.json()
    // KHÔNG nạp mật khẩu đã che vào state — giữ ô mật khẩu rỗng,
    // server sẽ giữ mật khẩu cũ khi gửi chuỗi rỗng → không bao giờ ghi đè nhầm.
    setS({
      ...json.settings,
      sapPassword: '',
      smtpPass: '',
      hasPassword: Boolean(json.hasPassword),
      hasSmtpPass: Boolean(json.hasSmtpPass),
    })
  }
  useEffect(() => { load() }, [])

  const update = (patch: Partial<SettingsData>) => setS((cur) => (cur ? { ...cur, ...patch } : cur))

  const save = async () => {
    if (!s) return
    setBusy('save')
    setMsg(null)
    try {
      const res = await api('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không thể lưu cài đặt' })
        return
      }
      setS(json.settings)
      setMsg({ type: 'success', text: 'Đã lưu cấu hình kết nối SAP B1.' })
    } finally {
      setBusy(null)
    }
  }

  const testConn = async () => {
    setBusy('test')
    setMsg(null)
    try {
      const res = await api('/api/settings/test', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Kiểm tra kết nối thất bại' })
        await load()
        return
      }
      setMsg({ type: 'success', text: json.message })
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (!s) return <div className="fm-card"><div className="fm-empty">Đang tải cấu hình…</div></div>

  return (
    <div>
      <PageHeader
        breadcrumb={['Quản trị & Hệ thống', 'Cài đặt SAP B1']}
        title="Cài Đặt Kết Nối SAP Business One"
        badge="Cập nhật tức thời"
      />
      {/* Banner trạng thái kết nối */}
      <div className={`fm-conn-banner ${s.connected ? 'fm-conn-banner--ok' : 'fm-conn-banner--fail'}`} style={{ flexWrap: 'wrap' }}>
        <span className="dot" />
        {s.connected
          ? `Đã kết nối SAP B1 Service Layer — CSDL ${s.companyDb || '(chưa đặt tên)'}`
          : 'Chưa kết nối — hãy kiểm tra thông tin và bấm “Kiểm tra kết nối”'}
        {s.connected && s.lastSyncAt && (
          <span style={{ marginLeft: 'auto', fontWeight: 500, fontSize: 12 }}>
            Đồng bộ lần cuối: {new Date(s.lastSyncAt).toLocaleString('vi-VN')}
          </span>
        )}
      </div>

      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link2 size={18} /> Kết nối SAP Business One — Service Layer (OData v2)
        </h2>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label">Service Layer URL <span className="fm-label__req">*</span></label>
            <input className="fm-input" placeholder="https://sapb1…:50000/b1s/v1" value={s.serviceLayerUrl} onChange={(e) => update({ serviceLayerUrl: e.target.value })} disabled={!canEdit} />
          </div>
          <div className="fm-field">
            <label className="fm-label">Company DB <span className="fm-label__req">*</span></label>
            <input className="fm-input" placeholder="FM_LIVE" value={s.companyDb} onChange={(e) => update({ companyDb: e.target.value })} disabled={!canEdit} />
          </div>
          <div className="fm-field">
            <label className="fm-label">SAP User <span className="fm-label__req">*</span></label>
            <input className="fm-input" placeholder="manager" value={s.sapUser} onChange={(e) => update({ sapUser: e.target.value })} disabled={!canEdit} />
          </div>
          <div className="fm-field">
            <label className="fm-label">SAP Password {s.hasPassword ? '' : <span className="fm-label__req">*</span>}</label>
            <input
              type="password"
              className="fm-input"
              autoComplete="new-password"
              placeholder={s.hasPassword ? '••••••••  (để trống = giữ mật khẩu cũ)' : ''}
              value={s.sapPassword}
              onChange={(e) => update({ sapPassword: e.target.value })}
              disabled={!canEdit}
            />
          </div>
        </div>

        <label className="fm-field" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: canEdit ? 'pointer' : 'not-allowed' }}>
          <input
            type="checkbox"
            checked={s.sslSkipVerify}
            onChange={(e) => update({ sslSkipVerify: e.target.checked })}
            disabled={!canEdit}
            style={{ marginTop: 3, width: 16, height: 16, accentColor: '#C14B33' }}
          />
          <span>
            <b>Bỏ qua xác thực SSL (Skip SSL verification)</b>
          </span>
        </label>

        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="fm-btn fm-btn--primary" onClick={save} disabled={!canEdit || busy !== null}>
            <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {busy === 'save' ? 'Đang lưu…' : 'Lưu cài đặt'}
          </button>
          <button className="fm-btn fm-btn--secondary" onClick={testConn} disabled={!canEdit || busy !== null}>
            <PlugZap size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {busy === 'test' ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
          </button>
          {!canEdit && (
            <span className="fm-chip fm-chip--role" style={{ alignSelf: 'center' }}>
              Vai trò của bạn chỉ được xem cài đặt
            </span>
          )}
        </div>
      </div>

      {/* Gợi ý mặt hàng theo lịch sử đơn hàng */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={18} /> Gợi ý mặt hàng theo lịch sử mua hàng
        </h2>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-suggest-days">Khoảng thời gian lịch sử (ngày)</label>
            <input
              id="fm-suggest-days"
              type="number"
              className="fm-input"
              min={7}
              max={365}
              value={s.suggestHistoryDays ?? 90}
              onChange={(e) => update({ suggestHistoryDays: Math.min(365, Math.max(7, Number(e.target.value) || 90)) })}
              disabled={!canEdit}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-suggest-max">Số mặt hàng gợi ý tối đa</label>
            <input
              id="fm-suggest-max"
              type="number"
              className="fm-input"
              min={1}
              max={50}
              value={s.suggestMaxItems ?? 10}
              onChange={(e) => update({ suggestMaxItems: Math.min(50, Math.max(1, Number(e.target.value) || 10)) })}
              disabled={!canEdit}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="fm-btn fm-btn--primary" onClick={save} disabled={!canEdit || busy !== null}>
            <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {busy === 'save' ? 'Đang lưu…' : 'Lưu cài đặt'}
          </button>
        </div>
      </div>

      {/* Cấu hình Email (SMTP) */}
      <div className="fm-card">
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Mail size={18} /> Cấu hình Email (SMTP)
        </h2>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-smtp-host">SMTP Host</label>
            <input
              id="fm-smtp-host"
              className="fm-input"
              placeholder="smtp.gmail.com"
              value={s.smtpHost ?? ''}
              onChange={(e) => update({ smtpHost: e.target.value })}
              disabled={!canEdit}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-smtp-port">Port</label>
            <input
              id="fm-smtp-port"
              type="number"
              className="fm-input"
              min={1}
              max={65535}
              value={s.smtpPort ?? 587}
              onChange={(e) => update({ smtpPort: Math.min(65535, Math.max(1, Number(e.target.value) || 587)) })}
              disabled={!canEdit}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-smtp-user">Username</label>
            <input
              id="fm-smtp-user"
              className="fm-input"
              autoComplete="username"
              placeholder="user@example.com"
              value={s.smtpUser ?? ''}
              onChange={(e) => update({ smtpUser: e.target.value })}
              disabled={!canEdit}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-smtp-pass">Password {s.hasSmtpPass ? '' : null}</label>
            <input
              id="fm-smtp-pass"
              type="password"
              className="fm-input"
              autoComplete="new-password"
              placeholder={s.hasSmtpPass ? '••••••••  (để trống = giữ mật khẩu cũ)' : ''}
              value={s.smtpPass ?? ''}
              onChange={(e) => update({ smtpPass: e.target.value })}
              disabled={!canEdit}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-smtp-from-email">From Email</label>
            <input
              id="fm-smtp-from-email"
              type="email"
              className="fm-input"
              placeholder="sales@farmersmarket.vn"
              value={s.smtpFromEmail ?? ''}
              onChange={(e) => update({ smtpFromEmail: e.target.value })}
              disabled={!canEdit}
            />
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="fm-smtp-from-name">From Name</label>
            <input
              id="fm-smtp-from-name"
              className="fm-input"
              placeholder="Farmers Market"
              value={s.smtpFromName ?? ''}
              onChange={(e) => update({ smtpFromName: e.target.value })}
              disabled={!canEdit}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="fm-btn fm-btn--primary" onClick={save} disabled={!canEdit || busy !== null}>
            <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {busy === 'save' ? 'Đang lưu…' : 'Lưu cài đặt'}
          </button>
          {!canEdit && (
            <span className="fm-chip fm-chip--role" style={{ alignSelf: 'center' }}>
              Vai trò của bạn chỉ được xem cài đặt
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
