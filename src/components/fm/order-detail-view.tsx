'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useFocusTrap } from './use-focus-trap'
import { ArrowLeft, Pencil, Lock, LockOpen, CloudUpload, Printer, X, Mail, Truck, Receipt, HandCoins } from 'lucide-react'
import { formatDateVN, isOverdue } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import OrderPrintView from './order-print-view'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import { type CopyTarget, docNumLabel } from './sales-doc-shared'
import CopyToMenu from './copy-to-menu'
import { DocInfoCards, DocLinesCard, useDocParty } from './doc-detail-sections'
import SapReconcileDialog, { sapSyncHint } from './sap-reconcile-dialog'

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
  barcode?: string | null
  taxCode?: string | null
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
  /** Phase 2 — Nháp: true = bản nháp chưa có hiệu lực */
  isDraft?: boolean
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
  sapSyncError?: string | null
  sapSyncErrorKind?: string | null
  sapSyncAttempts?: number | null
  sapNextRetryAt?: string | null
  contactPersonCode?: number | null
  lines: OrderLine[]
  deliveries?: Array<{ id: string; docNum: number; docDate: string; status: string; grandTotal: number; sapSyncStatus: string; lines?: OrderDeliveryLine[] }>
  // ---------- B2B / SAP B1 (Đợt 2+3) ----------
  salesPersonCode?: number | null
  paymentGroupCode?: number | null
  shipToCode?: string | null
  billToCode?: string | null
  numAtCard?: string | null
  taxDate?: string | null
  docCurrency?: string | null
  docRate?: number | null
  projectCode?: string | null
  attachmentsJson?: string | null
  reqDate?: string | null
}

interface Props {
  orderId: string
  onBack: () => void
  onEdit: (orderId: string) => void
  onGoDelivery?: (deliveryId: string) => void
  /** Wire ở app-shell: mở form loại đích với sourceType='order' + sourceId (Phase 1 Sales A/R) */
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}

/**
 * Chi tiết đơn hàng dạng full-page (theo thiết kế Stitch màn 04)
 */
export default function OrderDetailView({ orderId, onBack, onEdit, onGoDelivery, onCopyTo }: Props) {
  const [order, setOrder] = useState<Order | null>(null)
  /** Email khách hàng (danh mục KH đã đồng bộ) — điền sẵn khi gửi email */
  const [partner, setPartner] = useState<{ email?: string } | null>(null)
  /** Địa chỉ + danh bạ KH (mirror) — cho bản in: người liên hệ của CHỨNG TỪ, không phải mặc định KH */
  const party = useDocParty(order?.cardCode)
  /** Tên NVBH / ĐKTT (best-effort từ danh mục; 404 → chỉ hiện mã số) */
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
  const [busyAction, setBusyAction] = useState<string | null>(null) // action đang chạy: 'toggle' | 'cancel' | 'close' | 'sync' — chống bấm đúp + hiện text Đang…
  const [showReconcile, setShowReconcile] = useState(false) // dialog đối chiếu SAP (lỗi "không rõ", DB chưa có UDF)

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
                  className="fm-link fm-link--strong"
                  onClick={() => onGoDelivery(deliveryId)}
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
      // Email khách hàng (địa chỉ/người liên hệ hiển thị qua DocInfoCards)
      if (o.cardCode) {
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
      if (!signal.cancelled) setError('Không tải được chi tiết đơn hàng bán')
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
    if (!order || busyAction) return
    if (order.status === 'Cancelled') {
      setActionMsg({ type: 'error', text: 'Không thể mở lại đơn hàng đã hủy' })
      return
    }
    const next = order.status === 'Open' ? 'Closed' : 'Open'
    const closing = next === 'Closed'
    const run = async () => {
      setConfirmCfg(null)
      setBusyAction('toggle')
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
        setBusyAction(null)
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
    if (!order || busyAction) return
    const msg = order.sapSyncStatus === 'synced'
      ? `Hủy đơn hàng bán #${order.docNum}?\nĐơn đã được đẩy lên SAP B1 — hệ thống sẽ gọi hủy chứng từ trên SAP B1 trước.`
      : `Hủy đơn hàng bán #${order.docNum}?\nĐơn đã hủy sẽ không sửa, không sao chép delivery và không đẩy SAP được.`
    const run = async () => {
      setConfirmCfg(null)
      setBusyAction('cancel')
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
        setBusyAction(null)
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
    if (!order || busyAction) return
    const msg = order.sapSyncStatus === 'synced'
      ? `Đóng đơn hàng bán #${order.docNum}?\nĐơn đã được đẩy lên SAP B1 — hệ thống sẽ gọi đóng chứng từ trên SAP B1 trước.`
      : `Đóng đơn hàng bán #${order.docNum}?\nĐơn đã đóng sẽ không sửa được nữa.`
    const run = async () => {
      setConfirmCfg(null)
      setBusyAction('close')
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
        setBusyAction(null)
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
    if (!order || busyAction) return
    // Không rõ SAP đã nhận chưa (DB chưa có UDF) → đối chiếu trước, không đẩy thẳng
    if (order.sapSyncErrorKind === 'reconcile') {
      setShowReconcile(true)
      return
    }
    // Đẩy SAP tạo chứng từ THẬT — xác nhận trước 1-click
    const run = async () => {
      setConfirmCfg(null)
      setBusyAction('sync')
      try {
        const res = await api(`/api/orders/${order.id}/sync`, { method: 'POST' })
        const json = await res.json().catch(() => ({}))
        if (json.code === 'NEEDS_RECONCILE') {
          setShowReconcile(true)
          return
        }
        // loadOrder xoá actionMsg → tải lại trước, đặt thông báo sau
        await loadOrder({ cancelled: false })
        if (!res.ok || !json.ok) {
          setActionMsg({ type: 'error', text: json.error ?? json.sap?.error ?? 'Không thể đẩy đơn sang SAP B1' })
          return
        }
        setActionMsg({ type: 'success', text: `Đã đẩy đơn #${order.docNum} sang SAP B1 — DocNum ${json.order?.sapDocNum ?? json.sap?.DocNum ?? '?'}.` })
      } catch {
        setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      } finally {
        setBusyAction(null)
      }
    }
    setConfirmCfg({
      title: 'Đẩy sang SAP B1',
      message: `Đẩy đơn hàng bán #${order.docNum} sang SAP B1?\nThao tác tạo chứng từ thật trên SAP và không thể hoàn tác tự động.`,
      confirmLabel: 'Đẩy ngay',
      tone: 'primary',
      run: () => void run(),
    })
  }

  const openEmail = () => {
    if (!order) return
    setEmailTo(partner?.email ?? '')
    setEmailSubject(`Đơn hàng bán SO-${order.docNum} — ${order.cardName}`)
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
        <button className="fm-btn fm-btn--secondary fm-mt-3" onClick={onBack}>
          <ArrowLeft size={16} /> Quay lại
        </button>
      </div>
    )
  }

  const overdue = isOverdue(order.docDueDate, order.status)


  // Tổng SL còn mở toàn đơn — để disable nút Copy khi đã giao hết
  const totalOpenQty = buildOpenLines(order).reduce((s, x) => s + x.openQty, 0)
  const copyDisabled = !!busyAction || totalOpenQty <= 0

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', { label: 'Danh sách đơn hàng bán', onNavigate: onBack }, `Đơn hàng bán #${order.docNum}`]}
        title={`Đơn hàng bán #${order.docNum}`}
        actions={
          <>
            <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(true)}>
              <Printer size={16} /> In đơn hàng bán
            </button>
            <button className="fm-btn fm-btn--secondary" onClick={openEmail}>
              <Mail size={16} /> Gửi email
            </button>
            {order.status === 'Open' && (
              <button className="fm-btn fm-btn--primary" onClick={() => onEdit(order.id)}>
                <Pencil size={16} /> Sửa đơn hàng bán
              </button>
            )}
            {order.status === 'Open' && (
              <CopyToMenu
                disabled={!!busyAction}
                items={[
                  {
                    key: 'delivery', label: 'Phiếu giao hàng', icon: <Truck size={16} />, onSelect: openCopyModal,
                    disabled: copyDisabled, hint: totalOpenQty <= 0 ? 'Đơn đã giao hết' : 'Tạo phiếu giao hàng từ các dòng còn mở',
                  },
                  ...(onCopyTo ? [
                    { key: 'invoice', label: 'Hóa đơn bán hàng', icon: <Receipt size={16} />, onSelect: () => onCopyTo('invoice', order.id) },
                    { key: 'downPayment', label: 'Hóa đơn đặt cọc', icon: <HandCoins size={16} />, onSelect: () => onCopyTo('downPayment', order.id) },
                  ] : []),
                ]}
              />
            )}
            {order.status === 'Open' && (
              <button className="fm-btn fm-btn--secondary" onClick={() => void doCloseOrder()} disabled={!!busyAction}>
                <Lock size={16} /> {busyAction === 'close' ? 'Đang đóng…' : 'Đóng đơn'}
              </button>
            )}
            {order.status === 'Open' && (
              <button className="fm-btn fm-btn--danger" onClick={() => void doCancelOrder()} disabled={!!busyAction}>
                <X size={16} /> {busyAction === 'cancel' ? 'Đang hủy…' : 'Hủy đơn'}
              </button>
            )}
            {order.status === 'Cancelled' && (
              <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
            )}
          </>
        }
      />

      {/* Folio — số chứng từ lớn neo đầu trang (Phase 3, anchor Swiss) */}
      <div className="fm-docnum" style={{ fontSize: 30, margin: '4px 0 16px' }}>{docNumLabel(order.docNum, order.isDraft)}</div>

      {order.status === 'Cancelled' && (
        <div className="fm-alert fm-alert--info" style={{ marginBottom: 16 }}>
          Đơn hàng bán đã bị hủy — không thể sửa, sao chép sang phiếu giao hàng hoặc đẩy lên SAP B1.
        </div>
      )}

      {/* Phase 2 — banner bản nháp */}
      {order.isDraft && (
        <div className="fm-alert fm-alert--warning" style={{ marginBottom: 16 }} role="status">
          <b><span className="fm-chip fm-chip--warn">Nháp</span></b>{' '}
          Đây là bản nháp — chưa có hiệu lực, chưa đẩy được sang SAP B1.
          Bấm “Sửa đơn hàng bán” để tiếp tục chỉnh rồi “Chuyển thành chứng từ chính thức” trên form.
        </div>
      )}

      {overdue && (
        <div className="fm-alert fm-alert--error" style={{ marginBottom: 16 }}>
          Đơn hàng bán đã quá hạn giao ({formatDateVN(order.docDueDate)})
        </div>
      )}

      <DocInfoCards doc={order} dueLabel="Ngày giao hàng" />

      <DocLinesCard
        lines={order.lines}
        defaultWarehouse={order.warehouseCode}
        totals={{
          totalBeforeDisc: order.totalBeforeDisc,
          discountAmt: order.discountAmt,
          headerDiscPct: order.headerDiscPct,
          headerDiscAmt: order.headerDiscAmt,
          vatAmt: order.vatAmt,
          grandTotal: order.grandTotal,
        }}
      />

      {/* Nút thao tác */}
      {actionMsg && (
        <div className={`fm-alert ${actionMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={actionMsg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12 }}>
          {actionMsg.text}
        </div>
      )}
      {/* Nút thao tác — chỉ các hành động KHÔNG có trên thanh header. Đóng đơn đã có
          ở header (gọi cả SAP) → không lặp nút đóng chỉ-local ở đây. Mở lại chỉ cho đơn
          chưa lên SAP (SAP không mở lại chứng từ đã đóng); Đẩy SAP chỉ khi chưa đồng bộ. */}
      {(() => {
        const canReopen = order.status === 'Closed' && order.sapSyncStatus !== 'synced'
        const canPush = order.status !== 'Cancelled' && !order.isDraft && order.sapSyncStatus !== 'synced'
        if (!canReopen && !canPush) return null
        const syncHint = canPush && (order.sapSyncStatus === 'pending' || order.sapSyncStatus === 'error') ? sapSyncHint(order) : ''
        const reconcile = order.sapSyncErrorKind === 'reconcile'
        return (
          <div className="fm-actions" style={{ flexWrap: 'wrap' }}>
            {syncHint && (
              <p className="fm-hint" role="status" style={{ flexBasis: '100%', margin: 0 }}>Đồng bộ SAP: {syncHint}</p>
            )}
            {canReopen && (
              <button className="fm-btn fm-btn--secondary" onClick={toggleClose} disabled={!!busyAction}>
                <LockOpen size={16} /> {busyAction === 'toggle' ? 'Đang cập nhật…' : 'Mở lại đơn hàng'}
              </button>
            )}
            {canPush && (
              <button className="fm-btn fm-btn--secondary" onClick={syncNow} disabled={!!busyAction}>
                <CloudUpload size={16} /> {busyAction === 'sync' ? 'Đang đẩy…' : reconcile ? 'Đối chiếu với SAP B1' : 'Đẩy sang SAP B1 ngay'}
              </button>
            )}
          </div>
        )
      })()}

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
            <OrderPrintView
              order={order}
              partner={(() => {
                const c = order.contactPersonCode != null ? party?.info.contacts.find((x) => x.code === order.contactPersonCode) : undefined
                return { address: party?.address, contactPerson: c?.name, contactPhone: c?.phone }
              })()}
            />
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
            aria-label="Gửi email đơn hàng bán"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Mail size={18} /> Gửi email đơn hàng bán SO-{order.docNum}
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
                placeholder="Lời nhắn kèm theo đơn hàng bán…"
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
            aria-label={`Sao chép sang phiếu giao hàng từ đơn ${order.docNum}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 760 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Truck size={18} /> Sao chép sang phiếu giao hàng — Đơn hàng bán #{order.docNum}
              </h3>
              <button className="fm-icon-btn" onClick={() => setShowCopyModal(false)} aria-label="Đóng" disabled={copyBusy}>
                <X size={16} />
              </button>
            </div>

            {order.sapSyncStatus !== 'synced' && (
              <div className="fm-alert fm-alert--warning" role="alert" style={{ marginBottom: 12 }}>
                Đơn hàng bán chưa đẩy SAP — liên kết chứng từ gốc→đích trên SAP sẽ mất.
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
      {showReconcile && (
        <SapReconcileDialog
          orderId={order.id}
          onClose={() => setShowReconcile(false)}
          onDone={(type, text) => {
            setShowReconcile(false)
            void loadOrder({ cancelled: false }).then(() => setActionMsg({ type, text }))
          }}
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
