'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  LayoutDashboard, ClipboardList, PlusCircle, UsersRound, Settings, ShieldCheck,
  LogOut, Menu as MenuIcon, X as CloseIcon, Sprout, LayoutGrid, History, Boxes,
  Percent, Contact,
} from 'lucide-react'
import type { SessionUser, ModuleKey } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import DashboardView from './dashboard-view'
import OrdersListView from './orders-list-view'
import OrderFormView, { type EditOrderData } from './order-form-view'
import UsersView from './users-view'
import SettingsView from './settings-view'
import RolesView from './roles-view'
import SapAuditView from './sap-audit-view'
import ItemsSyncView from './items-sync-view'
import VatGroupsSyncView from './vatgroups-sync-view'
import PartnersSyncView from './bpartners-sync-view'
import OrderDetailView from './order-detail-view'
import type { Order } from './orders-list-view'

type ViewKey = 'dashboard' | 'orders' | 'ordersNew' | 'orderDetail' | 'users' | 'settings' | 'roles' | 'sapAudit' | 'items' | 'vatGroups' | 'partners'

interface MenuItem {
  key: ViewKey
  module: ModuleKey
  label: string
  short: string
  icon: React.ReactNode
  group: 'fn' | 'admin'
}

const MENU: MenuItem[] = [
  { key: 'dashboard', module: 'orders', label: 'Tổng quan', short: 'Tổng quan', icon: <LayoutDashboard size={16} />, group: 'fn' },
  { key: 'orders', module: 'orders', label: 'Danh sách đơn hàng', short: 'Đơn hàng', icon: <ClipboardList size={16} />, group: 'fn' },
  { key: 'ordersNew', module: 'ordersNew', label: 'Tạo đơn hàng', short: 'Tạo đơn', icon: <PlusCircle size={16} />, group: 'fn' },
  { key: 'users', module: 'users', label: 'Người dùng', short: 'Người dùng', icon: <UsersRound size={16} />, group: 'admin' },
  { key: 'settings', module: 'settings', label: 'Cài đặt SAP B1', short: 'Cài đặt', icon: <Settings size={16} />, group: 'admin' },
  { key: 'sapAudit', module: 'settings', label: 'Service Layer Audit', short: 'SL Audit', icon: <History size={16} />, group: 'admin' },
  { key: 'items', module: 'settings', label: 'Đồng bộ Mặt hàng', short: 'Mặt hàng', icon: <Boxes size={16} />, group: 'admin' },
  { key: 'vatGroups', module: 'settings', label: 'Đồng bộ Nhóm thuế', short: 'Nhóm thuế', icon: <Percent size={16} />, group: 'admin' },
  { key: 'partners', module: 'settings', label: 'Đồng bộ Khách hàng', short: 'Khách hàng', icon: <Contact size={16} />, group: 'admin' },
  { key: 'roles', module: 'roles', label: 'Phân quyền', short: 'Phân quyền', icon: <ShieldCheck size={16} />, group: 'admin' },
]

const VIEW_TITLES: Record<ViewKey, string> = {
  dashboard: 'Tổng quan hệ thống',
  orders: 'Danh sách Sale Order',
  ordersNew: 'Tạo / Cập nhật Sale Order',
  orderDetail: 'Chi tiết Sale Order',
  users: 'Quản lý người dùng',
  settings: 'Cài đặt kết nối SAP B1',
  sapAudit: 'Service Layer Audit — nhật ký & Retry',
  items: 'Quản lý đồng bộ Mặt hàng',
  vatGroups: 'Quản lý đồng bộ Nhóm thuế (Sale VAT Group)',
  partners: 'Quản lý đồng bộ Khách hàng',
  roles: 'Phân quyền (RBAC)',
}

interface Props {
  user: SessionUser
  onLogout: () => void
}

export default function AppShell({ user, onLogout }: Props) {
  const [view, setView] = useState<ViewKey>('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** Đơn đang SỬA (chế độ cập nhật của form tạo đơn) */
  const [editOrder, setEditOrder] = useState<EditOrderData | null>(null)
  /** Đơn đang XEM chi tiết (trang chi tiết dạng 3 bước) */
  const [detailOrder, setDetailOrder] = useState<Order | null>(null)

  // Đóng drawer mobile bằng phím Escape
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  const menu = useMemo(
    () => MENU.filter((m) => user.permissions?.[m.module]?.view),
    [user],
  )
  const fnMenu = menu.filter((m) => m.group === 'fn')
  const adminMenu = menu.filter((m) => m.group === 'admin')

  const showToast = (t: string) => {
    setToast(t)
    setTimeout(() => setToast(null), 5000)
  }

  const go = (v: ViewKey) => {
    setView(v)
    setDrawerOpen(false)
    window.scrollTo({ top: 0 })
  }

  const renderNavItem = (m: MenuItem) => (
    <div
      key={m.key}
      className={`fm-menu-item${view === m.key ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={m.label}
      aria-current={view === m.key ? 'page' : undefined}
      onClick={() => go(m.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          go(m.key)
        }
      }}
    >
      {m.icon}
      <span>{m.label}</span>
      {m.key === 'orders' && <span className="fm-badge-count">SO</span>}
      {m.key === 'items' && <span className="fm-badge-count">Item</span>}
      {m.key === 'vatGroups' && <span className="fm-badge-count">VAT</span>}
      {m.key === 'partners' && <span className="fm-badge-count">KH</span>}
    </div>
  )

  return (
    <div className="fm-layout fm-app-root">
      {/* ===== Sidebar ===== */}
      <aside className={`fm-sidebar${drawerOpen ? ' is-open' : ''}`}>
        <div className="fm-logo" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="fm-logo__badge">F</div>
            <div className="fm-logo__name">
              FARMERS MARKET
              <small>SAP B1 · Sale Order</small>
            </div>
          </div>
          <button
            className="fm-burger"
            style={{ background: '#F5F5F5', border: '1px solid var(--fm-line)', color: 'var(--fm-text)', width: 44, height: 44 }}
            aria-label="Đóng menu"
            onClick={() => setDrawerOpen(false)}
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {fnMenu.length > 0 && <div className="fm-menu-group">Chức năng</div>}
        <nav aria-label="Menu chức năng">{fnMenu.map(renderNavItem)}</nav>

        {adminMenu.length > 0 && (
          <>
            <div className="fm-menu-group" style={{ marginTop: 10 }}>Quản trị</div>
            <nav aria-label="Menu quản trị">{adminMenu.map(renderNavItem)}</nav>
          </>
        )}

        {menu.length === 0 && (
          <div style={{ color: 'var(--fm-text-2)', fontSize: 12, padding: 12 }}>Không có quyền truy cập</div>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--fm-line)' }}>
          <div style={{ padding: '4px 12px 10px', fontSize: 11.5, color: 'var(--fm-text-3)', lineHeight: 1.5 }}>
            <Sprout size={13} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--fm-accent)' }} />
            Phiên bản 1.1 · CSDL demo
          </div>
          <div
            className="fm-menu-item"
            role="button"
            tabIndex={0}
            aria-label="Đăng xuất"
            onClick={onLogout}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onLogout()
              }
            }}
          >
            <LogOut size={16} />
            <span>Đăng xuất</span>
          </div>
        </div>
      </aside>

      {/* ===== Main ===== */}
      <div className="fm-main">
        <div className="fm-pagehead">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button
              className="fm-burger"
              aria-label="Mở menu"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon size={17} />
            </button>
            <h1 className="fm-pagehead__title" title={VIEW_TITLES[view]} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{VIEW_TITLES[view]}</h1>
          </div>
          <div className="fm-pagehead__user">
            <span className="fm-pagehead__avatar">
              {user.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('')}
            </span>
            <span>
              <b style={{ color: 'var(--fm-text)' }}>{user.fullName}</b>
              <span className="fm-pagehead__role-label"> · {user.roleLabel}</span>
            </span>
          </div>
        </div>

        <main className="fm-page">
          <div className="fm-view" key={view}>
            {view === 'dashboard' && (
              <DashboardView onGoOrders={() => go('orders')} />
            )}
            {view === 'orders' && (
              <OrdersListView
                user={user}
                onGoCreate={() => { setEditOrder(null); go('ordersNew') }}
                onViewDetail={(o) => { setDetailOrder(o); go('orderDetail') }}
                refreshKey={refreshKey}
              />
            )}
            {view === 'orderDetail' && detailOrder && (
              <OrderDetailView
                user={user}
                order={detailOrder}
                onBack={() => go('orders')}
                onGoEdit={(data) => { setEditOrder(data); go('ordersNew') }}
                onChanged={() => setRefreshKey((k) => k + 1)}
              />
            )}
            {view === 'ordersNew' && (
              <OrderFormView
                editOrder={editOrder}
                onCancel={() => { setEditOrder(null); go('orders') }}
                onSaved={({ docNum, sapStatus, sapDocNum, sapError }) => {
                  const wasEdit = Boolean(editOrder)
                  setEditOrder(null)
                  let msg = wasEdit
                    ? `Đã cập nhật Sale Order #${docNum} thành công!`
                    : `Đã tạo Sale Order #${docNum} thành công!`
                  if (sapStatus === 'synced') msg += wasEdit
                    ? ` Đã cập nhật chứng từ trên SAP B1${sapDocNum ? ` (DocNum ${sapDocNum})` : ''}.`
                    : ` Đã đẩy sang SAP B1 — DocNum ${sapDocNum}.`
                  else if (sapStatus === 'pending')
                    msg += ` Chưa đẩy được sang SAP B1${sapError ? `: ${sapError}` : ''} — bấm "Đẩy lại" trong danh sách đơn.`
                  else if (!wasEdit) msg += ' (chưa cấu hình SAP B1 — đơn chỉ lưu trên hệ thống này)'
                  showToast(msg)
                  setRefreshKey((k) => k + 1)
                  go('orders')
                }}
              />
            )}
            {view === 'users' && <UsersView user={user} />}
            {view === 'settings' && <SettingsView canEdit={user.permissions.settings?.edit} />}
            {view === 'sapAudit' && <SapAuditView />}
            {view === 'items' && <ItemsSyncView />}
            {view === 'vatGroups' && <VatGroupsSyncView />}
            {view === 'partners' && <PartnersSyncView />}
            {view === 'roles' && <RolesView user={user} onGoUsers={() => go('users')} />}
          </div>
        </main>
      </div>

      {/* ===== Bottom tab bar (mobile) ===== */}
      <nav className="fm-bottomnav" aria-label="Menu nhanh dưới màn hình">
        {menu.slice(0, 4).map((m) => (
          <button
            key={m.key}
            className={`fm-bottomnav__item${view === m.key ? ' is-active' : ''}`}
            aria-current={view === m.key ? 'page' : undefined}
            onClick={() => go(m.key)}
          >
            {m.icon}
            <span>{m.short}</span>
          </button>
        ))}
        <button
          className={`fm-bottomnav__item${view !== 'dashboard' && !menu.slice(0, 4).some((m) => m.key === view) ? ' is-active' : ''}`}
          onClick={() => setDrawerOpen(true)}
        >
          <LayoutGrid size={16} />
          <span>Menu</span>
        </button>
      </nav>

      {/* Backdrop cho mobile drawer */}
      {drawerOpen && (
        <div
          className="fm-drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fm-toast-host">
          <div role="status" className="fm-alert fm-alert--success" style={{ boxShadow: 'var(--fm-shadow-pop)', margin: 0, minWidth: 260, maxWidth: 420, pointerEvents: 'auto' }}>
            <div><b>Hoàn tất</b>{toast}</div>
          </div>
        </div>
      )}
    </div>
  )
}
