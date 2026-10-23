'use client'

import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { Save, ShieldCheck, UsersRound, ArrowRight } from 'lucide-react'
import { MODULE_LABELS, ACTION_LABELS, parsePerm, ActionKey, ModuleKey, SessionUser } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import PageHeader from './page-header'

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

const MODULE_KEYS: ModuleKey[] = ['orders', 'ordersNew', 'deliveries', 'quotations', 'invoices', 'creditMemos', 'returns', 'downPayments', 'salesReport', 'arAgingReport', 'users', 'settings', 'roles', 'excelTemplates', 'orderTemplates', 'bomImport']
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

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

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

  // Reset draft quyền về trạng thái đã lưu — hàm thuần, gọi được từ
  // event handler (nút "Hủy thay đổi") lẫn effect khởi tạo bên dưới.
  const resetDraft = (roleId: string | null, roleList: typeof roles) => {
    const role = roleId ? roleList.find((r) => r.id === roleId) : undefined
    setPermDraft(role ? parsePerm(role.permissions) : null)
    setDirty(false)
  }

  // Đồng bộ draft quyền theo role được chọn — là EVENT khởi tạo (không phải
  // effect phản ứng), bọc bằng useEffectEvent để rõ ý định và tránh render
  // dây chuyền khi roles ref đổi sau mỗi lần lưu.
  const syncDraft = useEffectEvent((roleId: string | null, roleList: typeof roles) => {
    resetDraft(roleId, roleList)
  })

  useEffect(() => {
    syncDraft(selectedId, roles)
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

  /** Hiện cảnh báo tự khóa (thay window.confirm) trước khi lưu ma trận quyền */
  const askSave = () => {
    if (!selectedId || !permDraft) return
    // Cảnh báo tự khóa: sửa vai trò Admin mà tắt quyền xem/sửa phân quyền hoặc quản lý người dùng
    const selected = roles.find((r) => r.id === selectedId)
    const selfLock =
      selected?.name === 'Admin' && user.role === 'Admin' &&
      (!permDraft.roles.view || !permDraft.roles.edit || !permDraft.users.view)
    if (selfLock) {
      setConfirmCfg({
        title: 'Cảnh báo: tự khóa quyền của chính bạn',
        message: 'Bạn đang tắt quyền "Ủy quyền" hoặc "Người dùng" của vai trò Admin — vai trò của chính bạn.\n\nSau khi lưu, bạn có thể mất khả năng truy cập lại các trang này. Tiếp tục lưu?',
        confirmLabel: 'Tiếp tục lưu',
        tone: 'danger',
        run: () => { void doSave() },
      })
      return
    }
    void doSave()
  }

  const doSave = async () => {
    if (!selectedId || !permDraft) return

    setConfirmCfg(null) // đóng dialog trước khi lưu (pattern như các view khác)
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
      <PageHeader
        breadcrumb={['Quản trị & Hệ thống', 'Quản lý ủy quyền']}
        title="Ủy quyền vai trò"
actions={<>
          <span className="fm-hint">Bấm vào vai trò để xem và chỉnh ma trận quyền</span>
        </>}
      />
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : 'Lỗi'}</b>{' '}{msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm fm-ml-auto" aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-roles-grid">
        {/* Danh sách vai trò */}
        <div className="fm-card fm-roles-grid__aside">
          <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={18} /> Vai trò
          </h2>
          <div role="radiogroup" aria-label="Danh sách vai trò">
          {roles.map((r) => {
            const n = users.filter((u) => u.role === r.name).length
            const mods = parsePerm(r.permissions)
            const onCount = MODULE_KEYS.filter((mod) => mods[mod].view).length
            return (
              <div
                key={r.id}
                role="radio"
                tabIndex={0}
                aria-checked={r.id === selectedId}
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
                  padding: '10px 12px', borderRadius: 'var(--fm-r-md)', marginBottom: 4, fontSize: 12.5,
                  background: r.id === selectedId ? 'var(--fm-gold-faint)' : 'transparent',
                  borderLeft: r.id === selectedId ? '3px solid var(--fm-gold)' : '3px solid transparent',
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
          </div>

          {selected && roleUsers.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--fm-line)', paddingTop: 12 }}>
              <div className="fm-stat__label">Người dùng thuộc vai trò</div>
              {roleUsers.map((u) => (
                <div key={u.username} style={{ fontSize: 12.5, padding: '4px 0', color: 'var(--fm-text-2)' }}>
                  <b style={{ color: 'var(--fm-text)' }}>{u.fullName}</b> · @{u.username}
                </div>
              ))}
              {canGoUsers && (
                <button className="fm-btn fm-btn--secondary fm-btn--sm fm-mt-3 fm-btn--block" onClick={onGoUsers}>
                  <UsersRound size={14} />
                  Quản lý người dùng
                  <ArrowRight size={14} style={{ marginLeft: 'auto' }} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Ma trận quyền */}
        <div className="fm-card fm-roles-grid__main">
          <h2 className="fm-card__title">Ma trận quyền {selected ? `— ${selected.label}` : ''}</h2>

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
                                <input type="checkbox" checked={permDraft[mod][act]} onChange={() => toggle(mod, act)} disabled={!canEdit} aria-label={`${ACTION_LABELS[act]} — ${MODULE_LABELS[mod]}`} />
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
                <button className="fm-btn fm-btn--primary" onClick={askSave} disabled={!canEdit || saving || !dirty}>
                  <Save size={16} />
                  {saving ? 'Đang lưu…' : 'Lưu ủy quyền'}
                </button>
                {dirty && canEdit && (
                  <button className="fm-btn fm-btn--ghost" onClick={() => resetDraft(selectedId, roles)} disabled={saving}>
                    Hủy thay đổi
                  </button>
                )}
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
            <div aria-busy="true">
              <div className="fm-skeleton fm-skeleton--text" style={{ width: '50%', marginBottom: 10 }} />
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="fm-skeleton fm-skeleton--row" />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Dialog xác nhận chung thay window.confirm() */}
      {confirmCfg && (
        <ConfirmDialog
          open
          title={confirmCfg.title}
          message={confirmCfg.message}
          confirmLabel={confirmCfg.confirmLabel}
          tone={confirmCfg.tone}
          onConfirm={confirmCfg.run}
          onCancel={() => setConfirmCfg(null)}
        />
      )}
    </div>
  )
}
