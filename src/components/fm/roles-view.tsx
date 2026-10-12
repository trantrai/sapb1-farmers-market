'use client'

import { useCallback, useEffect, useState } from 'react'
import { Save, ShieldCheck, UsersRound, ArrowRight } from 'lucide-react'
import { MODULE_LABELS, ACTION_LABELS, parsePerm, ActionKey, ModuleKey, SessionUser } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'

interface RoleRow {
  id: string
  name: string
  label: string
  permissions: string
  builtin: boolean
}
interface UserRow {
  username: string
  fullName: string
  role: string
}

const MODULE_KEYS: ModuleKey[] = ['orders', 'ordersNew', 'users', 'settings', 'roles']
const ACTIONS: ActionKey[] = ['view', 'create', 'edit', 'delete']

interface Props {
  user: SessionUser
  onGoUsers: () => void
}

export default function RolesView({ user, onGoUsers }: Props) {
  const canEdit = Boolean(user.permissions.roles?.edit)
  const canGoUsers = Boolean(user.permissions.users?.view)

  const [roles, setRoles] = useState<RoleRow[]>([])
  const [users, setUsers] = useState<UserRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [permDraft, setPermDraft] = useState<ReturnType<typeof parsePerm> | null>(null)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    const res = await api('/api/roles')
    if (res.status === 401) { window.location.reload(); return }
    const json = await res.json()
    setRoles(json.data ?? [])
    setUsers(json.users ?? [])
    setSelectedId((cur) => cur ?? json.data?.[0]?.id ?? null)
  }, [])

  useEffect(() => { load() }, [load])

  // Cảnh báo khi rời trang mà còn thay đổi chưa lưu
  useEffect(() => {
    if (!dirty) return
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [dirty])

  useEffect(() => {
    const role = roles.find((r) => r.id === selectedId)
    setPermDraft(role ? parsePerm(role.permissions) : null)
    setDirty(false)
  }, [selectedId, roles])

  const toggle = (mod: ModuleKey, act: ActionKey) => {
    setPermDraft((p) => (p ? { ...p, [mod]: { ...p[mod], [act]: !p[mod][act] } } : p))
    setDirty(true)
  }
  const toggleModule = (mod: ModuleKey, on: boolean) => {
    setPermDraft((p) =>
      p ? { ...p, [mod]: { view: on, create: on, edit: on, delete: on } } : p,
    )
    setDirty(true)
  }

  const save = async () => {
    if (!selectedId || !permDraft) return

    // Cảnh báo tự khóa: sửa vai trò Admin mà tắt quyền xem/sửa phân quyền hoặc quản lý người dùng
    const selected = roles.find((r) => r.id === selectedId)
    const selfLock =
      selected?.name === 'Admin' && user.role === 'Admin' &&
      (!permDraft.roles.view || !permDraft.roles.edit || !permDraft.users.view)
    if (selfLock && !window.confirm(
      'CẢNH BÁO: Bạn đang tắt quyền "Phân quyền" hoặc "Người dùng" của vai trò Admin — vai trò của chính bạn. ' +
      'Sau khi lưu, bạn có thể mất khả năng truy cập lại các trang này.\n\nTiếp tục lưu?',
    )) return

    setSaving(true)
    setMsg(null)
    try {
      const res = await api('/api/roles', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedId, permissions: JSON.stringify(permDraft) }),
      })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không thể lưu phân quyền' })
        return
      }
      setMsg({ type: 'success', text: `Đã cập nhật ma trận quyền cho vai trò “${json.role.label}”. Người dùng thuộc vai trò này sẽ thấy thay đổi ngay lần truy cập tới.` })
      setDirty(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const selected = roles.find((r) => r.id === selectedId)
  const roleUsers = users.filter((u) => u.role === selected?.name)
  const enabledModules = permDraft
    ? MODULE_KEYS.filter((mod) => permDraft[mod].view).length
    : 0

  return (
    <div>
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : 'Lỗi'}</b>{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-roles-grid">
        {/* Danh sách vai trò */}
        <div className="fm-card fm-roles-grid__aside">
          <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={18} /> Vai trò
          </h2>
          <p className="fm-card__desc">Chọn vai trò để chỉnh ma trận quyền.</p>
          {roles.map((r) => {
            const n = users.filter((u) => u.role === r.name).length
            const mods = parsePerm(r.permissions)
            const onCount = MODULE_KEYS.filter((mod) => mods[mod].view).length
            return (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                aria-pressed={r.id === selectedId}
                aria-label={`Chọn vai trò ${r.label}`}
                onClick={() => setSelectedId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedId(r.id)
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                  padding: '10px 12px', borderRadius: 'var(--fm-r-md)', marginBottom: 4, fontSize: 13,
                  background: r.id === selectedId ? 'var(--fm-yellow-faint)' : 'transparent',
                  borderLeft: r.id === selectedId ? '3px solid var(--fm-yellow)' : '3px solid transparent',
                  fontWeight: r.id === selectedId ? 700 : 500,
                  color: r.id === selectedId ? 'var(--fm-navy)' : 'var(--fm-text)',
                }}
              >
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 5, alignItems: 'center', flexShrink: 0 }}>
                  <span className="fm-hint" style={{ margin: 0 }} title="Số module được phép xem">{onCount}/{MODULE_KEYS.length} module</span>
                  <span className="fm-chip fm-chip--role">{n} ND</span>
                </span>
              </div>
            )
          })}

          {selected && roleUsers.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--fm-line)', paddingTop: 12 }}>
              <div className="fm-stat__label">Người dùng thuộc vai trò</div>
              {roleUsers.map((u) => (
                <div key={u.username} style={{ fontSize: 12.5, padding: '4px 0', color: 'var(--fm-text-2)' }}>
                  <b style={{ color: 'var(--fm-text)' }}>{u.fullName}</b> · @{u.username}
                </div>
              ))}
              {canGoUsers && (
                <button className="fm-btn fm-btn--secondary fm-btn--sm" style={{ marginTop: 10, width: '100%' }} onClick={onGoUsers}>
                  <UsersRound size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                  Quản lý người dùng
                  <ArrowRight size={12} style={{ marginLeft: 'auto' }} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Ma trận quyền */}
        <div className="fm-card fm-roles-grid__main">
          <h2 className="fm-card__title">Ma trận quyền {selected ? `— ${selected.label}` : ''}</h2>
          <p className="fm-card__desc">
            Quyết định module nào hiển thị trên menu và thao tác nào được phép. Thay đổi áp dụng cho mọi người dùng của vai trò.
          </p>

          {permDraft && selected ? (
            <>
              <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
                <table className="fm-table fm-perm-matrix fm-stack-table">
                  <thead>
                    <tr>
                      <th>Module chức năng</th>
                      {ACTIONS.map((a) => <th key={a}>{ACTION_LABELS[a]}</th>)}
                      <th>Bật hết</th>
                    </tr>
                  </thead>
                  <tbody>
                    {MODULE_KEYS.map((mod) => {
                      const allOn = ACTIONS.every((a) => permDraft[mod][a])
                      return (
                        <tr key={mod} data-mod={mod}>
                          <td data-label="Module"><b>{MODULE_LABELS[mod]}</b></td>
                          {ACTIONS.map((act) => (
                            <td key={act} data-label={ACTION_LABELS[act]}>
                              <label className="fm-switch" title={`${ACTION_LABELS[act]} — ${MODULE_LABELS[mod]}`}>
                                <input type="checkbox" checked={permDraft[mod][act]} onChange={() => toggle(mod, act)} disabled={!canEdit} />
                                <span className="track" />
                              </label>
                            </td>
                          ))}
                          <td data-label="Bật hết">
                            <button
                              className={`fm-btn fm-btn--sm ${allOn ? 'fm-btn--ghost' : 'fm-btn--secondary'}`}
                              onClick={() => toggleModule(mod, !allOn)}
                              disabled={!canEdit}
                            >
                              {allOn ? 'Bỏ hết' : 'Bật hết'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="fm-btn fm-btn--primary" onClick={save} disabled={!canEdit || saving}>
                  <Save size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
                  {saving ? 'Đang lưu…' : 'Lưu phân quyền'}
                </button>
                {dirty && !saving && <span className="fm-chip fm-chip--open">Có thay đổi chưa lưu</span>}
                {!canEdit && (
                  <span className="fm-chip fm-chip--perm-d">Bạn không có quyền sửa phân quyền</span>
                )}
                <span className="fm-hint" style={{ marginLeft: 'auto' }}>
                  {enabledModules}/{MODULE_KEYS.length} module đang mở · vai trò {selected.builtin ? 'có sẵn' : 'tự tạo'} · mã: {selected.name}
                </span>
              </div>
            </>
          ) : (
            <div className="fm-empty">Đang tải ma trận quyền…</div>
          )}
        </div>
      </div>
    </div>
  )
}
