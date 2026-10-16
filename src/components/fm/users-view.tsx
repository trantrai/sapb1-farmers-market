'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { UsersRound, UserPlus, Pencil, Trash2, Search, Inbox, ShieldCheck, KeyRound, X } from 'lucide-react'
import type { SessionUser } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import { useFocusTrap } from './use-focus-trap'

interface UserRow {
  id: string
  username: string
  fullName: string
  role: string
  active: boolean
  createdAt: string
  updatedAt: string
}
interface RoleOpt {
  name: string
  label: string
}

interface Props {
  user: SessionUser
}

type ModalState =
  | { mode: 'create' }
  | { mode: 'edit'; u: UserRow }
  | null

export default function UsersView({ user }: Props) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [roles, setRoles] = useState<RoleOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [busy, setBusy] = useState(false)

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

  const canCreate = Boolean(user.permissions.users?.create)
  const canEdit = Boolean(user.permissions.users?.edit)
  const canDelete = Boolean(user.permissions.users?.delete)

  const roleLabel = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of roles) map.set(r.name, r.label)
    return (name: string) => map.get(name) ?? name
  }, [roles])

  const load = useCallback(async () => {
    try {
      const res = await api('/api/users')
      if (res.status === 401) { window.location.reload(); return }
      const json = await res.json()
      if (!res.ok) {
        setAlert({ type: 'error', msg: json.error ?? 'Không thể tải danh sách người dùng' })
        setUsers([])
        return
      }
      setUsers(json.data ?? [])
      setRoles(json.roles ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return users
    return users.filter((u) =>
      u.username.toLowerCase().includes(kw) ||
      u.fullName.toLowerCase().includes(kw) ||
      u.role.toLowerCase().includes(kw) ||
      roleLabel(u.role).toLowerCase().includes(kw),
    )
  }, [users, q, roleLabel])

  const nActive = users.filter((u) => u.active).length
  const nLocked = users.length - nActive

  const askToggleActive = (u: UserRow) => {
    // Vô hiệu hóa tài khoản đang hoạt động cần xác nhận — tránh khóa nhầm người đang làm việc
    if (!u.active) { void toggleActive(u); return }
    setConfirmCfg({
      title: 'Vô hiệu hóa tài khoản',
      message: `Vô hiệu hóa tài khoản @${u.username} — ${u.fullName}? Người dùng này sẽ không thể đăng nhập.`,
      confirmLabel: 'Vô hiệu hóa',
      tone: 'warning',
      run: () => { void toggleActive(u) },
    })
  }

  const toggleActive = async (u: UserRow) => {
    setConfirmCfg(null)
    const res = await api(`/api/users/${u.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !u.active }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setAlert({ type: 'error', msg: json.error ?? 'Không thể cập nhật trạng thái' })
      return
    }
    setAlert({
      type: 'success',
      msg: json.user.active
        ? `Đã kích hoạt lại tài khoản @${u.username}`
        : `Đã vô hiệu hóa tài khoản @${u.username} — người dùng này không thể đăng nhập`,
    })
    load()
  }

  const askRemoveUser = (u: UserRow) => {
    setConfirmCfg({
      title: 'Xóa người dùng',
      message: `Xóa người dùng @${u.username} — ${u.fullName}? Hành động không thể hoàn tác.`,
      confirmLabel: 'Xóa',
      tone: 'danger',
      run: () => { void removeUser(u) },
    })
  }

  const removeUser = async (u: UserRow) => {
    setConfirmCfg(null)
    const res = await api(`/api/users/${u.id}`, { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setAlert({ type: 'error', msg: json.error ?? 'Không thể xóa người dùng' })
      return
    }
    setAlert({ type: 'success', msg: `Đã xóa người dùng @${u.username}` })
    load()
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Quản trị & Hệ thống', 'Quản lý người dùng']}
        title="Quản lý người dùng"
actions={<>
          {canCreate && (
            <button className="fm-btn fm-btn--primary" onClick={() => setModal({ mode: 'create' })}><UserPlus size={14} /> Thêm người dùng mới</button>
          )}
        </>}
      />
      {alert && (
        <div className={`fm-alert ${alert.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={alert.type === 'error' ? 'alert' : 'status'}>
          <div><b>{alert.type === 'success' ? 'Thành công' : 'Lỗi'}</b>{' '}{alert.msg}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      {/* Thống kê nhanh */}
      <div className="fm-stats">
        <div className="fm-stat">
          <div className="fm-stat__icon"><UsersRound size={18} /></div>
          <div className="fm-stat__label">Tổng người dùng</div>
          <div className="fm-stat__value">{users.length}</div>
          <div className="fm-stat__meta">Tài khoản truy cập hệ thống</div>
        </div>
        <div className="fm-stat fm-stat--green">
          <div className="fm-stat__icon" style={{ background: 'var(--fm-green-soft)', color: 'var(--fm-green)' }}><ShieldCheck size={18} /></div>
          <div className="fm-stat__label">Đang hoạt động</div>
          <div className="fm-stat__value">{nActive}</div>
          <div className="fm-stat__meta">Được phép đăng nhập</div>
        </div>
        <div className="fm-stat fm-stat--red">
          <div className="fm-stat__icon" style={{ background: 'var(--fm-red-soft)', color: 'var(--fm-red)' }}><KeyRound size={18} /></div>
          <div className="fm-stat__label">Bị vô hiệu hóa</div>
          <div className="fm-stat__value">{nLocked}</div>
          <div className="fm-stat__meta">Không thể đăng nhập</div>
        </div>
      </div>

      <div className="fm-card">
        <div className="fm-filterbar">
          <div style={{ position: 'relative', flex: '1 1 240px' }} data-search>
            <input
              className="fm-input"
              style={{ paddingLeft: 32 }}
              placeholder="Tìm tên đăng nhập, họ tên, vai trò…"
              aria-label="Tìm kiếm người dùng theo tên đăng nhập, họ tên hoặc vai trò"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} />
          </div>
          <div className="fm-filterbar__spacer" />
          <span className="fm-chip fm-chip--role">{filtered.length} kết quả</span>
        </div>

        {loading ? (
          <div aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="fm-skeleton fm-skeleton--row" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="fm-empty">
            <Inbox />
            {users.length === 0 ? 'Chưa có người dùng nào' : 'Không có người dùng phù hợp bộ lọc'}
          </div>
        ) : (
          <>
            {/* Bảng (desktop) */}
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Tên đăng nhập</th>
                    <th>Họ và tên</th>
                    <th>Vai trò</th>
                    <th>Trạng thái</th>
                    <th>Ngày tạo</th>
                    <th style={{ width: 90 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => {
                    const isMe = u.username === user.username
                    return (
                      <tr key={u.id} className={u.active ? '' : 'is-inactive'}>
                        <th scope="row">
                          <b>@{u.username}</b>{' '}
                          {isMe && <span className="fm-chip fm-chip--perm-c" title="Tài khoản đang đăng nhập">bạn</span>}
                        </th>
                        <td>{u.fullName}</td>
                        <td><span className="fm-chip fm-chip--role">{roleLabel(u.role)}</span></td>
                        <td>
                          <label
                            className="fm-switch"
                            title={
                              isMe ? 'Không thể tự vô hiệu hóa tài khoản đang đăng nhập'
                                : u.active ? 'Bấm để vô hiệu hóa' : 'Bấm để kích hoạt lại'
                            }
                          >
                            <input
                              type="checkbox"
                              checked={u.active}
                              disabled={!canEdit || isMe}
                              onChange={() => askToggleActive(u)}
                              aria-label={u.active ? `Vô hiệu hóa tài khoản ${u.username}` : `Kích hoạt tài khoản ${u.username}`}
                            />
                            <span className="track" />
                          </label>{' '}
                          <span style={{ fontSize: 11, color: u.active ? 'var(--fm-green)' : 'var(--fm-red)', fontWeight: 600 }}>
                            {u.active ? 'Hoạt động' : 'Vô hiệu'}
                          </span>
                        </td>
                        <td>{new Date(u.createdAt).toLocaleDateString('vi-VN')}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                            {canEdit && (
                              <button className="fm-row-del fm-row-edit" title="Sửa người dùng" aria-label={`Sửa người dùng @${u.username}`} onClick={() => setModal({ mode: 'edit', u })}>
                                <Pencil size={14} />
                              </button>
                            )}
                            {canDelete && !isMe && (
                              <button className="fm-row-del" title="Xóa người dùng" aria-label={`Xóa người dùng @${u.username}`} onClick={() => askRemoveUser(u)}>
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Danh sách card (mobile) */}
            <div className="fm-only-mobile">
              {filtered.map((u) => {
                const isMe = u.username === user.username
                return (
                  <div key={u.id} className={`fm-ucard${u.active ? '' : ' fm-ucard--off'}`}>
                    <div className="fm-ucard__head">
                      <div style={{ minWidth: 0 }}>
                        <b>{u.fullName}</b>
                        <div className="fm-ucard__meta">@{u.username}{isMe ? ' · bạn' : ''}</div>
                      </div>
                      <span className="fm-chip fm-chip--role">{roleLabel(u.role)}</span>
                    </div>
                    <div className="fm-ucard__foot">
                      <label className="fm-switch" title={u.active ? 'Vô hiệu hóa' : 'Kích hoạt lại'}>
                        <input type="checkbox" checked={u.active} disabled={!canEdit || isMe} onChange={() => askToggleActive(u)} aria-label={u.active ? `Vô hiệu hóa tài khoản ${u.username}` : `Kích hoạt tài khoản ${u.username}`} />
                        <span className="track" />
                      </label>
                      <span style={{ fontSize: 12, fontWeight: 600, color: u.active ? 'var(--fm-green)' : 'var(--fm-red)' }}>
                        {u.active ? 'Hoạt động' : 'Vô hiệu'}
                      </span>
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                        {canEdit && (
                          <button className="fm-row-del fm-row-edit" title="Sửa người dùng" aria-label={`Sửa người dùng @${u.username}`} onClick={() => setModal({ mode: 'edit', u })}>
                            <Pencil size={16} />
                          </button>
                        )}
                        {canDelete && !isMe && (
                          <button className="fm-row-del" title="Xóa người dùng" aria-label={`Xóa người dùng @${u.username}`} onClick={() => askRemoveUser(u)}>
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* Modal thêm / sửa */}
      {modal && (
        <UserModal
          mode={modal.mode}
          initial={modal.mode === 'edit' ? modal.u : null}
          roles={roles}
          isSelf={modal.mode === 'edit' ? modal.u.username === user.username : false}
          operatorRole={user.role}
          busy={busy}
          onClose={() => setModal(null)}
          onSaved={(msg) => {
            setModal(null)
            setAlert({ type: 'success', msg })
            load()
          }}
          setBusy={setBusy}
        />
      )}

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

/* ================= Modal thêm / sửa người dùng ================= */

function UserModal({  mode,
  initial,
  roles,
  isSelf,
  operatorRole,
  busy,
  onClose,
  onSaved,
  setBusy,
}: {
  mode: 'create' | 'edit'
  initial: UserRow | null
  roles: RoleOpt[]
  isSelf: boolean
  operatorRole: string
  busy: boolean
  onClose: () => void
  onSaved: (msg: string) => void
  setBusy: (b: boolean) => void
}) {
  const [username, setUsername] = useState(initial?.username ?? '')
  const [fullName, setFullName] = useState(initial?.fullName ?? '')
  const [role, setRole] = useState(initial?.role ?? (roles[0]?.name ?? 'NhanVien'))
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [fieldErr, setFieldErr] = useState<string | null>(null) // field lỗi trong modal user (mục 45)
  // Focus trap + Escape đóng + trả focus về nút đã mở (chuẩn chung, thay handler Escape tự viết)
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)

  const submit = async () => {
    setErr('')
    setFieldErr(null)
    // Validate client cơ bản để gắn aria-invalid đúng ô lỗi
    if (!username.trim()) { setFieldErr('username'); setErr('Vui lòng nhập tên đăng nhập'); return }
    if (!fullName.trim()) { setFieldErr('fullName'); setErr('Vui lòng nhập họ và tên'); return }
    if (mode === 'create' && password.length < 8) { setFieldErr('password'); setErr('Mật khẩu tối thiểu 8 ký tự'); return }
    setBusy(true)
    try {
      if (mode === 'create') {
        const res = await api('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, fullName, role, password }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) { setErr(json.error ?? 'Không thể tạo người dùng'); return }
        onSaved(`Đã tạo người dùng @${json.user.username} với vai trò ${role}`)
      } else if (initial) {
        const body: Record<string, string> = { fullName, role }
        if (password) body.password = password
        const res = await api(`/api/users/${initial.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) { setErr(json.error ?? 'Không thể cập nhật người dùng'); return }
        onSaved(password
          ? `Đã cập nhật thông tin và đặt lại mật khẩu cho @${initial.username}`
          : `Đã cập nhật thông tin @${initial.username}`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div ref={trapRef} className="fm-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'Thêm người dùng mới' : `Sửa người dùng @${initial?.username}`}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 className="fm-modal__title">
            {mode === 'create' ? 'Thêm người dùng mới' : `Sửa người dùng @${initial?.username}`}
          </h3>
          <button className="fm-icon-btn" aria-label="Đóng" onClick={onClose}><X size={16} /></button>
        </div>

        {err && (
          <div id="um-err" className="fm-alert fm-alert--error" role="alert">
            <div><b>Lỗi</b>{' '}{err}</div>
          </div>
        )}

        <div className="fm-field">
          <label className="fm-label" htmlFor="um-username">Tên đăng nhập <span className="fm-label__req">*</span></label>
          <input
            id="um-username"
            className={`fm-input${fieldErr === 'username' ? ' is-error' : ''}`}
            placeholder="vd: nhanvien2"
            value={username}
            onChange={(e) => { setFieldErr(null); setUsername(e.target.value) }}
            disabled={mode === 'edit'}
            autoComplete="off"
            aria-invalid={fieldErr === 'username' ? true : undefined}
            aria-describedby={err ? 'um-err' : undefined}
          />
        </div>

        <div className="fm-field">
          <label className="fm-label" htmlFor="um-fullname">Họ và tên <span className="fm-label__req">*</span></label>
          <input
            id="um-fullname"
            className={`fm-input${fieldErr === 'fullName' ? ' is-error' : ''}`}
            placeholder="vd: Nguyễn Thị Hoa"
            value={fullName}
            onChange={(e) => { setFieldErr(null); setFullName(e.target.value) }}
            aria-invalid={fieldErr === 'fullName' ? true : undefined}
            aria-describedby={err ? 'um-err' : undefined}
          />
        </div>

        <div className="fm-field">
          <label className="fm-label" htmlFor="um-role">Vai trò <span className="fm-label__req">*</span></label>
          <select
            id="um-role"
            className="fm-select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={mode === 'edit' && isSelf}
          >
            {roles.map((r) => (
              <option key={r.name} value={r.name}>{r.label} ({r.name})</option>
            ))}
          </select>
          <div className="fm-hint">
            {mode === 'edit' && isSelf
              ? 'Bạn không thể tự thay đổi vai trò của chính mình'
              : operatorRole !== 'Admin'
                ? 'Chỉ Admin mới được phân vai trò Admin'
                : 'Quyền hạn của người dùng theo ma trận quyền của vai trò'}
          </div>
        </div>

        <div className="fm-field">
          <label className="fm-label" htmlFor="um-password">
            {mode === 'create' ? <>Mật khẩu <span className="fm-label__req">*</span></> : 'Đặt lại mật khẩu'}
          </label>
          <input
            id="um-password"
            type="password"
            className={`fm-input${fieldErr === 'password' ? ' is-error' : ''}`}
            placeholder={mode === 'create' ? 'Tối thiểu 8 ký tự' : 'Bỏ trống nếu giữ nguyên mật khẩu cũ'}
            value={password}
            onChange={(e) => { setFieldErr(null); setPassword(e.target.value) }}
            autoComplete="new-password"
            aria-invalid={fieldErr === 'password' ? true : undefined}
            aria-describedby={err ? 'um-err' : undefined}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className="fm-btn fm-btn--primary" onClick={submit} disabled={busy}>
            {busy ? 'Đang lưu…' : mode === 'create' ? 'Tạo người dùng' : 'Lưu thay đổi'}
          </button>
          <button className="fm-btn fm-btn--ghost" onClick={onClose} disabled={busy}>Hủy</button>
        </div>
      </div>
    </div>
  )
}
