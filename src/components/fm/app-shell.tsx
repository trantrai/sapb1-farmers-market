'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard, ClipboardList, PlusCircle, UsersRound, Settings, ShieldCheck,
  LogOut, Menu as MenuIcon, X as CloseIcon, Sprout, LayoutGrid, History, Boxes,
  Percent, Contact, Bell, Search, Home, FileSpreadsheet,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import type { SessionUser, ModuleKey } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'

// Lazy load các views — chỉ tải khi user chuyển đến màn hình đó
const ViewLoading = () => (
  <div className="fm-card" style={{ padding: 48, textAlign: 'center', color: 'var(--fm-text-2)' }}>
    <div className="fm-spin" style={{ width: 28, height: 28, border: '3px solid var(--fm-line)', borderTopColor: 'var(--fm-primary)', borderRadius: '50%', margin: '0 auto 12px' }} />
    Đang tải…
  </div>
)
const DashboardView = dynamic(() => import('./dashboard-view'), { ssr: false, loading: ViewLoading })
const OrdersListView = dynamic(() => import('./orders-list-view'), { ssr: false, loading: ViewLoading })
const OrderDetailView = dynamic(() => import('./order-detail-view'), { ssr: false, loading: ViewLoading })
const OrderFormView = dynamic(() => import('./order-form-view'), { ssr: false, loading: ViewLoading })
const UsersView = dynamic(() => import('./users-view'), { ssr: false, loading: ViewLoading })
const SettingsView = dynamic(() => import('./settings-view'), { ssr: false, loading: ViewLoading })
const RolesView = dynamic(() => import('./roles-view'), { ssr: false, loading: ViewLoading })
const SapAuditView = dynamic(() => import('./sap-audit-view'), { ssr: false, loading: ViewLoading })
const ItemsSyncView = dynamic(() => import('./items-sync-view'), { ssr: false, loading: ViewLoading })
const VatGroupsSyncView = dynamic(() => import('./vatgroups-sync-view'), { ssr: false, loading: ViewLoading })
const PartnersSyncView = dynamic(() => import('./bpartners-sync-view'), { ssr: false, loading: ViewLoading })
const ExcelTemplatesView = dynamic(() => import('./excel-templates-view'), { ssr: false, loading: ViewLoading })
const SearchPalette = dynamic(() => import('./search-palette'), { ssr: false })
import type { EditOrderData } from './order-form-view'

type ViewKey = 'dashboard' | 'orders' | 'ordersNew' | 'orderDetail' | 'users' | 'settings' | 'roles' | 'sapAudit' | 'items' | 'vatGroups' | 'partners' | 'excelTemplates'

interface MenuItem {
  key: ViewKey
  module: ModuleKey
  label: string
  short: string
  icon: React.ReactNode
  group: 'main' | 'sync' | 'admin'
  badge?: string
}

const MENU: MenuItem[] = [
  { key: 'dashboard', module: 'orders', label: 'Tổng quan hệ thống', short: 'Tổng quan', icon: <LayoutDashboard size={16} />, group: 'main' },
  { key: 'orders', module: 'orders', label: 'Danh sách đơn hàng', short: 'Đơn hàng', icon: <ClipboardList size={16} />, group: 'main', badge: 'SO' },
  { key: 'ordersNew', module: 'ordersNew', label: 'Tạo đơn hàng mới', short: 'Tạo đơn', icon: <PlusCircle size={16} />, group: 'main' },
  { key: 'excelTemplates', module: 'excelTemplates', label: 'Mẫu Excel', short: 'Mẫu Excel', icon: <FileSpreadsheet size={16} />, group: 'main' },
  { key: 'items', module: 'settings', label: 'Đồng bộ Mặt hàng', short: 'Mặt hàng', icon: <Boxes size={16} />, group: 'sync', badge: 'Item' },
  { key: 'vatGroups', module: 'settings', label: 'Đồng bộ Nhóm thuế', short: 'Nhóm thuế', icon: <Percent size={16} />, group: 'sync', badge: 'VAT' },
  { key: 'partners', module: 'settings', label: 'Đồng bộ Khách hàng', short: 'Khách hàng', icon: <Contact size={16} />, group: 'sync', badge: 'KH' },
  { key: 'users', module: 'users', label: 'Quản lý người dùng', short: 'Người dùng', icon: <UsersRound size={16} />, group: 'admin' },
  { key: 'roles', module: 'roles', label: 'Phân quyền RBAC', short: 'Phân quyền', icon: <ShieldCheck size={16} />, group: 'admin' },
  { key: 'settings', module: 'settings', label: 'Cài đặt SAP B1', short: 'Cài đặt', icon: <Settings size={16} />, group: 'admin' },
  { key: 'sapAudit', module: 'settings', label: 'Service Layer Audit', short: 'SL Audit', icon: <History size={16} />, group: 'admin' },
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
  excelTemplates: 'Quản lý Template Excel',
}

interface Props {
  user: SessionUser
  onLogout: () => void
}

export default function AppShell({ user, onLogout }: Props) {
  const [view, setView] = useState<ViewKey>('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'warning' | 'error' } | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** Đơn đang SỬA (chế độ cập nhật của form tạo đơn) */
  const [editOrder, setEditOrder] = useState<EditOrderData | null>(null)
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null)
  /** Số đơn quá hạn giao — hiển thị badge đỏ trên menu Đơn hàng */
  const [overdueCount, setOverdueCount] = useState(0)
  /** Command palette tìm kiếm toàn văn (Ctrl+K) */
  const [searchOpen, setSearchOpen] = useState(false)
  /** Từ khóa điền sẵn cho màn đồng bộ khi chọn kết quả từ palette */
  const [syncPrefill, setSyncPrefill] = useState<{ view: 'items' | 'partners'; q: string } | null>(null)

  /** Trạng thái cấu hình SAP: 'ok' | 'none' | 'error' */
  const [sapStatus, setSapStatus] = useState<'ok' | 'none' | 'error'>('none')

  // Lấy trạng thái SAP thật từ /api/sap-databases (không hardcode "Live")
  useEffect(() => {
    let cancelled = false
    api('/api/sap-databases')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        const dbs = j?.data ?? j?.items ?? []
        if (!Array.isArray(dbs) || dbs.length === 0) setSapStatus('none')
        else if (dbs.some((d: any) => d.connected)) setSapStatus('ok')
        else setSapStatus('error')
      })
      .catch(() => { if (!cancelled) setSapStatus('error') })
    return () => { cancelled = true }
  }, [])

  // Đóng drawer mobile bằng phím Escape
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // Ctrl+K / Cmd+K mở command palette tìm kiếm toàn văn
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Tải số đơn quá hạn cho badge menu (im lặng, không setState đồng bộ trong effect)
  useEffect(() => {
    let cancelled = false
    api('/api/stats')
      .then(async (r) => {
        if (!r.ok) return
        const j = await r.json().catch(() => null)
        if (!cancelled && j && typeof j.overdueOrders === 'number') setOverdueCount(j.overdueOrders)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [refreshKey])

  const menu = useMemo(
    () => MENU.filter((m) => user.permissions?.[m.module]?.view),
    [user],
  )
  const mainMenu = menu.filter((m) => m.group === 'main')
  const syncMenu = menu.filter((m) => m.group === 'sync')
  const adminMenu = menu.filter((m) => m.group === 'admin')

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (t: string, type: 'success' | 'warning' | 'error' = 'success') => {
    setToast({ msg: t, type })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 5000)
  }

  const go = (v: ViewKey) => {
    setView(v)
    setDrawerOpen(false)
    window.scrollTo({ top: 0 })
  }

  // Chọn kết quả từ command palette tìm kiếm
  const selectSearchOrder = (orderId: string) => {
    setSearchOpen(false)
    setDetailOrderId(orderId)
    go('orderDetail')
  }
  const selectSearchItem = (itemCode: string) => {
    setSearchOpen(false)
    setSyncPrefill({ view: 'items', q: itemCode })
    go('items')
  }
  const selectSearchPartner = (cardCode: string) => {
    setSearchOpen(false)
    setSyncPrefill({ view: 'partners', q: cardCode })
    go('partners')
  }
  const prefillFor = (v: 'items' | 'partners') => (syncPrefill?.view === v ? syncPrefill.q : undefined)

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
      {m.badge && <span className="fm-badge-count">{m.badge}</span>}
      {m.key === 'orders' && overdueCount > 0 && (
        <span className="fm-badge-dot" title={`${overdueCount} đơn quá hạn giao`}>{overdueCount > 99 ? '99+' : overdueCount}</span>
      )}
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
              <small>SAP B1 • v1.1 Demo</small>
            </div>
          </div>
          <button
            className="fm-burger"
            style={{ background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.2)', color: '#fff', width: 44, height: 44 }}
            aria-label="Đóng menu"
            onClick={() => setDrawerOpen(false)}
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {/* Box trạng thái SAP Service Layer */}
        <div className="fm-sap-status">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="fm-sap-status__icon">⇄</span>
            <span>SAP Service Layer</span>
          </div>
          <span className="fm-sap-status__live" style={sapStatus === 'none' ? { opacity: 0.6 } : sapStatus === 'error' ? { color: 'var(--fm-red)' } : undefined}>
            <span className="fm-sap-status__dot" style={sapStatus === 'none' ? { background: '#9aa0a6' } : sapStatus === 'error' ? { background: 'var(--fm-red)' } : undefined} />
            {sapStatus === 'ok' ? 'Live' : sapStatus === 'none' ? 'Chưa cấu hình' : 'Lỗi'}
          </span>
        </div>

        {mainMenu.length > 0 && <div className="fm-menu-group">Chức Năng Chính</div>}
        <nav aria-label="Menu chức năng chính">{mainMenu.map(renderNavItem)}</nav>

        {syncMenu.length > 0 && (
          <>
            <div className="fm-menu-group" style={{ marginTop: 10 }}>Đồng Bộ Dữ Liệu</div>
            <nav aria-label="Menu đồng bộ">{syncMenu.map(renderNavItem)}</nav>
          </>
        )}

        {adminMenu.length > 0 && (
          <>
            <div className="fm-menu-group" style={{ marginTop: 10 }}>Quản Trị &amp; Hệ Thống</div>
            <nav aria-label="Menu quản trị">{adminMenu.map(renderNavItem)}</nav>
          </>
        )}

        {menu.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,.6)', fontSize: 12, padding: 12 }}>Không có quyền truy cập</div>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <div style={{ padding: '4px 12px 8px', fontSize: 11.5, color: 'rgba(255,255,255,.6)', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 600, color: 'rgba(255,255,255,.8)' }}>Phiên làm việc</div>
            <div>SAP Service 200 OK</div>
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
            <span>Thoát</span>
          </div>
        </div>
      </aside>

      {/* ===== Main ===== */}
      <div className="fm-main">
        <header className="fm-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, maxWidth: 560 }}>
            <button
              className="fm-burger"
              aria-label="Mở menu"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon size={17} />
            </button>
            <div
              className="fm-search fm-search--trigger"
              role="button"
              tabIndex={0}
              aria-label="Mở tìm kiếm toàn văn (Ctrl+K)"
              onClick={() => setSearchOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSearchOpen(true)
                }
              }}
            >
              <Search size={18} className="fm-search__icon" />
              <input
                className="fm-search__input"
                placeholder="Tìm kiếm mã hàng, SO, khách hàng (Ctrl+K)..."
                aria-label="Tìm kiếm"
                readOnly
                tabIndex={-1}
              />
              <kbd className="fm-search__kbd">Ctrl K</kbd>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button className="fm-header__bell" aria-label="Thông báo" title="Chưa có thông báo mới">
              <Bell size={20} />
            </button>
            <div className="fm-header__user">
              <span className="fm-header__avatar">
                {user.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('')}
              </span>
              <span className="fm-header__info">
                <b>{user.fullName}</b>
                <small>{user.roleLabel}{user.databaseLabel ? ` · DB: ${user.databaseLabel}` : ''}</small>
              </span>
            </div>
          </div>
        </header>

        <main className="fm-page">
          <div className="fm-view" key={view}>
            {view === 'dashboard' && (
              <DashboardView onGoOrders={() => go('orders')} onGoCreate={() => { setEditOrder(null); go('ordersNew') }} onGoOrderDetail={(orderId) => { setDetailOrderId(orderId); go('orderDetail') }} />
            )}
            {view === 'orders' && (
              <OrdersListView
                user={user}
                onGoCreate={() => { setEditOrder(null); go('ordersNew') }}
                onGoEdit={(data) => { setEditOrder(data); go('ordersNew') }}
                onGoDuplicate={(data) => { setEditOrder({ ...data, id: undefined }); go('ordersNew') }}
                onGoDetail={(orderId) => { setDetailOrderId(orderId); go('orderDetail') }}
                refreshKey={refreshKey}
              />
            )}
            {view === 'orderDetail' && detailOrderId && (
              <OrderDetailView
                orderId={detailOrderId}
                onBack={() => go('orders')}
                onEdit={(orderId) => {
                  // Lấy dữ liệu đơn để sửa — API trả { order } nên phải bóc lớp vỏ
                  api(`/api/orders/${orderId}`).then(async (r) => {
                    if (r.ok) {
                      const j = await r.json()
                      const o = j.order ?? j
                      setEditOrder({
                        id: o.id,
                        docNum: o.docNum,
                        cardCode: o.cardCode,
                        cardName: o.cardName,
                        docDate: o.docDate,
                        docDueDate: o.docDueDate,
                        status: o.status,
                        warehouseCode: o.warehouseCode,
                        remarks: o.remarks,
                        headerDiscPct: o.headerDiscPct,
                        lines: o.lines ?? [],
                      })
                      go('ordersNew')
                    }
                  })
                }}
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
            {view === 'items' && <ItemsSyncView key={`items-${prefillFor('items') ?? ''}`} initialQuery={prefillFor('items')} />}
            {view === 'vatGroups' && <VatGroupsSyncView />}
            {view === 'partners' && <PartnersSyncView key={`partners-${prefillFor('partners') ?? ''}`} initialQuery={prefillFor('partners')} />}
            {view === 'roles' && <RolesView user={user} onGoUsers={() => go('users')} />}
            {view === 'excelTemplates' && <ExcelTemplatesView />}
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
          aria-expanded={drawerOpen}
          aria-label="Mở menu điều hướng"
        >
          <LayoutGrid size={16} />
          <span>Menu</span>
        </button>
      </nav>

      {/* Backdrop cho mobile drawer — là button thật để bàn phím cũng đóng được */}
      {drawerOpen && (
        <button
          className="fm-drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-label="Đóng menu"
          style={{ border: 0, padding: 0, cursor: 'default' }}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fm-toast-host">
          <div role="status" className={`fm-alert fm-alert--${toast.type}`} style={{ boxShadow: 'var(--fm-shadow-pop)', margin: 0, minWidth: 260, maxWidth: 420, pointerEvents: 'auto' }}>
            <div><b>{toast.type === 'success' ? 'Hoàn tất' : toast.type === 'warning' ? 'Lưu ý' : 'Lỗi'}</b>{toast.msg}</div>
          </div>
        </div>
      )}

      {/* Command palette tìm kiếm toàn văn (Ctrl+K) */}
      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelectOrder={selectSearchOrder}
        onSelectItem={selectSearchItem}
        onSelectPartner={selectSearchPartner}
      />
    </div>
  )
}
