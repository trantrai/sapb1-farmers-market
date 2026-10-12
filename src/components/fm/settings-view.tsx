'use client'

import { useEffect, useState } from 'react'
import { PlugZap, Save, Link2 } from 'lucide-react'
import { api } from '@/lib/fm-client'

interface SettingsData {
  serviceLayerUrl: string
  companyDb: string
  sapUser: string
  sapPassword: string // luôn rỗng khi load — chỉ có giá trị khi user nhập mới
  hasPassword: boolean // đã có mật khẩu lưu trên server chưa
  sslSkipVerify: boolean
  connected: boolean
  lastSyncAt: string | null
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
    setS({ ...json.settings, sapPassword: '', hasPassword: Boolean(json.hasPassword) })
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
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link2 size={18} /> Kết nối SAP Business One — Service Layer (OData v2)
        </h2>
        <p className="fm-card__desc">
          Cấu hình dùng chung cho toàn hệ thống. Sale Order tạo mới sẽ đẩy sang SAP B1 qua endpoint này.
        </p>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label">Service Layer URL <span className="fm-label__req">*</span></label>
            <input className="fm-input" placeholder="https://sapb1…:50000/b1s/v1" value={s.serviceLayerUrl} onChange={(e) => update({ serviceLayerUrl: e.target.value })} disabled={!canEdit} />
            <div className="fm-hint">Địa chỉ gốc của B1 Service Layer, kết thúc bằng /b1s/v1</div>
          </div>
          <div className="fm-field">
            <label className="fm-label">Company DB <span className="fm-label__req">*</span></label>
            <input className="fm-input" placeholder="FM_LIVE" value={s.companyDb} onChange={(e) => update({ companyDb: e.target.value })} disabled={!canEdit} />
            <div className="fm-hint">Tên CSDL công ty trong SAP B1</div>
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
            <div className="fm-hint">Được lưu trên máy chủ, không hiển thị lại. Bỏ trống nếu không muốn đổi.</div>
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
            <span className="fm-hint" style={{ display: 'block' }}>
              Bật khi Service Layer dùng HTTPS với chứng chỉ tự ký (self-signed) — lỗi thường gặp:
              <i> unable to verify the first certificate / self-signed certificate in chain</i>.
              Chỉ nên bật cho máy chủ nội bộ, không khuyến nghị cho môi trường sản xuất có chứng chỉ công khai hợp lệ.
            </span>
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
    </div>
  )
}
