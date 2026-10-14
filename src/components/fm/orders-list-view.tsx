'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Filter, Plus, RotateCcw, Trash2, LockOpen, Search, Inbox, RefreshCw, Pencil, Download, Copy, Printer, Mail, BookmarkPlus, MoreVertical, X } from 'lucide-react'
import { formatVND, formatDateVN, formatNum, isOverdue, isDueSoon, daysOverdue, daysUntilDue } from '@/lib/fm-shared'
import type { SessionUser } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import type { EditOrderData } from './order-form-view'
import { toEditData } from './order-form-view'
import PageHeader from './page-header'
import { Network } from 'lucide-react'
import RelMapModal from './relmap-modal'
import { useFocusTrap } from './use-focus-trap'

interface Line {
  id: string
  lineNum: number
  itemCode: string
  itemName: string
  uom: string
  warehouseCode?: string
  quantity: number
  unitPrice: number
  lineTotal: number
  discPct: number
  discAmt: number
  vatPct: number
  vatAmt: number
  grandTotal: number
  taxCode?: string
}
interface Order {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks: string | null
  totalBeforeDisc: number
  discountAmt: number
  /** Chiết khấu ĐẦU CHỨNG TỪ (% + tiền sau phân bổ) — đơn local lưu sẵn, đơn SAP tự tính */
  headerDiscPct?: number
  headerDiscAmt?: number
  vatAmt: number
  grandTotal: number
  createdBy: string
  // Đồng bộ SAP B1 (POST /Orders)
  sapDocEntry?: number | null
  sapDocNum?: number | null
  sapSyncStatus?: string // none | pending | synced
  sapSyncError?: string | null
  sapSyncedAt?: string | null
  /** 'sap' = lấy trực tiếp từ SAP B1 (không xóa/đóng được), 'local' = đơn local */
  source?: string
  /** id bản ghi local tương ứng (đơn SAP có bản ghi local → SỬA được) */
  localId?: string | null
  /** Optimistic locking version */
  version?: number
  lines: Line[]
}

interface Props {
  user: SessionUser
  onGoCreate: () => void
  /** Mở form SỬA đơn đang Open */
  onGoEdit: (data: EditOrderData) => void
  /** Mở form TẠO MỚI với dữ liệu từ đơn có sẵn (nhân bản) */
  onGoDuplicate: (data: EditOrderData) => void
  /** Mở trang chi tiết đơn */
  onGoDetail: (orderId: string) => void
  /** Mở trang chi tiết delivery (từ Relationship Map) */
  onGoDelivery?: (deliveryId: string) => void
  refreshKey: number
}

/** Chip trạng thái đẩy đơn sang SAP B1 — đơn 'pending' bấm vào là đẩy lại */
function sapChip(o: Order, canSync: boolean, syncing: boolean, onSync: () => void) {
  if (o.sapSyncStatus === 'synced') {
    return (
      <span
        className="fm-chip fm-chip--sap"
        title={`DocEntry ${o.sapDocEntry ?? '—'}${o.sapSyncedAt ? ` · đồng bộ lúc ${formatDateVN(o.sapSyncedAt)}` : ''}`}
      >
        SAP #{o.sapDocNum ?? '?'}
      </span>
    )
  }
  if (o.sapSyncStatus === 'pending') {
    if (!canSync) {
      return (
        <span className="fm-chip fm-chip--pending" title={o.sapSyncError ?? 'Chưa đẩy được sang SAP B1'}>
          Chưa đẩy
        </span>
      )
    }
    return (
      <button
        type="button"
        className="fm-chip fm-chip--pending fm-chip--btn"
        title={o.sapSyncError ? `Đẩy lại sang SAP B1 — lỗi trước đó: ${o.sapSyncError}` : 'Đẩy lại sang SAP B1'}
        disabled={syncing}
        onClick={(e) => {
          e.stopPropagation()
          onSync()
        }}
        // Chặn keydown bubble lên hàng/card cha (tránh mở chi tiết khi nhấn Enter trên nút)
        onKeyDown={(e) => e.stopPropagation()}
      >
        <RefreshCw size={14} style={{ flex: 'none' }} />
        {syncing ? 'Đang đẩy…' : 'Đẩy lại'}
      </button>
    )
  }
  return (
    <span className="fm-chip fm-chip--closed" title="Chưa cấu hình SAP B1 — đơn chỉ lưu local">
      —
    </span>
  )
}

/** Bottom-sheet thao tác trên card mobile: dùng pattern fm-backdrop + fm-modal
 *  (tự thành bottom-sheet ở ≤640px), focus trap + trả focus về nút ⋯ khi đóng */
function OrderSheet({ order, onClose, onOpenRelMap, canDuplicate, onDuplicate }: {
  order: Order
  onClose: () => void
  onOpenRelMap: (o: Order) => void
  /** Nhân bản đơn hàng từ bottom-sheet — chỉ hiện khi user có quyền tạo đơn */
  canDuplicate: boolean
  onDuplicate: () => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose)
  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div
        ref={trapRef}
        className="fm-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Thao tác đơn hàng #${order.docNum}`}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 420 }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Đơn hàng #{order.docNum}</h3>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={onClose} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--fm-text-2)', marginBottom: 10 }}>{order.cardName}</div>
        <div role="menu" aria-label={`Thao tác đơn hàng #${order.docNum}`}>
          {canDuplicate && (
            <button
              type="button"
              role="menuitem"
              className="fm-sheet__item"
              onClick={onDuplicate}
            >
              <Copy size={18} /> Nhân bản đơn hàng
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="fm-sheet__item"
            onClick={() => onOpenRelMap(order)}
          >
            <Network size={18} /> Sơ đồ liên kết
          </button>
        </div>
      </div>
    </div>
  )
}

export default function OrdersListView({ user, onGoCreate, onGoEdit, onGoDuplicate, onGoDetail, onGoDelivery, refreshKey }: Props) {
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(8)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)

  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  /** Lọc nhanh theo hạn giao: '' | 'overdue' (quá hạn) | 'dueSoon' (sắp đến hạn 3 ngày) */
  const [dueFilter, setDueFilter] = useState<'' | 'overdue' | 'dueSoon'>('')

  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [source, setSource] = useState('')
  const [sapWarn, setSapWarn] = useState('')

  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    // Guard chống race: filter đổi nhanh → response cũ về sau phải bị bỏ,
    // không được đè lên dữ liệu mới
    const seq = ++loadSeq.current
    try {
      const sp = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (q) sp.set('q', q)
      if (status) sp.set('status', status)
      if (from) sp.set('from', from)
      if (to) sp.set('to', to)
      if (dueFilter) sp.set('due', dueFilter)
      const res = await api(`/api/orders?${sp.toString()}`)
      if (seq !== loadSeq.current) return
      if (res.status === 401) { window.location.reload(); return }
      let json: { data?: unknown[]; total?: number; totalPages?: number; source?: string; warning?: string; error?: string }
      try {
        const text = await res.text()
        json = text ? JSON.parse(text) : {}
      } catch {
        json = {}
      }
      if (!res.ok) {
        setAlert({ type: 'error', msg: json.error ?? `Tải danh sách đơn thất bại (HTTP ${res.status})` })
        setOrders([])
        setTotal(0)
        setTotalPages(1)
        return
      }
      setOrders((json.data as never[]) ?? [])
      setTotal(json.total ?? 0)
      setTotalPages(json.totalPages ?? 1)
      setSource(json.source ?? '')
      setSapWarn(json.warning ?? '')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [page, pageSize, q, status, from, to, dueFilter])

  useEffect(() => { load() }, [load, refreshKey])

  const resetFilter = () => { setQ(''); setStatus(''); setFrom(''); setTo(''); setDueFilter(''); setPage(1) }

  const openDetail = (o: Order) => {
    // Chi tiết đơn mở dạng full-page (đồng nhất với màn tạo mới), không dùng modal
    onGoDetail(o.id)
  }

  const deleteOrder = async (o: Order) => {
    if (!window.confirm(`Xóa đơn hàng #${o.docNum} — ${o.cardName}? Hành động không thể hoàn tác.`)) return
    // Optimistic UI: gỡ dòng khỏi danh sách ngay, rollback nếu API lỗi
    const prevOrders = orders
    setOrders((os) => os.filter((x) => x.id !== o.id))
    const res = await api(`/api/orders/${o.id}`, { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setOrders(prevOrders)
      setAlert({ type: 'error', msg: json.error ?? 'Không thể xóa đơn hàng' })
      return
    }
    setAlert({ type: 'success', msg: `Đã xóa đơn hàng #${o.docNum}` })
    load()
  }

  /** Xuất Excel danh sách đơn hàng theo bộ lọc hiện tại */
  const exportExcel = async () => {
    if (orders.length === 0) {
      setAlert({ type: 'error', msg: 'Không có đơn hàng nào để xuất' })
      return
    }
    // B4: lazy load xlsx chỉ khi xuất
    const XLSX = await import('xlsx')
    const statusLabel = (s: string) => (s === 'Open' ? 'Mở' : s === 'Closed' ? 'Đóng' : s === 'Cancelled' ? 'Hủy' : s)

    // Sheet 1: Danh sách đơn hàng
    const headerRows = orders.map((o, i) => ({
      'STT': i + 1,
      'Số CT': o.docNum,
      'Ngày CT': formatDateVN(o.docDate),
      'Ngày giao': formatDateVN(o.docDueDate),
      'Mã KH': o.cardCode,
      'Tên khách hàng': o.cardName,
      'Trạng thái': statusLabel(o.status),
      'Tổng tiền': o.grandTotal,
      'Ghi chú': o.remarks ?? '',
    }))
    const ws1 = XLSX.utils.json_to_sheet(headerRows)

    // Sheet 2: Chi tiết dòng hàng
    const detailRows: Record<string, string | number>[] = []
    for (const o of orders) {
      for (const l of o.lines) {
        detailRows.push({
          'Số CT': o.docNum,
          'Mã hàng': l.itemCode,
          'Tên hàng': l.itemName,
          'Số lượng': l.quantity,
          'Đơn vị': l.uom,
          'Đơn giá': l.unitPrice,
          'CK%': l.discPct,
          'VAT%': l.vatPct,
          'Thành tiền': l.grandTotal,
        })
      }
    }
    const ws2 = XLSX.utils.json_to_sheet(detailRows)

    // Style header: in đậm + nền vàng nhạt
    const headerStyle = { font: { bold: true }, fill: { fgColor: { rgb: 'FFFDE7' } } }
    for (const ws of [ws1, ws2]) {
      const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c })]
        if (cell) cell.s = headerStyle
      }
    }

    // Độ rộng cột
    ws1['!cols'] = [
      { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 32 }, { wch: 12 }, { wch: 16 }, { wch: 30 },
    ]
    ws2['!cols'] = [
      { wch: 10 }, { wch: 16 }, { wch: 34 }, { wch: 10 }, { wch: 10 },
      { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 16 },
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws1, 'Don hang')
    XLSX.utils.book_append_sheet(wb, ws2, 'Chi tiet')

    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const fname = `DonHang_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.xlsx`
    XLSX.writeFile(wb, fname)
    setAlert({ type: 'success', msg: `Đã xuất ${orders.length} đơn hàng ra file ${fname}` })
  }

  const canEdit = user.permissions.orders?.edit
  const canDelete = user.permissions.orders?.delete
  const canCreate = user.permissions.ordersNew?.create
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; order: Order } | null>(null)
  const [relMapOrder, setRelMapOrder] = useState<{ id: string; docNum: number } | null>(null)
  /** Bottom-sheet thao tác trên card mobile (#8) */
  const [sheetOrder, setSheetOrder] = useState<Order | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** Phần tử đã mở context menu (dòng) — trả focus về khi đóng bằng Escape */
  const openerRef = useRef<HTMLElement | null>(null)

  /** Mở context menu tại tọa độ cho trước (kẹp trong viewport) */
  const openCtxMenu = (order: Order, x: number, y: number) => {
    setCtxMenu({
      x: Math.min(Math.max(x, 8), window.innerWidth - 220),
      y: Math.min(Math.max(y, 8), window.innerHeight - 80),
      order,
    })
  }

  const closeCtxMenu = (restoreFocus: boolean) => {
    setCtxMenu(null)
    if (restoreFocus) openerRef.current?.focus({ preventScroll: true })
  }

  // Mở menu → focus vào menuitem đầu tiên (#7)
  useEffect(() => {
    if (!ctxMenu) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [ctxMenu])

  // Đóng context menu khi bấm ra ngoài hoặc cuộn
  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [ctxMenu])

  /** Đơn này SỬA được không? — mọi đơn Open:
   *  - đơn local → sửa local (+ PATCH SAP nếu đã synced);
   *  - đơn lấy trực tiếp từ SAP B1 → sửa thẳng chứng từ trên SL (PATCH /Orders),
   *    KHÔNG cần bản ghi local tương ứng nữa. Điều kiện: đã tải được dòng hàng. */
  const editable = (o: Order): boolean =>
    Boolean(canEdit && o.status === 'Open' && o.lines.length > 0 && (o.source !== 'sap' || o.sapDocEntry != null))

  // Dữ liệu cho form sửa — dùng hàm toEditData DÙNG CHUNG (map dbId/sapLineNum
  // để PUT không append trùng dòng trên SAP B1)

  // Đẩy lại đơn sang SAP B1 (đơn đang 'pending' sau khi lưu)
  const syncOrder = async (o: Order) => {
    // Đẩy SAP tạo chứng từ THẬT — xác nhận trước 1-click
    if (!window.confirm(`Đẩy lại Sale Order #${o.docNum} sang SAP B1?\nThao tác tạo chứng từ thật trên SAP và không thể hoàn tác tự động.`)) return
    setSyncingId(o.id)
    try {
      const res = await api(`/api/orders/${o.id}/sync`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        setAlert({ type: 'error', msg: json.error ?? json.sap?.error ?? 'Không thể đẩy đơn sang SAP B1' })
      } else {
        setAlert({ type: 'success', msg: `Đã đẩy đơn #${o.docNum} sang SAP B1 — DocNum ${json.order?.sapDocNum}` })
      }
      load()
    } finally {
      setSyncingId(null)
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Danh sách đơn hàng']}
        title="Danh sách Sale Order"
        badge="Cập nhật tức thời"
        actions={<>
          <button className="fm-btn fm-btn--secondary" onClick={() => load()}><RefreshCw size={14} /> Tải lại</button>
          <button className="fm-btn fm-btn--secondary" onClick={exportExcel}><Download size={14} /> Xuất Excel</button>
        </>}
      />
      {alert && (
        <div className={`fm-alert ${alert.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={alert.type === 'error' ? 'alert' : 'status'}>
          <div><b>{alert.type === 'success' ? 'Thành công' : 'Lỗi'}</b>{alert.msg}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <div className="fm-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'flex-end', marginBottom: 14 }}>
          {canCreate && (
            <button className="fm-btn fm-btn--primary" onClick={onGoCreate}>
              <Plus size={16} style={{ verticalAlign: -2, marginRight: 4 }} /> Tạo đơn hàng
            </button>
          )}
        </div>

        {/* Thanh lọc */}
        {/* Lọc nhanh theo hạn giao */}
        <div className="fm-quickfilter" role="group" aria-label="Lọc nhanh theo hạn giao hàng">
          {([
            { key: '', label: 'Tất cả' },
            { key: 'overdue', label: 'Quá hạn giao' },
            { key: 'dueSoon', label: 'Sắp đến hạn (3 ngày)' },
          ] as const).map((f) => (
            <button
              key={f.key}
              type="button"
              className={`fm-btn fm-btn--sm ${dueFilter === f.key ? 'fm-btn--primary' : 'fm-btn--secondary'}`}
              onClick={() => { setDueFilter(f.key); setPage(1) }}
              aria-pressed={dueFilter === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="fm-filterbar">
          <div style={{ position: 'relative' }} data-search>
            <input
              className="fm-input"
              style={{ paddingLeft: 32 }}
              placeholder="Số CT, mã/tên khách hàng…"
              aria-label="Tìm kiếm đơn hàng theo số chứng từ, mã hoặc tên khách hàng"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1) }}
            />
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} />
          </div>
          <select className="fm-select" aria-label="Lọc theo trạng thái đơn hàng" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">Tất cả trạng thái</option>
            <option value="Open">Open</option>
            <option value="Closed">Closed</option>
            <option value="Cancelled">Đã hủy</option>
          </select>
          <input type="date" className="fm-datepicker" title="Từ ngày" aria-label="Lọc từ ngày" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} />
          <input type="date" className="fm-datepicker" title="Đến ngày" aria-label="Lọc đến ngày" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} />
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={resetFilter}>
            <RotateCcw size={14} style={{ verticalAlign: -2, marginRight: 4 }} /> Đặt lại
          </button>
          <div className="fm-filterbar__spacer" />
          <span className="fm-chip fm-chip--role"><Filter size={14} style={{ verticalAlign: -1, marginRight: 3 }} />{total} kết quả</span>
        </div>

        {/* Cảnh báo SAP lỗi khi load danh sách */}
        {sapWarn && (
          <div className="fm-hint" style={{ color: 'var(--fm-red)', marginBottom: 8 }}>⚠ {sapWarn}</div>
        )}

        {/* Bảng dữ liệu */}
        {loading ? (
          <div aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="fm-skeleton fm-skeleton--row" />
            ))}
          </div>
        ) : orders.length === 0 ? (
          <div className="fm-empty">
            <Inbox />
            Không có đơn hàng phù hợp bộ lọc
            {canCreate && (
              <button type="button" className="fm-btn fm-btn--primary" style={{ marginTop: 10 }} onClick={onGoCreate}>
                <Plus size={16} /> Tạo đơn hàng
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Bảng (desktop) */}
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Số CT</th>
                    <th>Mã KH</th>
                    <th>Khách hàng</th>
                    <th>Ngày CT</th>
                    <th>Hạn giao</th>
                    <th>Trạng thái</th>
                    <th>SAP B1</th>
                    <th className="fm-num">Tổng trước VAT</th>
                    <th className="fm-num">Tổng tiền</th>
                    <th><span className="fm-sr-only">Thao tác</span></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      style={{ cursor: 'pointer' }}
                      title="Bấm để xem chi tiết — Chuột phải để xem sơ đồ liên kết"
                      tabIndex={0}
                      aria-label={`Xem chi tiết đơn hàng #${o.docNum} — ${o.cardName}`}
                      onClick={() => openDetail(o)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openerRef.current = e.currentTarget
                        openCtxMenu(o, e.clientX, e.clientY)
                      }}
                      onKeyDown={(e) => {
                        // Shift+F10: mở context menu tại dòng đang focus (tương đương right-click)
                        if (e.shiftKey && e.key === 'F10') {
                          e.preventDefault()
                          e.stopPropagation()
                          openerRef.current = e.currentTarget
                          const r = e.currentTarget.getBoundingClientRect()
                          openCtxMenu(o, r.left + 80, r.bottom - 20)
                          return
                        }
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openDetail(o)
                        }
                      }}
                    >
                      <th scope="row"><b>#{o.docNum}</b></th>
                      <td>{o.cardCode}</td>
                      <td>{o.cardName}</td>
                      <td>{formatDateVN(o.docDate)}</td>
                      <td>{formatDateVN(o.docDueDate)}</td>
                      <td>
                        {isOverdue(o.docDueDate, o.status) ? (
                          <span className="fm-chip fm-chip--overdue">Quá hạn {daysOverdue(o.docDueDate)} ngày</span>
                        ) : isDueSoon(o.docDueDate, o.status) ? (
                          <span className="fm-chip fm-chip--warn">Còn {daysUntilDue(o.docDueDate)} ngày</span>
                        ) : o.status === 'Open' ? (
                          <span className="fm-chip fm-chip--open">Open</span>
                        ) : o.status === 'Cancelled' ? (
                          <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
                        ) : (
                          <span className="fm-chip fm-chip--closed">Closed</span>
                        )}
                      </td>
                      <td>{sapChip(o, canCreate, syncingId === o.id, () => syncOrder(o))}</td>
                      <td className="fm-num">{formatVND(o.totalBeforeDisc - o.discountAmt - (o.headerDiscAmt ?? 0))}</td>
                      <td className="fm-num"><b>{formatVND(o.grandTotal)}</b></td>
                      <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        {editable(o) && (
                          <button className="fm-icon-btn" title="Sửa đơn hàng" aria-label={`Sửa đơn hàng ${o.docNum}`} onClick={() => onGoEdit(toEditData(o))}>
                            <Pencil size={14} />
                          </button>
                        )}
                        {canCreate && (
                          <button className="fm-icon-btn" title="Nhân bản đơn hàng" aria-label="Nhân bản đơn hàng" onClick={() => onGoDuplicate({ ...toEditData(o), id: undefined })}>
                            <Copy size={14} />
                          </button>
                        )}
                        {canDelete && o.source !== 'sap' && (
                          <button className="fm-row-del" title="Xóa đơn hàng" aria-label="Xóa đơn hàng" onClick={() => deleteOrder(o)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Danh sách card (mobile) */}
            <div className="fm-only-mobile">
              {orders.map((o) => (
                <div
                  key={o.id}
                  className="fm-ocard"
                  role="button"
                  tabIndex={0}
                  aria-label={`Xem chi tiết đơn hàng #${o.docNum} — ${o.cardName}`}
                  onClick={() => openDetail(o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail(o)
                    }
                  }}
                >
                  <div className="fm-ocard__top">
                    <span className="fm-ocard__num">#{o.docNum}</span>
                    {isOverdue(o.docDueDate, o.status) ? (
                      <span className="fm-chip fm-chip--overdue">Quá hạn {daysOverdue(o.docDueDate)} ngày</span>
                    ) : isDueSoon(o.docDueDate, o.status) ? (
                      <span className="fm-chip fm-chip--warn">Còn {daysUntilDue(o.docDueDate)} ngày</span>
                    ) : o.status === 'Open' ? (
                      <span className="fm-chip fm-chip--open">Open</span>
                    ) : o.status === 'Cancelled' ? (
                      <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
                    ) : (
                      <span className="fm-chip fm-chip--closed">Closed</span>
                    )}
                    {sapChip(o, canCreate, syncingId === o.id, () => syncOrder(o))}
                    {/* Nút thao tác thêm (mobile không có right-click) → mở bottom-sheet */}
                    <button
                      type="button"
                      className="fm-ocard__more"
                      aria-label={`Thao tác thêm cho đơn hàng #${o.docNum}`}
                      aria-haspopup="dialog"
                      onClick={(e) => { e.stopPropagation(); setSheetOrder(o) }}
                      // Chặn keydown bubble lên card cha (tránh mở chi tiết khi nhấn Enter trên nút)
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <MoreVertical size={18} />
                    </button>
                  </div>
                  <div>
                    <div className="fm-ocard__name">{o.cardName}</div>
                    <div className="fm-ocard__meta">{o.cardCode}</div>
                  </div>
                  <div className="fm-ocard__meta">
                    Ngày CT {formatDateVN(o.docDate)} · Hạn giao {formatDateVN(o.docDueDate)}
                  </div>
                  <div className="fm-ocard__bottom">
                    <span className="fm-ocard__total">{formatVND(o.grandTotal)}</span>
                    {canDelete && o.source !== 'sap' && (
                      <button
                        className="fm-ocard__del"
                        title="Xóa đơn hàng"
                        aria-label={`Xóa đơn hàng ${o.docNum}`}
                        onClick={(e) => { e.stopPropagation(); deleteOrder(o) }}
                        // Chặn keydown bubble lên card cha (tránh mở chi tiết khi nhấn Enter trên nút Xóa)
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Phân trang */}
            <FmPagination page={page} totalPages={totalPages} onPage={setPage} />
          </>
        )}
      </div>

      {/* Context menu khi right-click / Shift+F10 dòng đơn */}
      {ctxMenu && (
        <div
          ref={menuRef}
          className="fm-ctxmenu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          aria-label={`Thao tác đơn hàng #${ctxMenu.order.docNum}`}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Điều hướng bàn phím trong menu: ↑↓ di chuyển giữa các item, Escape đóng
            const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
            if (e.key === 'Escape') {
              e.preventDefault()
              closeCtxMenu(true)
            } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length > 0) {
              e.preventDefault()
              const idx = items.indexOf(document.activeElement as HTMLElement)
              const next = e.key === 'ArrowDown'
                ? (idx + 1) % items.length
                : (idx - 1 + items.length) % items.length
              items[next].focus()
            }
          }}
          onBlur={(e) => {
            // Tab ra khỏi menu → đóng
            if (!menuRef.current?.contains(e.relatedTarget as Node | null)) setCtxMenu(null)
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setRelMapOrder({ id: ctxMenu.order.id, docNum: ctxMenu.order.docNum }); setCtxMenu(null) }}
          >
            <Network size={16} /> Sơ đồ liên kết
          </button>
        </div>
      )}

      {/* Bottom-sheet thao tác trên card mobile */}
      {sheetOrder && (
        <OrderSheet
          order={sheetOrder}
          onClose={() => setSheetOrder(null)}
          onOpenRelMap={(o) => { setSheetOrder(null); setRelMapOrder({ id: o.id, docNum: o.docNum }) }}
          canDuplicate={canCreate}
          onDuplicate={() => { const o = sheetOrder; setSheetOrder(null); if (o) onGoDuplicate({ ...toEditData(o), id: undefined }) }}
        />
      )}

      {/* Modal Relationship Map */}
      <RelMapModal
        orderId={relMapOrder?.id ?? null}
        orderDocNum={relMapOrder?.docNum ?? null}
        onClose={() => setRelMapOrder(null)}
        onGoOrder={(id) => onGoDetail(id)}
        onGoDelivery={(id) => onGoDelivery?.(id)}
      />

    </div>
  )
}
