'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard, ClipboardList, UsersRound, Settings, ShieldCheck,
  LogOut, Menu as MenuIcon, X as CloseIcon, Sprout, LayoutGrid, History, Boxes,
  Percent, Contact, Bell, Search, Home, FileSpreadsheet, Truck, FileUp,
  FileText, Receipt, FileMinus2, Undo2, HandCoins, BarChart3, FileClock,
  UserCheck, CalendarClock, ArrowRight, Database,
  PanelLeftClose, PanelLeftOpen,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import type { SessionUser, ModuleKey } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'

// Lazy load các views — chỉ tải khi user chuyển đến màn hình đó
const ViewLoading = () => (
  <div className="fm-card" style={{ padding: 48, color: 'var(--fm-text-2)' }}>
    <div className="fm-spin" style={{ width: 28, height: 28, border: '3px solid var(--fm-line)', borderTopColor: 'var(--fm-primary)', borderRadius: '50%', margin: '0 0 12px' }} />
    Đang tải…
  </div>
)
const DashboardView = dynamic(() => import('./dashboard-view'), { ssr: false, loading: ViewLoading })
const OrdersListView = dynamic(() => import('./orders-list-view'), { ssr: false, loading: ViewLoading })
const OrderDetailView = dynamic(() => import('./order-detail-view'), { ssr: false, loading: ViewLoading })
const OrderFormView = dynamic(() => import('./order-form-view'), { ssr: false, loading: ViewLoading })
const DeliveriesListView = dynamic(() => import('./deliveries-list-view'), { ssr: false, loading: ViewLoading })
const DeliveryDetailView = dynamic(() => import('./delivery-detail-view'), { ssr: false, loading: ViewLoading })
const DeliveryFormView = dynamic(() => import('./delivery-form-view'), { ssr: false, loading: ViewLoading })
const UsersView = dynamic(() => import('./users-view'), { ssr: false, loading: ViewLoading })
const SettingsView = dynamic(() => import('./settings-view'), { ssr: false, loading: ViewLoading })
const RolesView = dynamic(() => import('./roles-view'), { ssr: false, loading: ViewLoading })
const SapAuditView = dynamic(() => import('./sap-audit-view'), { ssr: false, loading: ViewLoading })
const ItemsSyncView = dynamic(() => import('./items-sync-view'), { ssr: false, loading: ViewLoading })
const VatGroupsSyncView = dynamic(() => import('./vatgroups-sync-view'), { ssr: false, loading: ViewLoading })
const PartnersSyncView = dynamic(() => import('./bpartners-sync-view'), { ssr: false, loading: ViewLoading })
const SalesPersonsSyncView = dynamic(() => import('./sales-persons-sync-view'), { ssr: false, loading: ViewLoading })
const PaymentTermsSyncView = dynamic(() => import('./payment-terms-sync-view'), { ssr: false, loading: ViewLoading })
const ExcelTemplatesView = dynamic(() => import('./excel-templates-view'), { ssr: false, loading: ViewLoading })
const BomImportView = dynamic(() => import('./bom-import-view'), { ssr: false, loading: ViewLoading })
const QuotationsListView = dynamic(() => import('./quotations-list-view'), { ssr: false, loading: ViewLoading })
const QuotationFormView = dynamic(() => import('./quotation-form-view'), { ssr: false, loading: ViewLoading })
const QuotationDetailView = dynamic(() => import('./quotation-detail-view'), { ssr: false, loading: ViewLoading })
const InvoicesListView = dynamic(() => import('./invoices-list-view'), { ssr: false, loading: ViewLoading })
const InvoiceFormView = dynamic(() => import('./invoice-form-view'), { ssr: false, loading: ViewLoading })
const InvoiceDetailView = dynamic(() => import('./invoice-detail-view'), { ssr: false, loading: ViewLoading })
const CreditMemosListView = dynamic(() => import('./credit-memos-list-view'), { ssr: false, loading: ViewLoading })
const CreditMemoFormView = dynamic(() => import('./credit-memo-form-view'), { ssr: false, loading: ViewLoading })
const CreditMemoDetailView = dynamic(() => import('./credit-memo-detail-view'), { ssr: false, loading: ViewLoading })
const ReturnsListView = dynamic(() => import('./returns-list-view'), { ssr: false, loading: ViewLoading })
const ReturnFormView = dynamic(() => import('./return-form-view'), { ssr: false, loading: ViewLoading })
const ReturnDetailView = dynamic(() => import('./return-detail-view'), { ssr: false, loading: ViewLoading })
// Phase 2 — Hóa đơn đặt cọc phải thu + Báo cáo (Sales / Công nợ)
const DownPaymentsListView = dynamic(() => import('./down-payments-list-view'), { ssr: false, loading: ViewLoading })
const DownPaymentFormView = dynamic(() => import('./down-payment-form-view'), { ssr: false, loading: ViewLoading })
const DownPaymentDetailView = dynamic(() => import('./down-payment-detail-view'), { ssr: false, loading: ViewLoading })
const SalesReportView = dynamic(() => import('./sales-report-view'), { ssr: false, loading: ViewLoading })
const ArAgingReportView = dynamic(() => import('./ar-aging-report-view'), { ssr: false, loading: ViewLoading })
const SearchPalette = dynamic(() => import('./search-palette'), { ssr: false })
import type { AssistantOrderDraft, EditOrderData } from './order-form-view'
import AssistantChat from './assistant-chat'
import { toEditData } from './order-form-view'
import type { CopyTarget } from './sales-doc-shared'

type ViewKey = 'dashboard' | 'orders' | 'ordersNew' | 'orderDetail' | 'deliveries' | 'deliveryDetail' | 'deliveryNew' | 'users' | 'settings' | 'roles' | 'sapAudit' | 'items' | 'vatGroups' | 'partners' | 'salesPersons' | 'paymentTerms' | 'excelTemplates' | 'bomImport' | 'quotations' | 'quotationNew' | 'quotationDetail' | 'invoices' | 'invoiceNew' | 'invoiceDetail' | 'creditMemos' | 'creditMemoNew' | 'creditMemoDetail' | 'returns' | 'returnNew' | 'returnDetail' | 'downPayments' | 'downPaymentNew' | 'downPaymentDetail' | 'salesReport' | 'arAgingReport'

interface MenuItem {
  key: ViewKey
  module: ModuleKey
  label: string
  short: string
  icon: React.ReactNode
  group: 'main' | 'sync' | 'admin'
}

const MENU: MenuItem[] = [
  { key: 'dashboard', module: 'orders', label: 'Tổng quan hệ thống', short: 'Tổng quan', icon: <LayoutDashboard size={16} />, group: 'main' },
  { key: 'quotations', module: 'quotations', label: 'Báo giá bán hàng', short: 'Báo giá', icon: <FileText size={16} />, group: 'main' },
  { key: 'orders', module: 'orders', label: 'Danh sách đơn hàng bán', short: 'Đơn hàng bán', icon: <ClipboardList size={16} />, group: 'main' },
  { key: 'deliveries', module: 'deliveries', label: 'Quản lý giao hàng', short: 'Giao hàng', icon: <Truck size={16} />, group: 'main' },
  { key: 'returns', module: 'returns', label: 'Phiếu trả hàng bán', short: 'Trả hàng', icon: <Undo2 size={16} />, group: 'main' },
  { key: 'downPayments', module: 'downPayments', label: 'Hóa đơn đặt cọc phải thu', short: 'Đặt cọc', icon: <HandCoins size={16} />, group: 'main' },
  { key: 'invoices', module: 'invoices', label: 'Hóa đơn bán hàng', short: 'Hóa đơn', icon: <Receipt size={16} />, group: 'main' },
  { key: 'creditMemos', module: 'creditMemos', label: 'Phiếu ghi có phải thu', short: 'Ghi có', icon: <FileMinus2 size={16} />, group: 'main' },
  { key: 'salesReport', module: 'salesReport', label: 'Báo cáo bán hàng', short: 'BC bán hàng', icon: <BarChart3 size={16} />, group: 'main' },
  { key: 'arAgingReport', module: 'arAgingReport', label: 'Công nợ phải thu', short: 'Công nợ', icon: <FileClock size={16} />, group: 'main' },
  { key: 'excelTemplates', module: 'excelTemplates', label: 'Mẫu Excel', short: 'Mẫu Excel', icon: <FileSpreadsheet size={16} />, group: 'main' },
  { key: 'partners', module: 'settings', label: 'Đối tác kinh doanh', short: 'Khách hàng', icon: <Contact size={16} />, group: 'sync' },
  { key: 'items', module: 'settings', label: 'Mặt hàng', short: 'Mặt hàng', icon: <Boxes size={16} />, group: 'sync' },
  { key: 'vatGroups', module: 'settings', label: 'Nhóm thuế', short: 'Nhóm thuế', icon: <Percent size={16} />, group: 'sync' },
  { key: 'salesPersons', module: 'settings', label: 'Nhân viên bán hàng', short: 'NVBH', icon: <UserCheck size={16} />, group: 'sync' },
  { key: 'paymentTerms', module: 'settings', label: 'Điều khoản thanh toán', short: 'ĐKTT', icon: <CalendarClock size={16} />, group: 'sync' },
  { key: 'bomImport', module: 'bomImport', label: 'Import BOM/Combo', short: 'Import BOM', icon: <FileUp size={16} />, group: 'sync' },
  { key: 'users', module: 'users', label: 'Quản lý người dùng', short: 'Người dùng', icon: <UsersRound size={16} />, group: 'admin' },
  { key: 'roles', module: 'roles', label: 'Quản lý ủy quyền', short: 'Ủy quyền', icon: <ShieldCheck size={16} />, group: 'admin' },
  { key: 'settings', module: 'settings', label: 'Cài đặt SAP B1', short: 'Cài đặt', icon: <Settings size={16} />, group: 'admin' },
  { key: 'sapAudit', module: 'settings', label: 'Service Layer Audit', short: 'SL Audit', icon: <History size={16} />, group: 'admin' },
]

// Màn tạo/sửa/chi tiết → tô sáng mục menu danh sách tương ứng
const NAV_PARENT: Partial<Record<ViewKey, ViewKey>> = {
  ordersNew: 'orders', orderDetail: 'orders',
  deliveryNew: 'deliveries', deliveryDetail: 'deliveries',
  quotationNew: 'quotations', quotationDetail: 'quotations',
  invoiceNew: 'invoices', invoiceDetail: 'invoices',
  creditMemoNew: 'creditMemos', creditMemoDetail: 'creditMemos',
  returnNew: 'returns', returnDetail: 'returns',
  downPaymentNew: 'downPayments', downPaymentDetail: 'downPayments',
}

const VIEW_TITLES: Record<ViewKey, string> = {
  dashboard: 'Tổng quan hệ thống',
  orders: 'Danh sách đơn hàng bán',
  ordersNew: 'Tạo / Cập nhật đơn hàng bán',
  orderDetail: 'Chi tiết đơn hàng bán',
  deliveries: 'Quản lý giao hàng',
  deliveryDetail: 'Chi tiết phiếu giao hàng',
  deliveryNew: 'Tạo / Cập nhật phiếu giao hàng',
  users: 'Quản lý người dùng',
  settings: 'Cài đặt kết nối SAP B1',
  sapAudit: 'Service Layer Audit — nhật ký & thử lại',
  items: 'Quản lý đồng bộ Mặt hàng',
  vatGroups: 'Quản lý đồng bộ Nhóm thuế (Sale VAT Group)',
  partners: 'Quản lý đồng bộ Khách hàng',
  salesPersons: 'Quản lý đồng bộ Nhân viên bán hàng (OSLP)',
  paymentTerms: 'Quản lý đồng bộ Điều khoản thanh toán (OCTG)',
  roles: 'Ủy quyền',
  excelTemplates: 'Quản lý mẫu Excel',
  bomImport: 'Import BOM/Combo từ Base Workflow',
  quotations: 'Báo giá bán hàng',
  quotationNew: 'Tạo / Cập nhật báo giá bán hàng',
  quotationDetail: 'Chi tiết báo giá bán hàng',
  invoices: 'Hóa đơn bán hàng',
  invoiceNew: 'Tạo / Cập nhật hóa đơn bán hàng',
  invoiceDetail: 'Chi tiết hóa đơn bán hàng',
  creditMemos: 'Phiếu ghi có phải thu',
  creditMemoNew: 'Tạo / Cập nhật phiếu ghi có phải thu',
  creditMemoDetail: 'Chi tiết phiếu ghi có phải thu',
  returns: 'Phiếu trả hàng bán',
  returnNew: 'Tạo / Cập nhật phiếu trả hàng bán',
  returnDetail: 'Chi tiết phiếu trả hàng bán',
  downPayments: 'Hóa đơn đặt cọc phải thu',
  downPaymentNew: 'Tạo / Cập nhật hóa đơn đặt cọc phải thu',
  downPaymentDetail: 'Chi tiết hóa đơn đặt cọc phải thu',
  salesReport: 'Báo cáo bán hàng',
  arAgingReport: 'Công nợ phải thu',
}

interface Props {
  user: SessionUser
  onLogout: () => void
}

export default function AppShell({ user, onLogout }: Props) {
  const [view, setView] = useState<ViewKey>('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  /** Toast xếp chồng: toast mới không ghi đè toast cũ (kể cả toast lỗi quan trọng) */
  const [toasts, setToasts] = useState<{
    id: number
    msg: string
    type: 'success' | 'warning' | 'error'
    /** Action tùy chọn trong toast (mục 38: “Xem đơn vừa tạo”) */
    action?: { label: string; onClick: () => void }
  }[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Thu gọn sidebar thành icon-rail (desktop); nhớ lựa chọn theo trình duyệt
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return localStorage.getItem('fm.sidebarCollapsed') === '1' } catch { return false }
  })
  const toggleSidebar = () => {
    setCollapsed((c) => {
      try { localStorage.setItem('fm.sidebarCollapsed', c ? '0' : '1') } catch { /* private mode */ }
      return !c
    })
  }
  /** Đơn đang SỬA (chế độ cập nhật của form tạo đơn) */
  const [editOrder, setEditOrder] = useState<EditOrderData | null>(null)
  // Nháp đơn từ Trợ lý sale admin → form tạo đơn (nonce đổi mỗi lần mở)
  const [assistantDraft, setAssistantDraft] = useState<AssistantOrderDraft | null>(null)
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null)
  const [detailDeliveryId, setDetailDeliveryId] = useState<string | null>(null)
  /** Id chi tiết từng loại chứng từ Phase 1 Sales A/R */
  const [detailQuotationId, setDetailQuotationId] = useState<string | null>(null)
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null)
  const [detailCreditMemoId, setDetailCreditMemoId] = useState<string | null>(null)
  const [detailReturnId, setDetailReturnId] = useState<string | null>(null)
  /** Phase 2 — Hóa đơn đặt cọc phải thu */
  const [detailDownPaymentId, setDetailDownPaymentId] = useState<string | null>(null)
  /** Nguồn copy cho form tạo chứng từ mới (theo pattern editOrder hiện có) */
  const [quotationSource, setQuotationSource] = useState<{ type: string; id: string } | null>(null)
  const [invoiceSource, setInvoiceSource] = useState<{ type: 'quotation' | 'order' | 'delivery'; id: string } | null>(null)
  const [creditMemoSource, setCreditMemoSource] = useState<{ type: 'invoice' | 'return'; id: string } | null>(null)
  const [returnSource, setReturnSource] = useState<{ type: 'delivery' | 'invoice'; id: string } | null>(null)
  /** Phase 2 — nguồn copy cho form tạo hóa đơn đặt cọc (từ Báo giá / Đơn hàng bán) */
  const [downPaymentSource, setDownPaymentSource] = useState<{ type: 'quotation' | 'order'; id: string } | null>(null)
  /** Chứng từ đang SỬA (chế độ cập nhật của form — theo pattern editOrder) */
  const [editQuotationId, setEditQuotationId] = useState<string | null>(null)
  const [editInvoiceId, setEditInvoiceId] = useState<string | null>(null)
  const [editCreditMemoId, setEditCreditMemoId] = useState<string | null>(null)
  const [editReturnId, setEditReturnId] = useState<string | null>(null)
  /** Phiếu giao hàng đang SỬA (form tạo/sửa trực tiếp) */
  const [editDeliveryId, setEditDeliveryId] = useState<string | null>(null)
  /** Phase 2 — Hóa đơn đặt cọc phải thu đang SỬA */
  const [editDownPaymentId, setEditDownPaymentId] = useState<string | null>(null)
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
        const dbs = j?.databases ?? j?.data ?? j?.items ?? []
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

  // document.title đổi theo màn hình đang xem (a11y: screen reader & tab trình duyệt)
  useEffect(() => {
    document.title = `${VIEW_TITLES[view]} — Farmers Market`
  }, [view])

  const menu = useMemo(
    () => MENU.filter((m) => user.permissions?.[m.module]?.view),
    [user],
  )
  const mainMenu = menu.filter((m) => m.group === 'main')
  const syncMenu = menu.filter((m) => m.group === 'sync')
  const adminMenu = menu.filter((m) => m.group === 'admin')

  const toastSeq = useRef(0)
  const dismissToast = (id: number) => setToasts((prev) => prev.filter((x) => x.id !== id))
  const showToast = (t: string, type: 'success' | 'warning' | 'error' = 'success', action?: { label: string; onClick: () => void }) => {
    // error giữ 12s (kịp đọc, vẫn đóng thủ công bằng ×), warning 8s, success 5s như cũ
    const ms = type === 'error' ? 12000 : type === 'warning' ? 8000 : 5000
    const id = ++toastSeq.current
    setToasts((prev) => {
      const next = [...prev, { id, msg: t, type, action }]
      // Giới hạn 3 toast: loại toast cũ nhất trước, ưu tiên GIỮ toast lỗi
      while (next.length > 3) {
        const i = next.findIndex((x) => x.type !== 'error')
        next.splice(i === -1 ? 0 : i, 1)
      }
      return next
    })
    // A4 — toast có action (vd "Xem đơn vừa tạo") thì KHÔNG tự đóng: user bàn phím
    // cần thời gian Tab tới nút action. Chỉ toast không action mới tự đóng theo type.
    if (!action) setTimeout(() => dismissToast(id), ms)
  }

  const go = (v: ViewKey) => {
    setView(v)
    setDrawerOpen(false)
    window.scrollTo({ top: 0 })
    // A1 — chuyển view thì đưa focus vào nội dung mới để keyboard/screen reader theo kịp.
    // BỎ QUA khi có dialog/modal đang mở (guard) để không phá focus trap của modal.
    requestAnimationFrame(() => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')) return
      const main = document.getElementById('fm-main')
      if (!main) return
      const h1 = main.querySelector('h1')
      if (h1 instanceof HTMLElement) {
        // <h1> của view (qua PageHeader) chưa focusable — gắn tabIndex=-1 tạm thời rồi focus.
        // .fm-view có key={view} nên remount mỗi lần chuyển, attribute không rò rỉ sang view khác.
        h1.setAttribute('tabindex', '-1')
        h1.focus({ preventScroll: false })
      } else {
        // Fallback: <main id="fm-main"> đã có tabIndex={-1}
        main.focus({ preventScroll: false })
      }
    })
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

  /**
   * "Copy sang…" giữa các chứng từ bán hàng: ghi nguồn rồi điều hướng
   * tới form tạo mới của chứng từ đích. Ví dụ copy từ chi tiết báo giá
   * sang hóa đơn → mở InvoiceFormView với sourceType='quotation'.
   * Combo nguồn→đích không hợp lệ (hoặc form chưa hỗ trợ) → báo user.
   */
  const copyDocTo = (target: CopyTarget, sourceType: CopyTarget, sourceId: string) => {
    if (target === 'quotation') {
      setQuotationSource({ type: sourceType, id: sourceId })
      go('quotationNew')
    } else if (target === 'invoice') {
      if (sourceType === 'quotation' || sourceType === 'order' || sourceType === 'delivery') {
        setInvoiceSource({ type: sourceType, id: sourceId })
        go('invoiceNew')
      } else {
        showToast('Không hỗ trợ sao chép sang Hóa đơn bán hàng từ loại chứng từ này.', 'warning')
      }
    } else if (target === 'creditMemo') {
      if (sourceType === 'invoice' || sourceType === 'return') {
        setCreditMemoSource({ type: sourceType, id: sourceId })
        go('creditMemoNew')
      } else {
        showToast('Không hỗ trợ sao chép sang Phiếu ghi có phải thu từ loại chứng từ này.', 'warning')
      }
    } else if (target === 'return') {
      if (sourceType === 'delivery' || sourceType === 'invoice') {
        setReturnSource({ type: sourceType, id: sourceId })
        go('returnNew')
      } else {
        showToast('Không hỗ trợ sao chép sang Phiếu trả hàng bán từ loại chứng từ này.', 'warning')
      }
    } else if (target === 'downPayment') {
      // Phase 2 — tạo hóa đơn đặt cọc từ Báo giá bán hàng / Đơn hàng bán
      if (sourceType === 'quotation' || sourceType === 'order') {
        setDownPaymentSource({ type: sourceType, id: sourceId })
        go('downPaymentNew')
      } else {
        showToast('Không hỗ trợ sao chép sang Hóa đơn đặt cọc phải thu từ loại chứng từ này.', 'warning')
      }
    } else {
      // target 'order' | 'delivery' — OrderFormView/delivery chưa có sourceType
      showToast(`Chức năng sao chép sang ${target === 'order' ? 'Đơn hàng bán' : 'Phiếu giao hàng'} sẽ được bổ sung sau.`, 'warning')
    }
  }

  const navView = NAV_PARENT[view] ?? view
  const renderNavItem = (m: MenuItem) => (
    <div
      key={m.key}
      className={`fm-menu-item${navView === m.key ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={m.label}
      title={m.label} /* tablet rail ≤900px chỉ hiện icon — title làm tooltip */
      aria-current={navView === m.key ? 'page' : undefined}
      onClick={() => go(m.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          go(m.key)
        }
      }}
    >
      {m.icon}
      <span className="fm-menu-item__label">{m.label}</span>
      {m.key === 'orders' && overdueCount > 0 && (
        <span className="fm-badge-dot" title={`${overdueCount} đơn quá hạn giao`}>{overdueCount > 99 ? '99+' : overdueCount}</span>
      )}
    </div>
  )

  return (
    <div className="fm-layout fm-app-root">
      <a href="#fm-main" className="fm-skip-link">Bỏ qua tới nội dung chính</a>
      {/* ===== Sidebar ===== */}
      <aside className={`fm-sidebar${drawerOpen ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}`}>
        <div className="fm-logo" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="fm-logo__badge">F</div>
            <div className="fm-logo__name">
              FARMERS MARKET
            </div>
          </div>
          <button
            type="button"
            className="fm-sidebar-toggle"
            aria-label={collapsed ? 'Mở rộng menu' : 'Thu nhỏ menu'}
            aria-pressed={collapsed}
            title={collapsed ? 'Mở rộng menu' : 'Thu nhỏ menu'}
            onClick={toggleSidebar}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <button
            className="fm-burger fm-burger--on-dark"
            aria-label="Đóng menu"
            onClick={() => setDrawerOpen(false)}
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {mainMenu.length > 0 && <div className="fm-menu-group">Chức năng chính</div>}
        <nav aria-label="Menu chức năng chính">{mainMenu.map(renderNavItem)}</nav>

        {syncMenu.length > 0 && (
          <>
            <div className="fm-menu-group" style={{ marginTop: 10 }}>Đồng bộ dữ liệu</div>
            <nav aria-label="Menu đồng bộ">{syncMenu.map(renderNavItem)}</nav>
          </>
        )}

        {adminMenu.length > 0 && (
          <>
            <div className="fm-menu-group" style={{ marginTop: 10 }}>Quản trị &amp; hệ thống</div>
            <nav aria-label="Menu quản trị">{adminMenu.map(renderNavItem)}</nav>
          </>
        )}

        {menu.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,.6)', fontSize: 12, padding: 12 }}>Không có quyền truy cập</div>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <div
            className="fm-menu-item"
            role="button"
            tabIndex={0}
            aria-label="Đăng xuất"
            title="Đăng xuất" /* tooltip khi sidebar thu gọn thành icon-rail */
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
              <MenuIcon size={18} />
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
                placeholder="Tìm kiếm mã mặt hàng, đơn hàng, khách hàng (Ctrl+K)..."
                aria-label="Tìm kiếm"
                readOnly
                tabIndex={-1}
              />
              <kbd className="fm-search__kbd">Ctrl K</kbd>
            </div>
          </div>
          <div className="fm-header__right">
            <button className="fm-header__bell" aria-label="Thông báo" title="Chưa có thông báo mới" onClick={() => showToast('Chưa có thông báo mới', 'success')}>
              <Bell size={18} />
            </button>
            {/* CSDL SAP B1 đang làm việc — đặt ngay trước người dùng, kèm trạng thái kết nối */}
            <div
              className={`fm-header__db is-${sapStatus}`}
              title={`Cơ sở dữ liệu SAP B1 đang làm việc: ${user.databaseLabel ?? 'Mặc định'} — ${sapStatus === 'ok' ? 'đang kết nối' : sapStatus === 'none' ? 'chưa cấu hình Service Layer' : 'lỗi kết nối'}`}
            >
              <Database size={16} aria-hidden className="fm-header__db-icon" />
              <span className="fm-header__db-text">
                <small>Cơ sở dữ liệu</small>
                <b>{user.databaseLabel ?? 'Mặc định'}</b>
              </span>
              <span className="fm-header__db-dot" aria-hidden />
              <span className="fm-sr-only">
                {sapStatus === 'ok' ? 'Đang kết nối' : sapStatus === 'none' ? 'Chưa cấu hình' : 'Lỗi kết nối'}
              </span>
            </div>
            <div className="fm-header__user">
              <span className="fm-header__avatar">
                {user.fullName.split(' ').map((w) => w[0]).slice(0, 2).join('')}
              </span>
              <span className="fm-header__info">
                <b>{user.fullName}</b>
                <small>{user.roleLabel}</small>
              </span>
            </div>
          </div>
        </header>

        <main className="fm-page" id="fm-main" tabIndex={-1}>
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
                onGoDelivery={(id) => { setDetailDeliveryId(id); go('deliveryDetail') }}
                refreshKey={refreshKey}
              />
            )}
            {view === 'orderDetail' && detailOrderId && (
              <OrderDetailView
                orderId={detailOrderId}
                onBack={() => go('orders')}
                onGoDelivery={(deliveryId) => { setDetailDeliveryId(deliveryId); go('deliveryDetail') }}
                onCopyTo={(target, sourceId) => copyDocTo(target, 'order', sourceId)}
                onEdit={(orderId) => {
                  // Lấy dữ liệu đơn để sửa — API trả { order } nên phải bóc lớp vỏ.
                  // Dùng toEditData DÙNG CHUNG (giống đường vào từ danh sách) để map
                  // dbId/sapLineNum — thiếu 2 trường này PUT sẽ append trùng dòng trên SAP.
                  api(`/api/orders/${orderId}`).then(async (r) => {
                    if (r.ok) {
                      const j = await r.json()
                      const o = j.order ?? j
                      setEditOrder(toEditData(o))
                      go('ordersNew')
                    }
                  })
                }}
              />
            )}
            {view === 'deliveries' && (
              <DeliveriesListView
                onGoDetail={(id) => { setDetailDeliveryId(id); go('deliveryDetail') }}
                onGoOrderDetail={(orderId) => { setDetailOrderId(orderId); go('orderDetail') }}
                refreshKey={refreshKey}
                canCreate={user.permissions.ordersNew?.create}
                onGoCreate={() => { setEditOrder(null); go('ordersNew') }}
                canCreateDelivery={user.permissions.deliveries?.create}
                onGoNewDelivery={() => { setEditDeliveryId(null); go('deliveryNew') }}
              />
            )}
            {view === 'deliveryNew' && (
              <DeliveryFormView
                deliveryId={editDeliveryId ?? undefined}
                onCancel={() => { setEditDeliveryId(null); go(editDeliveryId ? 'deliveryDetail' : 'deliveries') }}
                onSaved={(id) => {
                  const wasEdit = Boolean(editDeliveryId)
                  setEditDeliveryId(null)
                  setRefreshKey((k) => k + 1)
                  setDetailDeliveryId(id)
                  showToast(
                    wasEdit ? 'Đã cập nhật phiếu giao hàng thành công!' : 'Đã tạo phiếu giao hàng thành công!',
                    'success',
                  )
                  go('deliveryDetail')
                }}
              />
            )}
            {view === 'deliveryDetail' && detailDeliveryId && (
              <DeliveryDetailView
                deliveryId={detailDeliveryId}
                onBack={() => go('deliveries')}
                onGoOrder={(orderId) => { setDetailOrderId(orderId); go('orderDetail') }}
                onCopyTo={(target, sourceId) => copyDocTo(target, 'delivery', sourceId)}
                onEdit={(id) => { setEditDeliveryId(id); go('deliveryNew') }}
                canEditDelivery={user.permissions.deliveries?.edit}
              />
            )}
            {view === 'ordersNew' && (
              <OrderFormView
                editOrder={editOrder}
                userId={user.id}
                prefill={editOrder ? null : assistantDraft}
                onPrefillApplied={() => setAssistantDraft(null)}
                onCancel={() => { setEditOrder(null); go('orders') }}
                onSaved={({ id: orderId, docNum, sapStatus, sapDocNum, sapError }) => {
                  const wasEdit = Boolean(editOrder)
                  setEditOrder(null)
                  let msg = wasEdit
                    ? `Đã cập nhật đơn hàng bán #${docNum} thành công!`
                    : `Đã tạo đơn hàng bán #${docNum} thành công!`
                  if (sapStatus === 'synced') msg += wasEdit
                    ? ` Đã cập nhật chứng từ trên SAP B1${sapDocNum ? ` (DocNum ${sapDocNum})` : ''}.`
                    : ` Đã đẩy sang SAP B1 — DocNum ${sapDocNum}.`
                  else if (sapStatus === 'pending')
                    msg += ` Chưa đẩy được sang SAP B1${sapError ? `: ${sapError}` : ''} — bấm "Đẩy lại" trong danh sách đơn.`
                  else if (!wasEdit) msg += ' (chưa cấu hình SAP B1 — đơn chỉ lưu trên hệ thống này)'
                  showToast(
                    msg,
                    'success',
                    !wasEdit && orderId
                      ? { label: 'Xem đơn vừa tạo', onClick: () => { setDetailOrderId(orderId); go('orderDetail') } }
                      : undefined,
                  )
                  setRefreshKey((k) => k + 1)
                  go('orders')
                }}
              />
            )}
            {/* ===== Phase 1 Sales A/R: Báo giá → Hóa đơn → Ghi có → Trả hàng ===== */}
            {view === 'quotations' && (
              <QuotationsListView
                user={user}
                refreshKey={refreshKey}
                onGoDetail={(id) => { setDetailQuotationId(id); go('quotationDetail') }}
                onGoNew={() => { setEditQuotationId(null); setQuotationSource(null); go('quotationNew') }}
              />
            )}
            {view === 'quotationNew' && (
              <QuotationFormView
                initialId={editQuotationId ?? undefined}
                sourceType={quotationSource?.type}
                sourceId={quotationSource?.id}
                onBack={() => { setEditQuotationId(null); setQuotationSource(null); go('quotations') }}
                onSaved={() => { setEditQuotationId(null); setQuotationSource(null); setRefreshKey((k) => k + 1); go('quotations') }}
              />
            )}
            {view === 'quotationDetail' && detailQuotationId && (
              <QuotationDetailView
                id={detailQuotationId}
                onBack={() => go('quotations')}
                onEdit={(id) => { setEditQuotationId(id); setQuotationSource(null); go('quotationNew') }}
                onCopyTo={(target, sourceId) => copyDocTo(target, 'quotation', sourceId)}
              />
            )}
            {view === 'invoices' && (
              <InvoicesListView
                user={user}
                refreshKey={refreshKey}
                onGoDetail={(id) => { setDetailInvoiceId(id); go('invoiceDetail') }}
                onGoNew={() => { setEditInvoiceId(null); setInvoiceSource(null); go('invoiceNew') }}
              />
            )}
            {view === 'invoiceNew' && (
              <InvoiceFormView
                initialId={editInvoiceId ?? undefined}
                sourceType={invoiceSource?.type}
                sourceId={invoiceSource?.id}
                onBack={() => { setEditInvoiceId(null); setInvoiceSource(null); go('invoices') }}
                onSaved={() => { setEditInvoiceId(null); setInvoiceSource(null); setRefreshKey((k) => k + 1); go('invoices') }}
              />
            )}
            {view === 'invoiceDetail' && detailInvoiceId && (
              <InvoiceDetailView
                id={detailInvoiceId}
                onBack={() => go('invoices')}
                onEdit={(id) => { setEditInvoiceId(id); setInvoiceSource(null); go('invoiceNew') }}
                onCopyTo={(target, sourceId) => copyDocTo(target, 'invoice', sourceId)}
              />
            )}
            {view === 'creditMemos' && (
              <CreditMemosListView
                user={user}
                refreshKey={refreshKey}
                onGoDetail={(id) => { setDetailCreditMemoId(id); go('creditMemoDetail') }}
                onGoNew={() => { setEditCreditMemoId(null); setCreditMemoSource(null); go('creditMemoNew') }}
              />
            )}
            {view === 'creditMemoNew' && (
              <CreditMemoFormView
                initialId={editCreditMemoId ?? undefined}
                sourceType={creditMemoSource?.type}
                sourceId={creditMemoSource?.id}
                onBack={() => { setEditCreditMemoId(null); setCreditMemoSource(null); go('creditMemos') }}
                onSaved={() => { setEditCreditMemoId(null); setCreditMemoSource(null); setRefreshKey((k) => k + 1); go('creditMemos') }}
              />
            )}
            {view === 'creditMemoDetail' && detailCreditMemoId && (
              <CreditMemoDetailView
                id={detailCreditMemoId}
                onBack={() => go('creditMemos')}
                onEdit={(id) => { setEditCreditMemoId(id); setCreditMemoSource(null); go('creditMemoNew') }}
                onCopyTo={(target, sourceId) => copyDocTo(target, 'creditMemo', sourceId)}
              />
            )}
            {view === 'returns' && (
              <ReturnsListView
                user={user}
                refreshKey={refreshKey}
                onGoDetail={(id) => { setDetailReturnId(id); go('returnDetail') }}
                onGoNew={() => { setEditReturnId(null); setReturnSource(null); go('returnNew') }}
              />
            )}
            {view === 'returnNew' && (
              <ReturnFormView
                initialId={editReturnId ?? undefined}
                sourceType={returnSource?.type}
                sourceId={returnSource?.id}
                onBack={() => { setEditReturnId(null); setReturnSource(null); go('returns') }}
                onSaved={() => { setEditReturnId(null); setReturnSource(null); setRefreshKey((k) => k + 1); go('returns') }}
              />
            )}
            {view === 'returnDetail' && detailReturnId && (
              <ReturnDetailView
                id={detailReturnId}
                onBack={() => go('returns')}
                onEdit={(id) => { setEditReturnId(id); setReturnSource(null); go('returnNew') }}
                onCopyTo={(target, sourceId) => copyDocTo(target, 'return', sourceId)}
              />
            )}
            {/* ===== Phase 2 — Hóa đơn đặt cọc phải thu ===== */}
            {view === 'downPayments' && (
              <DownPaymentsListView
                user={user}
                refreshKey={refreshKey}
                onGoDetail={(id) => { setDetailDownPaymentId(id); go('downPaymentDetail') }}
                onGoNew={() => { setEditDownPaymentId(null); setDownPaymentSource(null); go('downPaymentNew') }}
              />
            )}
            {view === 'downPaymentNew' && (
              <DownPaymentFormView
                initialId={editDownPaymentId ?? undefined}
                sourceType={downPaymentSource?.type}
                sourceId={downPaymentSource?.id}
                onBack={() => { setEditDownPaymentId(null); setDownPaymentSource(null); go('downPayments') }}
                onSaved={() => { setEditDownPaymentId(null); setDownPaymentSource(null); setRefreshKey((k) => k + 1); go('downPayments') }}
              />
            )}
            {view === 'downPaymentDetail' && detailDownPaymentId && (
              <DownPaymentDetailView
                id={detailDownPaymentId}
                onBack={() => go('downPayments')}
                onEdit={(id) => { setEditDownPaymentId(id); setDownPaymentSource(null); go('downPaymentNew') }}
                onCopyTo={(target, sourceId) => copyDocTo(target, 'downPayment', sourceId)}
              />
            )}
            {/* ===== Phase 3 — Báo cáo ===== */}
            {view === 'salesReport' && <SalesReportView />}
            {view === 'arAgingReport' && <ArAgingReportView />}
            {view === 'users' && <UsersView user={user} />}
            {view === 'settings' && <SettingsView canEdit={user.permissions.settings?.edit} />}
            {view === 'sapAudit' && <SapAuditView />}
            {view === 'items' && <ItemsSyncView key={`items-${prefillFor('items') ?? ''}`} initialQuery={prefillFor('items')} />}
            {view === 'vatGroups' && <VatGroupsSyncView />}
            {view === 'partners' && <PartnersSyncView key={`partners-${prefillFor('partners') ?? ''}`} initialQuery={prefillFor('partners')} />}
            {view === 'salesPersons' && <SalesPersonsSyncView />}
            {view === 'paymentTerms' && <PaymentTermsSyncView />}
            {view === 'roles' && <RolesView user={user} onGoUsers={() => go('users')} />}
            {view === 'excelTemplates' && <ExcelTemplatesView />}
            {view === 'bomImport' && <BomImportView user={user} />}
          </div>
        </main>
        {(user.permissions.orders?.view || user.permissions.ordersNew?.create) && (
          <AssistantChat
            onOpenDraft={(d) => {
              if (!user.permissions.ordersNew?.create) return
              setEditOrder(null)
              setAssistantDraft({ ...d, nonce: Date.now() })
              go('ordersNew')
            }}
          />
        )}
      </div>

      {/* ===== Bottom tab bar (mobile) ===== */}
      <nav className="fm-bottomnav" aria-label="Menu nhanh dưới màn hình">
        {menu.slice(0, 4).map((m) => (
          <button
            key={m.key}
            className={`fm-bottomnav__item${navView === m.key ? ' is-active' : ''}`}
            aria-current={navView === m.key ? 'page' : undefined}
            onClick={() => go(m.key)}
          >
            {m.icon}
            <span>{m.short}</span>
          </button>
        ))}
        <button
          className={`fm-bottomnav__item${navView !== 'dashboard' && !menu.slice(0, 4).some((m) => m.key === navView) ? ' is-active' : ''}`}
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
        />
      )}

      {/* Toast */}
      {toasts.length > 0 && (
        <div className="fm-toast-host">
          {toasts.map((toast) => (
            <div key={toast.id} role={toast.type === 'error' ? 'alert' : 'status'} className={`fm-alert fm-alert--${toast.type}`} style={{ margin: 0, minWidth: 260, maxWidth: 420, pointerEvents: 'auto', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <b>{toast.type === 'success' ? 'Hoàn tất' : toast.type === 'warning' ? 'Lưu ý' : 'Lỗi'}</b>{' '}{toast.msg}
                {toast.action && (
                  <button
                    type="button"
                    className="fm-toast__action"
                    onClick={() => { dismissToast(toast.id); toast.action!.onClick() }}
                  >
                    {toast.action.label}<ArrowRight size={14} aria-hidden />
                  </button>
                )}
              </div>
              <button type="button" className="fm-icon-btn fm-icon-btn--sm" aria-label="Đóng thông báo" onClick={() => dismissToast(toast.id)}>
                <CloseIcon size={14} />
              </button>
            </div>
          ))}
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
