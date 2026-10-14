'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useFocusTrap } from './use-focus-trap'
import { ArrowLeft, Pencil, Lock, CloudUpload, Printer, X, Mail, Truck } from 'lucide-react'
import { formatVND, formatDateVN, isOverdue } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import OrderPrintView from './order-print-view'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'

interface OrderLine {
  id: string
  itemCode: string
  itemName: string
  quantity: number
  uom: string
  warehouseCode?: string
  unitPrice: number
  discPct: number
  vatPct: number
  lineTotal: number
  isBomChild?: boolean
  bomGroupKey?: string | null
  bomEditable?: boolean
  bomType?: string
  /** SL còn mở theo SAP (chỉ có với đơn SAP trực tiếp) */
  sapOpenQty?: number
}

interface OrderDeliveryLine {
  sourceOrderLineId: string | null
  quantity: number
}

interface Order {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  remarks?: string
  warehouseCode?: string
  createdBy: string
  version: number
  totalBeforeDisc: number
  discountAmt: number
  headerDiscPct: number
  headerDiscAmt: number
  vatAmt: number
  grandTotal: number
  sapDocEntry?: number | null
  sapDocNum?: number | null
  sapSyncStatus?: string
  sapSyncedAt?: string | null
  lines: OrderLine[]
  deliveries?: Array<{ id: string; docNum: number; docDate: string; status: string; grandTotal: number; sapSyncStatus: string; lines?: OrderDeliveryLine[] }>
}

interface Props {
  orderId: string
  onBack: () => void
  onEdit: (orderId: string) => void
  onGoDelivery?: (deliveryId: string) => void
}

/**
 * Chi tiết đơn hàng dạng full-page (theo thiết kế Stitch màn 04)
 */
export default function OrderDetailView({ orderId, onBack, onEdit, onGoDelivery }: Props) {
  const [order, setOrder] = useState<Order | null>(null)
  const [partner, setPartner] = useState<{ address?: string; contactPerson?: string; contactPhone?: string; email?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showPrint, setShowPrint] = useState(false)
  const [showEmail, setShowEmail] = useState(false)

  // Focus trap + Escape cho dialog print/email
  const printTrapRef = useFocusTrap<HTMLDivElement>(showPrint, () => setShowPrint(false))
  const emailTrapRef = useFocusTrap<HTMLDivElement>(showEmail, () => setShowEmail(false))
  const [emailTo, setEmailTo] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailMessage, setEmailMessage] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailResult, setEmailResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: ReactNode } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

  // Modal "Copy sang Delivery": liệt kê SL đặt / đã giao / còn mở, cho phép
  // chỉnh SL giao đợt này (≤ OpenQty)
  const [showCopyModal, setShowCopyModal] = useState(false)
  const [copyRows, setCopyRows] = useState<Array<{
    orderLineId: string
    itemCode: string
    itemName: string
    ordered: number
    delivered: number
    openQty: number
    qty: number
  }>>([])
  const [copyBusy, setCopyBusy] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyTrapRef = useFocusTrap<HTMLDivElement>(showCopyModal, () => {
    if (!copyBusy) setShowCopyModal(false)
  })

  const doPrint = () => window.print()

  /** SL đã giao từng dòng đơn (trừ phiếu đã hủy) */
  const buildDeliveredByLine = useCallback((o: Order) => {
    const m = new Map<string, number>()
    for (const d of o.deliveries ?? []) {
      if (d.status === 'Cancelled') continue
      for (const dl of d.lines ?? []) {
        if (!dl.sourceOrderLineId) continue
        m.set(dl.sourceOrderLineId, (m.get(dl.sourceOrderLineId) ?? 0) + dl.quantity)
      }
    }
    return m
  }, [])

  /** Các dòng có thể giao (bỏ dòng con BOM) kèm SL còn mở */
  const buildOpenLines = useCallback((o: Order) => {
    const deliveredByLine = buildDeliveredByLine(o)
    const isSapOrder = o.id.startsWith('sap-')
    return o.lines
      .filter((l) => !l.isBomChild)
      .map((l) => {
        const delivered = deliveredByLine.get(l.id) ?? 0
        // Đơn SAP: SL mở theo SAP (RemainingOpenQuantity) trừ SL đã giao local
        const baseOpen = isSapOrder && typeof l.sapOpenQty === 'number' ? l.sapOpenQty : l.quantity
        const openQty = Math.max(0, Math.round((baseOpen - delivered) * 1000) / 1000)
        return { line: l, delivered: Math.round(delivered * 1000) / 1000, openQty }
      })
  }, [buildDeliveredByLine])

  const openCopyModal = () => {
    if (!order) return
    const rows = buildOpenLines(order)
      .filter((x) => x.openQty > 0)
      .map((x) => ({
        orderLineId: x.line.id,
        itemCode: x.line.itemCode,
        itemName: x.line.itemName,
        ordered: x.line.quantity,
        delivered: x.delivered,
        openQty: x.openQty,
        qty: x.openQty,
      }))
    setCopyRows(rows)
    setCopyError(null)
    setShowCopyModal(true)
  }

  const setCopyRowQty = (orderLineId: string, raw: string) => {
    setCopyRows((rows) => rows.map((r) => {
      if (r.orderLineId !== orderLineId) return r
      const v = parseFloat(raw)
      if (raw.trim() === '' || Number.isNaN(v)) return { ...r, qty: 0 }
      return { ...r, qty: Math.min(r.openQty, Math.max(0, v)) }
    }))
  }

  const doConfirmCopy = async () => {
    if (!order) return
    const chosen = copyRows.filter((r) => r.qty > 0)
    if (chosen.length === 0) {
      setCopyError('Chưa có dòng nào có SL giao > 0')
      return
    }
    setCopyBusy(true)
    setCopyError(null)
    // Timeout + AbortController rõ ràng: nút đã disable khi copyBusy=true,
    // nếu mất mạng giữa chừng response không rõ → KHÔNG báo lỗi khô mà tự
    // tải lại đơn (phiếu có thể đã được tạo) để người dùng kiểm chứng.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60_000)
    try {
      const r = await api('/api/deliveries/from-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          lines: chosen.map((x) => ({ sourceOrderLineId: x.orderLineId, quantity: x.qty })),
        }),
        signal: ctrl.signal,
        timeoutMs: 60_000,
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setShowCopyModal(false)
        const docNum = j.delivery?.docNum
        const deliveryId = j.delivery?.id
        setActionMsg({
          type: 'success',
          text: (
            <>
              Đã tạo phiếu giao hàng #{docNum} từ đơn này.
              {' '}
              {onGoDelivery && deliveryId && (
                <button
                  type="button"
                  className="fm-link"
                  onClick={() => onGoDelivery(deliveryId)}
                  style={{ fontWeight: 700 }}
                >
                  Xem phiếu #{docNum}
                </button>
              )}
            </>
          ),
        })
        // Tải lại để cập nhật Relationship Map
        const sig = { cancelled: false }
        await loadOrder(sig)
      } else {
        setCopyError(j.error ?? 'Tạo phiếu giao hàng thất bại')
      }
    } catch {
      // Network error / timeout: kết quả không rõ (phiếu CÓ THỂ đã được tạo
      // trên server) → tự tải lại đơn để Relationship Map hiện phiếu nếu có,
      // thay vì báo "không kết nối" khô khiến người dùng bấm tạo trùng.
      await loadOrder({ cancelled: false })
      setCopyError('Mất kết nối khi tạo phiếu — đã tự tải lại đơn hàng. Hãy kiểm tra Relationship Map / danh sách Giao hàng xem phiếu đã được tạo chưa, tránh tạo trùng.')
    } finally {
      clearTimeout(timer)
      setCopyBusy(false)
    }
  }

  const loadOrder = useCallback(async (signal: { cancelled: boolean }) => {
    setLoading(true)
    setActionMsg(null)
    try {
      const r = await api(`/api/orders/${orderId}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j: { order?: Order } & Partial<Order> = await r.json()
      if (signal.cancelled) return
      // API trả về { order } — unwrap để tương thích
      const o: Order = (j.order ?? j) as Order
      setOrder(o)
      setError('')
      // Lấy thông tin địa chỉ/người liên hệ + email
      if (o.cardCode) {
        api(`/api/partners?q=${encodeURIComponent(o.cardCode)}`)
          .then((pr) => (pr.ok ? pr.json() : null))
          .then((pj) => {
            if (signal.cancelled) return
            const p = pj?.items?.find((x: any) => x.cardCode === o.cardCode) ?? pj?.items?.[0]
            if (p) setPartner((cur) => ({ ...cur, address: p.address, contactPerson: p.contactPerson, contactPhone: p.contactPhone }))
          })
          .catch(() => {})
        // Email từ danh mục KH đã đồng bộ (local)
        api(`/api/bpartners/sync?q=${encodeURIComponent(o.cardCode)}&pageSize=5`)
          .then((pr) => (pr.ok ? pr.json() : null))
          .then((pj) => {
            if (signal.cancelled) return
            const p = pj?.data?.find((x: any) => x.cardCode === o.cardCode)
            if (p?.email) setPartner((cur) => ({ ...cur, email: p.email }))
          })
          .catch(() => {})
      }
    } catch {
      if (!signal.cancelled) setError('Không tải được chi tiết đơn hàng')
    } finally {
      if (!signal.cancelled) setLoading(false)
    }
  }, [orderId])

  useEffect(() => {
    const signal = { cancelled: false }
    void loadOrder(signal)
    return () => { signal.cancelled = true }
  }, [loadOrder])

  // Đóng / mở lại đơn hàng
  const toggleClose = () => {
    if (!order || actionBusy) return
    if (order.status === 'Cancelled') {
      setActionMsg({ type: 'error', text: 'Không thể mở lại đơn hàng đã hủy' })
      return
    }
    const next = order.status === 'Open' ? 'Closed' : 'Open'
    const closing = next === 'Closed'
    const run = async () => {
      setConfirmCfg(null)
      setActionBusy(true)
      try {
        const res = await api(`/api/orders/${order.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setActionMsg({ type: 'error', text: json.error ?? 'Không thể cập nhật trạng thái đơn hàng' })
          return
        }
        setActionMsg({ type: 'success', text: closing ? `Đã đóng đơn hàng #${order.docNum}.` : `Đã mở lại đơn hàng #${order.docNum}.` })
        await loadOrder({ cancelled: false })
      } catch {
        setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      } finally {
        setActionBusy(false)
      }
    }
    setConfirmCfg({
      title: closing ? 'Đóng đơn hàng' : 'Mở lại đơn hàng',
      message: closing
        ? `Đóng đơn hàng #${order.docNum}?\nĐơn đã đóng sẽ không sửa được.`
        : `Mở lại đơn hàng #${order.docNum}?`,
      confirmLabel: closing ? 'Đóng đơn' : 'Mở lại',
      tone: closing ? 'warning' : 'primary',
      run: () => void run(),
    })
  }

  // Hủy đơn hàng (chỉ khi Open; đơn đã hủy thì không sửa/copy/đẩy được)
  // Nếu đơn đã đẩy SAP: gọi POST /Orders({docEntry})/Cancel trên Service Layer
  const doCancelOrder = () => {
    if (!order || actionBusy) return
    const msg = order.sapSyncStatus === 'synced'
      ? `Hủy Sale Order #${order.docNum}?\nĐơn đã được đẩy lên SAP B1 — hệ thống sẽ gọi hủy chứng từ trên SAP B1 trước.`
      : `Hủy Sale Order #${order.docNum}?\nĐơn đã hủy sẽ không sửa, không copy delivery và không đẩy SAP được.`
    const run = async () => {
      setConfirmCfg(null)
      setActionBusy(true)
      setActionMsg(null)
      try {
        const res = await api(`/api/orders/${order.id}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: order.version }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.ok) {
          setActionMsg({ type: 'error', text: json.error ?? 'Không thể hủy đơn hàng' })
          return
        }
        setActionMsg({ type: 'success', text: `Đã hủy đơn hàng #${order.docNum}.` })
        await loadOrder({ cancelled: false })
      } catch {
        setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      } finally {
        setActionBusy(false)
      }
    }
    setConfirmCfg({
      title: 'Hủy đơn hàng',
      message: msg,
      confirmLabel: 'Hủy đơn',
      tone: 'danger',
      run: () => void run(),
    })
  }

  // Đóng đơn hàng (chỉ khi Open)
  // Nếu đơn đã đẩy SAP: gọi POST /Orders({docEntry})/Close trên Service Layer
  const doCloseOrder = () => {
    if (!order || actionBusy) return
    const msg = order.sapSyncStatus === 'synced'
      ? `Đóng Sale Order #${order.docNum}?\nĐơn đã được đẩy lên SAP B1 — hệ thống sẽ gọi đóng chứng từ trên SAP B1 trước.`
      : `Đóng Sale Order #${order.docNum}?\nĐơn đã đóng sẽ không sửa được nữa.`
    const run = async () => {
      setConfirmCfg(null)
      setActionBusy(true)
      setActionMsg(null)
      try {
        const res = await api(`/api/orders/${order.id}/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: order.version }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.ok) {
          setActionMsg({ type: 'error', text: json.error ?? 'Không thể đóng đơn hàng' })
          return
        }
        setActionMsg({ type: 'success', text: `Đã đóng đơn hàng #${order.docNum}.` })
        await loadOrder({ cancelled: false })
      } catch {
        setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      } finally {
        setActionBusy(false)
      }
    }
    setConfirmCfg({
      title: 'Đóng đơn hàng',
      message: msg,
      confirmLabel: 'Đóng đơn',
      tone: 'warning',
      run: () => void run(),
    })
  }

  // Đẩy đơn sang SAP B1 ngay
  const syncNow = () => {
    if (!order || actionBusy) return
    // Đẩy SAP tạo chứng từ THẬT — xác nhận trước 1-click
    const run = async () => {
      setConfirmCfg(null)
      setActionBusy(true)
      try {
        const res = await api(`/api/orders/${order.id}/sync`, { method: 'POST' })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.ok) {
          setActionMsg({ type: 'error', text: json.error ?? json.sap?.error ?? 'Không thể đẩy đơn sang SAP B1' })
          return
        }
        setActionMsg({ type: 'success', text: `Đã đẩy đơn #${order.docNum} sang SAP B1 — DocNum ${json.order?.sapDocNum ?? json.sap?.DocNum ?? '?'}.` })
        await loadOrder({ cancelled: false })
      } catch {
        setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      } finally {
        setActionBusy(false)
      }
    }
    setConfirmCfg({
      title: 'Đẩy sang SAP B1',
      message: `Đẩy Sale Order #${order.docNum} sang SAP B1?\nThao tác tạo chứng từ thật trên SAP và không thể hoàn tác tự động.`,
      confirmLabel: 'Đẩy ngay',
      tone: 'primary',
      run: () => void run(),
    })
  }

  const openEmail = () => {
    if (!order) return
    setEmailTo(partner?.email ?? '')
    setEmailSubject(`Phiếu bán hàng SO-${order.docNum} — ${order.cardName}`)
    setEmailMessage('')
    setEmailResult(null)
    setShowEmail(true)
  }

  const doSendEmail = async () => {
    if (!order || emailBusy) return
    setEmailBusy(true)
    setEmailResult(null)
    try {
      const res = await api('/api/orders/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.id,
          toEmail: emailTo.trim(),
          subject: emailSubject.trim(),
          message: emailMessage.trim(),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setEmailResult({ type: 'error', text: json.error ?? 'Gửi email thất bại' })
        return
      }
      setEmailResult({ type: 'success', text: json.message ?? 'Đã gửi email' })
    } catch {
      setEmailResult({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setEmailBusy(false)
    }
  }

  if (loading) {
    return <div className="fm-skeleton" style={{ height: 400 }} />
  }

  if (error || !order) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', 'Chi tiết đơn hàng']} title="Chi tiết đơn hàng" />
        <div className="fm-alert fm-alert--error">{error || 'Không tìm thấy đơn hàng'}</div>
        <button className="fm-btn fm-btn--secondary" onClick={onBack} style={{ marginTop: 12 }}>
          <ArrowLeft size={16} /> Quay lại
        </button>
      </div>
    )
  }

  const overdue = isOverdue(order.docDueDate, order.status)

  // Tổng SL còn mở toàn đơn — để disable nút Copy khi đã giao hết
  const totalOpenQty = buildOpenLines(order).reduce((s, x) => s + x.openQty, 0)
  const copyDisabled = actionBusy || totalOpenQty <= 0

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Danh sách đơn hàng', `Sale Order #${order.docNum}`]}
        title={`Sale Order #${order.docNum}`}
actions={
          <>
            <button className="fm-btn fm-btn--secondary" onClick={onBack}>
              <ArrowLeft size={16} /> Quay lại
            </button>
            <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(true)}>
              <Printer size={16} /> In đơn hàng
            </button>
            <button className="fm-btn fm-btn--secondary" onClick={openEmail}>
              <Mail size={16} /> Gửi email
            </button>
            {order.status === 'Open' && (
              <button className="fm-btn fm-btn--primary" onClick={() => onEdit(order.id)}>
                <Pencil size={16} /> Sửa đơn hàng
              </button>
            )}
            {order.status === 'Open' && (
              <button
                className="fm-btn fm-btn--secondary"
                onClick={openCopyModal}
                disabled={copyDisabled}
                title={totalOpenQty <= 0 ? 'Đơn đã giao hết' : 'Tạo phiếu giao hàng từ các dòng còn mở'}
              >
                <Truck size={16} /> Copy sang Delivery
              </button>
            )}
            {order.status === 'Open' && (
              <button className="fm-btn fm-btn--secondary" onClick={() => void doCloseOrder()} disabled={actionBusy}>
                <Lock size={16} /> Đóng đơn
              </button>
            )}
            {order.status === 'Open' && (
              <button className="fm-btn fm-btn--danger" onClick={() => void doCancelOrder()} disabled={actionBusy}>
                <X size={16} /> Hủy đơn
              </button>
            )}
            {order.status === 'Cancelled' && (
              <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
            )}
          </>
        }
      />

      {order.status === 'Cancelled' && (
        <div className="fm-alert fm-alert--info" style={{ marginBottom: 16 }}>
          Đơn hàng đã bị hủy — không thể sửa, copy sang Delivery hoặc đẩy lên SAP B1.
        </div>
      )}

      {overdue && (
        <div className="fm-alert fm-alert--error" style={{ marginBottom: 16 }}>
          Đơn hàng đã quá hạn giao ({formatDateVN(order.docDueDate)})
        </div>
      )}

      {/* Thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title">Thông tin chung</h2>
        <dl className="fm-view-detail">
          <div><dt>Mã khách hàng</dt><dd>{order.cardCode}</dd></div>
          <div><dt>Tên khách hàng</dt><dd>{order.cardName}</dd></div>
          <div><dt>Địa chỉ</dt><dd>{partner?.address || '—'}</dd></div>
          <div><dt>Người liên hệ</dt><dd>{partner?.contactPerson ? `${partner.contactPerson}${partner.contactPhone ? ` · ${partner.contactPhone}` : ''}` : '—'}</dd></div>
          <div><dt>Ngày chứng từ</dt><dd>{formatDateVN(order.docDate)}</dd></div>
          <div><dt>Ngày giao hàng</dt><dd>{formatDateVN(order.docDueDate)}</dd></div>
          <div><dt>Kho xuất</dt><dd>{order.warehouseCode || '—'}</dd></div>
          <div><dt>Người tạo</dt><dd>{order.createdBy}</dd></div>
          <div><dt>Trạng thái</dt><dd>{order.status === 'Open' ? 'Đang mở' : order.status === 'Cancelled' ? 'Đã hủy' : 'Đã đóng'}</dd></div>
          <div><dt>Chiết khấu đầu chứng từ</dt><dd>{order.headerDiscPct > 0 ? `${order.headerDiscPct}% (${formatVND(order.headerDiscAmt)})` : '—'}</dd></div>
          <div>
            <dt>Đồng bộ SAP B1</dt>
            <dd>
              {order.sapSyncStatus === 'synced' ? (
                <span className="fm-chip fm-chip--sap" title={order.sapSyncedAt ? `Đẩy thành công lúc ${new Date(order.sapSyncedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` : undefined}>
                  Đã đẩy{order.sapDocNum ? ` — DocNum ${order.sapDocNum}` : ''}
                </span>
              ) : order.sapSyncStatus === 'pending' ? (
                <span className="fm-chip fm-chip--overdue">Chờ đẩy / đẩy lỗi</span>
              ) : (
                <span className="fm-chip fm-chip--role">Chưa đẩy</span>
              )}
            </dd>
          </div>
          <div><dt>Ghi chú</dt><dd>{order.remarks || '—'}</dd></div>
        </dl>
      </div>

      {/* Dòng hàng */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title">Hàng hóa & chi tiết</h2>
        <div className="fm-table-wrap">
          <table className="fm-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Mã hàng</th>
                <th>Tên hàng</th>
                <th className="fm-num">SL</th>
                <th>ĐVT</th>
                <th>Kho</th>
                <th className="fm-num">Đơn giá</th>
                <th className="fm-num">CK (%)</th>
                <th className="fm-num">Sau CK</th>
                <th className="fm-num">VAT (%)</th>
                <th className="fm-num">Tiền dòng (sau VAT)</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let stt = 0
                // Chỉ hiển thị dòng con của BOM Template; Production/Assembly ẩn.
                // Ưu tiên bomType thật của cha (từ mirror), fallback bomEditable cho đơn cũ.
                const parentType = new Map(
                  order.lines
                    .filter((l) => !l.isBomChild && l.bomGroupKey)
                    .map((l) => [l.bomGroupKey as string, l.bomType ?? 'none']),
                )
                const visibleLines = order.lines.filter((l) => {
                  if (!l.isBomChild) return true
                  const pt = parentType.get(l.bomGroupKey as string)
                  if (pt === 'production' || pt === 'assembly') return false
                  if (pt === 'template') return true
                  return l.bomEditable !== false
                })
                return visibleLines.map((line, i) => {
                const afterDisc = line.unitPrice * line.quantity * (1 - line.discPct / 100)
                const vatAmt = afterDisc * (line.vatPct / 100)
                const isChild = Boolean(line.isBomChild)
                const isBomParent = !isChild && Boolean(line.bomGroupKey)
                if (!isChild) stt += 1
                return (
                  <tr key={i} className={isChild ? 'is-bom-child' : isBomParent ? 'is-bom-parent' : ''}>
                    <td>{isChild ? '' : stt}</td>
                    <th scope="row">
                      {isChild && <span style={{ color: 'var(--fm-text-3)' }} aria-hidden>└─ </span>}
                      <b>{line.itemCode}</b>
                      {isBomParent && (
                        <span className="fm-chip fm-chip--bom" title="Mặt hàng BOM — các dòng con bên dưới thuộc công thức của mặt hàng này">BOM</span>
                      )}
                    </th>
                    <td>{line.itemName}</td>
                    <td className="fm-num">{line.quantity}</td>
                    <td>{line.uom}</td>
                    <td>{line.warehouseCode || '—'}</td>
                    <td className="fm-num">{formatVND(line.unitPrice)}</td>
                    <td className="fm-num">{line.discPct}%</td>
                    <td className="fm-num">{formatVND(afterDisc)}</td>
                    <td className="fm-num">{line.vatPct}%</td>
                    <td className="fm-num"><b>{formatVND(afterDisc + vatAmt)}</b></td>
                  </tr>
                )
                })
              })()}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>Tổng trước chiết khấu:</td>
                <td className="fm-num">{formatVND(order.totalBeforeDisc)}</td>
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>Chiết khấu các dòng:</td>
                <td className="fm-num">{order.discountAmt > 0 ? `−${formatVND(order.discountAmt)}` : formatVND(0)}</td>
              </tr>
              {order.headerDiscAmt > 0 && (
                <tr>
                  <td colSpan={10} style={{ textAlign: 'right' }}>Chiết khấu đầu chứng từ ({order.headerDiscPct}%):</td>
                  <td className="fm-num">−{formatVND(order.headerDiscAmt)}</td>
                </tr>
              )}
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>Sau chiết khấu:</td>
                <td className="fm-num">{formatVND(order.totalBeforeDisc - order.discountAmt - order.headerDiscAmt)}</td>
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>Thuế VAT các dòng:</td>
                <td className="fm-num">{formatVND(order.vatAmt)}</td>
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}><b>TỔNG CỘNG:</b></td>
                <td className="fm-num"><b>{formatVND(order.grandTotal)}</b></td>
              </tr>
            </tfoot>
          </table>
          {/* Mobile (<=640px): card thay cho bảng 11 cột cuộn ngang */}
          <div className="fm-lcard-list">
            {(() => {
              let stt = 0
              return order.lines.map((line, i) => {
              const afterDisc = line.unitPrice * line.quantity * (1 - line.discPct / 100)
              const vatAmt = afterDisc * (line.vatPct / 100)
              const isChild = Boolean(line.isBomChild)
              if (isChild) return null // dòng con vẽ lồng trong card của cha (bên dưới)
              stt += 1
              const isBomParent = Boolean(line.bomGroupKey)
              // Chỉ liệt kê thành phần khi là BOM Template
              const isTemplate = (line.bomType ?? 'none') === 'template' ||
                ((line.bomType ?? 'none') === 'none' && order.lines.some((l) => l.isBomChild && l.bomGroupKey === line.bomGroupKey && l.bomEditable !== false))
              const children = isBomParent && isTemplate
                ? order.lines.filter((l) => l.isBomChild && l.bomGroupKey === line.bomGroupKey)
                : []
              return (
                <div key={i} className="fm-lcard">
                  <div className="fm-lcard__head">
                    <span className="fm-lcard__num">{stt}</span>
                    <div>
                      <div className="fm-lcard__name">{line.itemName}
                        {isBomParent && <span className="fm-chip fm-chip--bom">BOM</span>}
                      </div>
                      <div className="fm-lcard__code">{line.itemCode} · {line.uom} · Kho {line.warehouseCode || '—'}</div>
                    </div>
                  </div>
                  <div className="fm-lcard__grid">
                    <div><span className="k">SL</span><span className="v">{line.quantity}</span></div>
                    <div><span className="k">Đơn giá</span><span className="v">{formatVND(line.unitPrice)}</span></div>
                    <div><span className="k">CK</span><span className="v">{line.discPct}%</span></div>
                    <div><span className="k">VAT</span><span className="v">{line.vatPct}%</span></div>
                  </div>
                  {children.length > 0 && (
                    <div className="fm-lcard__bom">
                      <div className="fm-lcard__bom-title">Thành phần ({children.length}):</div>
                      {children.map((c, ci) => (
                        <div key={ci} className="fm-lcard__bom-row">
                          <span aria-hidden>└─ </span>{c.itemCode} — {c.itemName} × {c.quantity} {c.uom}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="fm-lcard__total">
                    <span>Thành tiền (sau VAT)</span>
                    <b>{formatVND(afterDisc + vatAmt)}</b>
                  </div>
                </div>
              )
              })
            })()}
          </div>
        </div>
      </div>

      {/* Nút thao tác */}
      {actionMsg && (
        <div className={`fm-alert ${actionMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={actionMsg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12 }}>
          {actionMsg.text}
        </div>
      )}
      {/* Nút thao tác — chỉ giữ các hành động KHÔNG có trên thanh header:
          Đóng/Mở đơn và Đẩy SAP. (Sửa/In/Gửi email đã có ở header → không lặp) */}
      {order.status !== 'Cancelled' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="fm-btn fm-btn--secondary" onClick={toggleClose} disabled={actionBusy}>
            <Lock size={16} /> {order.status === 'Open' ? 'Đóng đơn hàng (Closed)' : 'Mở lại đơn hàng'}
          </button>
          <button className="fm-btn fm-btn--secondary" onClick={syncNow} disabled={actionBusy}>
            <CloudUpload size={16} /> Đẩy sang SAP B1 ngay
          </button>
        </div>
      )}

      {/* Dialog xem trước bản in */}
      {showPrint && (
        <div className="fm-backdrop fm-print-hide" onClick={() => setShowPrint(false)}>
          <div
            ref={printTrapRef}
            className="fm-modal fm-modal--wide fm-print-preview"
            role="dialog"
            aria-modal="true"
            aria-label="Xem trước bản in"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 960 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }} className="fm-print-hide">
              <h3 className="fm-modal__title">Xem trước bản in</h3>
              <button className="fm-icon-btn" onClick={() => setShowPrint(false)} aria-label="Đóng">
                <X size={16} />
              </button>
            </div>
            <OrderPrintView order={order} partner={partner} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }} className="fm-print-hide">
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(false)}>
                Đóng
              </button>
              <button className="fm-btn fm-btn--primary" onClick={doPrint}>
                <Printer size={16} /> In / Xuất PDF
              </button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--fm-text-2)', marginTop: 12 }} className="fm-print-hide">
              Bấm "In / Xuất PDF" rồi chọn máy in hoặc "Save as PDF" trong hộp thoại in của trình duyệt.
            </p>
          </div>
        </div>
      )}

      {/* Dialog gửi email */}
      {showEmail && (
        <div className="fm-backdrop" onClick={() => { if (!emailBusy) setShowEmail(false) }}>
          <div
            ref={emailTrapRef}
            className="fm-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Gửi email đơn hàng"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Mail size={18} /> Gửi email đơn hàng SO-{order.docNum}
              </h3>
              <button className="fm-icon-btn" onClick={() => { if (!emailBusy) setShowEmail(false) }} aria-label="Đóng" disabled={emailBusy}>
                <X size={16} />
              </button>
            </div>

            {emailResult && (
              <div className={`fm-alert ${emailResult.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} style={{ marginBottom: 12 }} role={emailResult.type === 'error' ? 'alert' : 'status'}>
                <div><b>{emailResult.type === 'success' ? 'Thành công' : 'Lỗi'}</b> {emailResult.text}</div>
              </div>
            )}

            <div className="fm-field" style={{ marginBottom: 12 }}>
              <label className="fm-label" htmlFor="fm-email-to">Email người nhận <span className="fm-label__req">*</span></label>
              <input
                id="fm-email-to"
                type="email"
                className="fm-input"
                placeholder="khachhang@example.com"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                disabled={emailBusy}
              />
            </div>
            <div className="fm-field" style={{ marginBottom: 12 }}>
              <label className="fm-label" htmlFor="fm-email-subject">Tiêu đề</label>
              <input
                id="fm-email-subject"
                className="fm-input"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                disabled={emailBusy}
              />
            </div>
            <div className="fm-field" style={{ marginBottom: 16 }}>
              <label className="fm-label" htmlFor="fm-email-message">Lời nhắn</label>
              <textarea
                id="fm-email-message"
                className="fm-input"
                rows={4}
                placeholder="Lời nhắn kèm theo phiếu bán hàng…"
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value)}
                disabled={emailBusy}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowEmail(false)} disabled={emailBusy}>
                Đóng
              </button>
              <button className="fm-btn fm-btn--primary" onClick={doSendEmail} disabled={emailBusy || !emailTo.trim()}>
                <Mail size={16} /> {emailBusy ? 'Đang gửi…' : 'Gửi email'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Dialog xác nhận Copy sang Delivery */}
      {showCopyModal && order && (
        <div className="fm-backdrop" onClick={() => { if (!copyBusy) setShowCopyModal(false) }}>
          <div
            ref={copyTrapRef}
            className="fm-modal fm-modal--wide"
            role="dialog"
            aria-modal="true"
            aria-label={`Copy sang Delivery từ đơn ${order.docNum}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 760 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Truck size={18} /> Copy sang Delivery — Sale Order #{order.docNum}
              </h3>
              <button className="fm-icon-btn" onClick={() => setShowCopyModal(false)} aria-label="Đóng" disabled={copyBusy}>
                <X size={16} />
              </button>
            </div>

            {order.sapSyncStatus !== 'synced' && (
              <div className="fm-alert fm-alert--warning" role="alert" style={{ marginBottom: 12 }}>
                Đơn chưa đẩy SAP — liên kết SO→Delivery trên SAP sẽ mất.
              </div>
            )}

            <p className="fm-hint" style={{ margin: '0 0 10px' }}>
              Chỉ liệt kê các dòng còn SL mở (OpenQty &gt; 0). Điều chỉnh SL giao đợt này nếu không giao hết.
            </p>

            <div className="fm-table-wrap" style={{ marginBottom: 12 }}>
              <table className="fm-table fm-stack-table fm-stack-table--form">
                <thead>
                  <tr>
                    <th>Mã hàng</th>
                    <th>Tên hàng</th>
                    <th className="fm-num">SL đặt</th>
                    <th className="fm-num">Đã giao</th>
                    <th className="fm-num">Còn mở</th>
                    <th className="fm-num">SL giao đợt này</th>
                  </tr>
                </thead>
                <tbody>
                  {copyRows.map((r) => (
                    <tr key={r.orderLineId}>
                      <td data-label="Mã hàng"><b>{r.itemCode}</b></td>
                      <td data-label="Tên hàng">{r.itemName}</td>
                      <td className="fm-num" data-label="SL đặt">{r.ordered}</td>
                      <td className="fm-num" data-label="Đã giao">{r.delivered}</td>
                      <td className="fm-num" data-label="Còn mở"><b>{r.openQty}</b></td>
                      <td className="fm-num" data-label="SL giao đợt này">
                        <input
                          type="number"
                          className="fm-input"
                          style={{ width: 96, textAlign: 'right' }}
                          min={0}
                          max={r.openQty}
                          step="any"
                          value={r.qty}
                          onChange={(e) => setCopyRowQty(r.orderLineId, e.target.value)}
                          aria-label={`SL giao đợt này cho ${r.itemCode} (tối đa ${r.openQty})`}
                          disabled={copyBusy}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'right' }}>Tổng SL giao đợt này</td>
                    <td className="fm-num"><b>{copyRows.reduce((s, r) => s + (Number(r.qty) || 0), 0)}</b></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {copyError && (
              <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>
                {copyError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowCopyModal(false)} disabled={copyBusy}>
                Hủy
              </button>
              <button className="fm-btn fm-btn--primary" onClick={() => void doConfirmCopy()} disabled={copyBusy}>
                <Truck size={16} /> {copyBusy ? 'Đang tạo…' : 'Xác nhận tạo phiếu'}
              </button>
            </div>
          </div>
        </div>
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
