'use client'

import { useEffect, useState } from 'react'
import { useFocusTrap } from './use-focus-trap'
import { PlugZap, Save, Database, Sparkles, Mail, Plus, Pencil, Trash2, Star, X } from 'lucide-react'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

interface SettingsData {
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

interface SapDb {
  id: string
  label: string
  serviceLayerUrl: string
  companyDb: string
  sapUser: string
  hasPassword: boolean
  sslSkipVerify: boolean
  isDefault: boolean
  connected: boolean
  lastTestAt: string | null
}

interface DbForm {
  id: string | null // null = thêm mới
  label: string
  serviceLayerUrl: string
  companyDb: string
  sapUser: string
  sapPassword: string // rỗng khi load — chỉ có giá trị khi nhập mới
  hasPassword: boolean
  sslSkipVerify: boolean
  isDefault: boolean
}

const emptyForm: DbForm = {
  id: null, label: '', serviceLayerUrl: '', companyDb: '', sapUser: '',
  sapPassword: '', hasPassword: false, sslSkipVerify: false, isDefault: false,
}

export default function SettingsView({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState<SettingsData | null>(null)
  const [dbs, setDbs] = useState<SapDb[]>([])
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [dbBusy, setDbBusy] = useState<string | null>(null) // id DB đang test/xóa/đặt mặc định, hoặc 'new'
  const [form, setForm] = useState<DbForm | null>(null) // null = đóng modal

  // Focus trap + Escape cho modal database
  const formTrapRef = useFocusTrap<HTMLDivElement>(!!form, () => setForm(null))

  const load = async () => {
    const res = await api('/api/settings')
    if (res.status === 401) { window.location.reload(); return }
    const json = await res.json()
    // KHÔNG nạp mật khẩu đã che vào state — giữ ô mật khẩu rỗng,
    // server sẽ giữ mật khẩu cũ khi gửi chuỗi rỗng → không bao giờ ghi đè nhầm.
    setS({
      ...json.settings,
      smtpPass: '',
      hasSmtpPass: Boolean(json.hasSmtpPass),
    })
  }
  const loadDbs = async () => {
    const res = await api('/api/sap-databases')
    if (!res.ok) return
    const json = await res.json()
    setDbs(json.databases ?? [])
  }
  useEffect(() => { load(); loadDbs() }, [])

  const update = (patch: Partial<SettingsData>) => setS((cur) => (cur ? { ...cur, ...patch } : cur))
  const updateForm = (patch: Partial<DbForm>) => setForm((cur) => (cur ? { ...cur, ...patch } : cur))

  const save = async () => {
    if (!s) return
    setBusy(true)
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
      setS({ ...json.settings, smtpPass: '', hasSmtpPass: Boolean(json.settings.smtpPass) })
      setMsg({ type: 'success', text: 'Đã lưu cài đặt.' })
    } finally {
      setBusy(false)
    }
  }

  // ---------- Quản lý database ----------
  const openNew = () => setForm({ ...emptyForm, isDefault: dbs.length === 0 })
  const openEdit = (d: SapDb) => setForm({
    id: d.id, label: d.label, serviceLayerUrl: d.serviceLayerUrl, companyDb: d.companyDb,
    sapUser: d.sapUser, sapPassword: '', hasPassword: d.hasPassword,
    sslSkipVerify: d.sslSkipVerify, isDefault: d.isDefault,
  })

  const saveDb = async () => {
    if (!form) return
    if (!form.label.trim()) { setMsg({ type: 'error', text: 'Vui lòng nhập tên database' }); return }
    if (!/^https?:\/\/.+/i.test(form.serviceLayerUrl.trim())) { setMsg({ type: 'error', text: 'URL Service Layer không hợp lệ' }); return }
    if (!form.companyDb.trim()) { setMsg({ type: 'error', text: 'Vui lòng nhập CompanyDB' }); return }
    if (!form.sapUser.trim()) { setMsg({ type: 'error', text: 'Vui lòng nhập tài khoản SAP' }); return }
    if (!form.id && !form.sapPassword) { setMsg({ type: 'error', text: 'Vui lòng nhập mật khẩu SAP' }); return }
    setDbBusy('new')
    setMsg(null)
    try {
      const url = form.id ? `/api/sap-databases/${form.id}` : '/api/sap-databases'
      const res = await api(url, {
        method: form.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: form.label.trim(),
          serviceLayerUrl: form.serviceLayerUrl.trim(),
          companyDb: form.companyDb.trim(),
          sapUser: form.sapUser.trim(),
          sapPassword: form.sapPassword, // rỗng = giữ mật khẩu cũ (khi sửa)
          sslSkipVerify: form.sslSkipVerify,
          isDefault: form.isDefault,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không thể lưu database' })
        return
      }
      setForm(null)
      await loadDbs()
      setMsg({ type: 'success', text: form.id ? 'Đã cập nhật database.' : 'Đã thêm database mới.' })
    } finally {
      setDbBusy(null)
    }
  }

  const testDb = async (d: SapDb) => {
    setDbBusy(d.id)
    setMsg(null)
    try {
      const res = await api(`/api/sap-databases/${d.id}/test`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Kiểm tra kết nối thất bại' })
      } else {
        setMsg({ type: 'success', text: json.message ?? 'Kết nối thành công' })
      }
      await loadDbs()
    } finally {
      setDbBusy(null)
    }
  }

  const setDefault = async (d: SapDb) => {
    setDbBusy(d.id)
    try {
      const res = await api(`/api/sap-databases/${d.id}/set-default`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) setMsg({ type: 'error', text: json.error ?? 'Không thể đặt mặc định' })
      else setMsg({ type: 'success', text: `Đã đặt “${d.label}” làm database mặc định.` })
      await loadDbs()
    } finally {
      setDbBusy(null)
    }
  }

  const deleteDb = async (d: SapDb) => {
    if (!window.confirm(`Xóa database “${d.label}” (${d.companyDb})?\nDữ liệu đã đồng bộ của database này sẽ được giữ lại.`)) return
    setDbBusy(d.id)
    setMsg(null)
    try {
      const res = await api(`/api/sap-databases/${d.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không thể xóa database' })
        return
      }
      await loadDbs()
      setMsg({ type: 'success', text: 'Đã xóa database.' })
    } finally {
      setDbBusy(null)
    }
  }

  if (!s) return <div className="fm-card"><div className="fm-empty">Đang tải cấu hình…</div></div>

  return (
    <div>
      <PageHeader
        breadcrumb={['Quản trị & Hệ thống', 'Cài đặt SAP B1']}
        title="Cài đặt kết nối SAP Business One"
/>

      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : msg.type === 'error' ? 'fm-alert--error' : 'fm-alert--info'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : msg.type === 'error' ? 'Lỗi' : 'Thông tin'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      {/* Quản lý database SAP B1 */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Database size={18} /> Database SAP B1 — Service Layer (OData v2)
          <span style={{ marginLeft: 'auto' }}>
            {canEdit && (
              <button className="fm-btn fm-btn--primary fm-btn--sm" onClick={openNew} disabled={dbBusy !== null}>
                <Plus size={14} style={{ verticalAlign: -2, marginRight: 4 }} /> Thêm database
              </button>
            )}
          </span>
        </h2>
        <p style={{ fontSize: 13, color: 'var(--fm-text-2)', margin: '0 0 12px' }}>
          Khai báo các CompanyDB kết nối qua Service Layer. Khi đăng nhập, người dùng chọn 1 database —
          mọi thao tác SAP (đẩy đơn, đồng bộ, tra cứu) dùng đúng database đã chọn.
        </p>

        {dbs.length === 0 ? (
          <div className="fm-empty">Chưa khai báo database nào. {canEdit ? 'Bấm “Thêm database” để bắt đầu.' : 'Liên hệ quản trị viên.'}</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {dbs.map((d) => (
              <div key={d.id} className="fm-card" style={{ padding: 12, margin: 0, border: d.isDefault ? '1.5px solid var(--fm-accent)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 14 }}>{d.label}</b>
                  {d.isDefault && <span className="fm-chip fm-chip--role"><Star size={12} style={{ verticalAlign: -1, marginRight: 3 }} />Mặc định</span>}
                  <span
                    className="fm-chip"
                    style={d.connected ? { background: 'var(--fm-green-soft)', color: 'var(--fm-green)' } : undefined}
                    title={d.lastTestAt ? `Test gần nhất: ${new Date(d.lastTestAt).toLocaleString('vi-VN')}` : 'Chưa test'}
                  >
                    <span className="dot" style={{ background: d.connected ? 'var(--fm-green)' : '#B0B0B0' }} />
                    {d.connected ? 'Đã kết nối' : 'Chưa test'}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {canEdit && (
                      <>
                        <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => testDb(d)} disabled={dbBusy !== null} title="Kiểm tra kết nối Service Layer">
                          <PlugZap size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                          {dbBusy === d.id ? 'Đang kiểm tra…' : 'Kiểm tra'}
                        </button>
                        <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => openEdit(d)} disabled={dbBusy !== null} aria-label={`Sửa ${d.label}`}>
                          <Pencil size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Sửa
                        </button>
                        {!d.isDefault && (
                          <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => setDefault(d)} disabled={dbBusy !== null}>
                            <Star size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Đặt mặc định
                          </button>
                        )}
                        <button className="fm-btn fm-btn--ghost fm-btn--sm fm-btn--danger" onClick={() => deleteDb(d)} disabled={dbBusy !== null} aria-label={`Xóa ${d.label}`}>
                          <Trash2 size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Xóa
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--fm-text-2)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <span><b>URL:</b> {d.serviceLayerUrl || '—'}</span>
                  <span><b>CompanyDB:</b> {d.companyDb || '—'}</span>
                  <span><b>User:</b> {d.sapUser || '—'}</span>
                  {d.sslSkipVerify && <span className="fm-chip">Bỏ qua SSL</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {!canEdit && (
          <span className="fm-chip fm-chip--role" style={{ marginTop: 10 }}>
            Vai trò của bạn chỉ được xem cài đặt
          </span>
        )}
      </div>

      {/* Modal thêm/sửa database */}
      {form && (
        <div className="fm-backdrop" onClick={() => setForm(null)}>
          <div ref={formTrapRef} className="fm-modal" role="dialog" aria-modal="true" aria-label={form.id ? 'Sửa database' : 'Thêm database'} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 className="fm-modal__title">{form.id ? 'Sửa database' : 'Thêm database SAP B1'}</h3>
              <button className="fm-icon-btn" aria-label="Đóng" onClick={() => setForm(null)}><X size={16} /></button>
            </div>
            <div className="fm-form-grid" style={{ padding: '4px 0 12px' }}>
              <div className="fm-field">
                <label className="fm-label" htmlFor="db-label">Tên hiển thị <span className="fm-label__req">*</span></label>
                <input id="db-label" className="fm-input" placeholder="Kho HCM — LIVE" value={form.label} onChange={(e) => updateForm({ label: e.target.value })} />
              </div>
              <div className="fm-field">
                <label className="fm-label" htmlFor="db-url">Service Layer URL <span className="fm-label__req">*</span></label>
                <input id="db-url" className="fm-input" placeholder="https://sapb1…:50000/b1s/v1" value={form.serviceLayerUrl} onChange={(e) => updateForm({ serviceLayerUrl: e.target.value })} />
              </div>
              <div className="fm-field">
                <label className="fm-label" htmlFor="db-companydb">Company DB <span className="fm-label__req">*</span></label>
                <input id="db-companydb" className="fm-input" placeholder="FM_LIVE" value={form.companyDb} onChange={(e) => updateForm({ companyDb: e.target.value })} />
              </div>
              <div className="fm-field">
                <label className="fm-label" htmlFor="db-user">SAP User <span className="fm-label__req">*</span></label>
                <input id="db-user" className="fm-input" placeholder="manager" value={form.sapUser} onChange={(e) => updateForm({ sapUser: e.target.value })} />
              </div>
              <div className="fm-field">
                <label className="fm-label" htmlFor="db-pass">SAP Password {form.hasPassword || form.id ? '' : <span className="fm-label__req">*</span>}</label>
                <input
                  id="db-pass"
                  type="password"
                  className="fm-input"
                  autoComplete="new-password"
                  placeholder={form.hasPassword ? '••••••••  (để trống = giữ mật khẩu cũ)' : ''}
                  value={form.sapPassword}
                  onChange={(e) => updateForm({ sapPassword: e.target.value })}
                />
              </div>
              <div className="fm-field" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input id="db-ssl" type="checkbox" checked={form.sslSkipVerify} onChange={(e) => updateForm({ sslSkipVerify: e.target.checked })} style={{ width: 16, height: 16, accentColor: 'var(--fm-primary)' }} />
                <label className="fm-label" htmlFor="db-ssl" style={{ margin: 0 }}>Bỏ qua xác thực SSL</label>
              </div>
            </div>
            <label className="fm-field" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 12 }}>
              <input id="db-default" type="checkbox" checked={form.isDefault} onChange={(e) => updateForm({ isDefault: e.target.checked })} style={{ width: 16, height: 16, accentColor: 'var(--fm-primary)' }} />
              <label className="fm-label" htmlFor="db-default" style={{ margin: 0 }}>Đặt làm database mặc định</label>
            </label>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--ghost" onClick={() => setForm(null)}>Hủy</button>
              <button className="fm-btn fm-btn--primary" onClick={saveDb} disabled={dbBusy !== null}>
                <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
                {dbBusy === 'new' ? 'Đang lưu…' : form.id ? 'Cập nhật' : 'Thêm database'}
              </button>
            </div>
          </div>
        </div>
      )}

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
          <button className="fm-btn fm-btn--primary" onClick={save} disabled={!canEdit || busy}>
            <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {busy ? 'Đang lưu…' : 'Lưu cài đặt'}
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
          <button className="fm-btn fm-btn--primary" onClick={save} disabled={!canEdit || busy}>
            <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
            {busy ? 'Đang lưu…' : 'Lưu cài đặt'}
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
