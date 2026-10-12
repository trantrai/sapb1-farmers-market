'use client'

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Pencil, Lock, CloudUpload, Printer, Download, X, Mail } from 'lucide-react'
import { formatVND, formatDateVN, isOverdue } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import OrderPrintView from './order-print-view'

interface OrderLine {
  itemCode: string
  itemName: string
  quantity: number
  uom: string
  warehouseCode?: string
  unitPrice: number
  discPct: number
  vatPct: number
  lineTotal: number
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
  totalBeforeDisc: number
  vatAmt: number
  grandTotal: number
  lines: OrderLine[]
}

interface Props {
  orderId: string
  onBack: () => void
  onEdit: (orderId: string) => void
}

/**
 * Chi tiết đơn hàng dạng full-page (theo thiết kế Stitch màn 04)
 */
export default function OrderDetailView({ orderId, onBack, onEdit }: Props) {
  const [order, setOrder] = useState<Order | null>(null)
  const [partner, setPartner] = useState<{ address?: string; contactPerson?: string; contactPhone?: string; email?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showPrint, setShowPrint] = useState(false)
  const [showEmail, setShowEmail] = useState(false)
  const [emailTo, setEmailTo] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailMessage, setEmailMessage] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailResult, setEmailResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const doPrint = () => window.print()

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
      if (!signal.cancelled) setError('Không tải được chi tiết đơn hàng.')
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
  const toggleClose = async () => {
    if (!order || actionBusy) return
    const next = order.status === 'Open' ? 'Closed' : 'Open'
    if (!window.confirm(next === 'Closed' ? `Đóng đơn hàng #${order.docNum}? Đơn đã đóng sẽ không sửa được.` : `Mở lại đơn hàng #${order.docNum}?`)) return
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
      setActionMsg({ type: 'success', text: next === 'Closed' ? `Đã đóng đơn hàng #${order.docNum}.` : `Đã mở lại đơn hàng #${order.docNum}.` })
      await loadOrder({ cancelled: false })
    } catch {
      setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setActionBusy(false)
    }
  }

  // Đẩy đơn sang SAP B1 ngay
  const syncNow = async () => {
    if (!order || actionBusy) return
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
      setEmailResult({ type: 'success', text: json.message ?? 'Đã gửi email.' })
    } catch {
      setEmailResult({ type: 'error', text: 'Không thể kết nối máy chủ' })
    } finally {
      setEmailBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api(`/api/orders/${orderId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j: { order?: Order } & Partial<Order>) => {
        if (cancelled) return
        // API trả về { order } — unwrap để tương thích
        const o: Order = (j.order ?? j) as Order
        setOrder(o)
        setError('')
        // Lấy thông tin địa chỉ/người liên hệ + email
        if (o.cardCode) {
          api(`/api/partners?q=${encodeURIComponent(o.cardCode)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (cancelled) return
              const p = j?.items?.find((x: any) => x.cardCode === o.cardCode) ?? j?.items?.[0]
              if (p) setPartner((cur) => ({ ...cur, address: p.address, contactPerson: p.contactPerson, contactPhone: p.contactPhone }))
            })
            .catch(() => {})
          // Email từ danh mục KH đã đồng bộ (local)
          api(`/api/bpartners/sync?q=${encodeURIComponent(o.cardCode)}&pageSize=5`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (cancelled) return
              const p = j?.data?.find((x: any) => x.cardCode === o.cardCode)
              if (p?.email) setPartner((cur) => ({ ...cur, email: p.email }))
            })
            .catch(() => {})
        }
      })
      .catch(() => { if (!cancelled) setError('Không tải được chi tiết đơn hàng.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [orderId])

  if (loading) {
    return <div className="fm-skeleton" style={{ height: 400 }} />
  }

  if (error || !order) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', 'Chi tiết đơn hàng']} title="Chi Tiết Đơn Hàng" />
        <div className="fm-alert fm-alert--error">{error || 'Không tìm thấy đơn hàng.'}</div>
        <button className="fm-btn fm-btn--secondary" onClick={onBack} style={{ marginTop: 12 }}>
          <ArrowLeft size={15} /> Quay lại
        </button>
      </div>
    )
  }

  const overdue = isOverdue(order.docDueDate, order.status)

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Danh sách đơn hàng', `Sale Order #${order.docNum}`]}
        title={`Sale Order #${order.docNum}`}
        badge={overdue ? undefined : 'Cập nhật tức thời'}
        actions={
          <>
            <button className="fm-btn fm-btn--secondary" onClick={onBack}>
              <ArrowLeft size={15} /> Quay lại
            </button>
            <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(true)}>
              <Printer size={15} /> In đơn hàng
            </button>
            <button className="fm-btn fm-btn--secondary" onClick={openEmail}>
              <Mail size={15} /> Gửi email
            </button>
            <button className="fm-btn fm-btn--primary" onClick={() => onEdit(order.id)}>
              <Pencil size={15} /> Sửa đơn hàng
            </button>
          </>
        }
      />

      {overdue && (
        <div className="fm-alert fm-alert--error" style={{ marginBottom: 16 }}>
          Đơn hàng đã quá hạn giao ({formatDateVN(order.docDueDate)})
        </div>
      )}

      {/* Thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title">Thông Tin Chung</h2>
        <dl className="fm-view-detail">
          <div><dt>Mã khách hàng</dt><dd>{order.cardCode}</dd></div>
          <div><dt>Tên khách hàng</dt><dd>{order.cardName}</dd></div>
          <div><dt>Địa chỉ</dt><dd>{partner?.address || '—'}</dd></div>
          <div><dt>Người liên hệ</dt><dd>{partner?.contactPerson ? `${partner.contactPerson}${partner.contactPhone ? ` · ${partner.contactPhone}` : ''}` : '—'}</dd></div>
          <div><dt>Ngày chứng từ</dt><dd>{formatDateVN(order.docDate)}</dd></div>
          <div><dt>Ngày giao hàng</dt><dd>{formatDateVN(order.docDueDate)}</dd></div>
          <div><dt>Kho xuất</dt><dd>{order.warehouseCode || '—'}</dd></div>
          <div><dt>Người tạo</dt><dd>{order.createdBy}</dd></div>
          <div><dt>Trạng thái</dt><dd>{order.status === 'Open' ? 'Đang mở' : 'Đã đóng'}</dd></div>
          <div><dt>Ghi chú</dt><dd>{order.remarks || '—'}</dd></div>
        </dl>
      </div>

      {/* Dòng hàng */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title">Hàng Hóa & Chi Tiết (RDR1)</h2>
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
              {order.lines.map((line, i) => {
                const afterDisc = line.unitPrice * line.quantity * (1 - line.discPct / 100)
                const vatAmt = afterDisc * (line.vatPct / 100)
                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td><b>{line.itemCode}</b></td>
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
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>Tổng trước VAT:</td>
                <td className="fm-num">{formatVND(order.totalBeforeDisc)}</td>
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>Tiền VAT:</td>
                <td className="fm-num">{formatVND(order.vatAmt)}</td>
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>TỔNG CỘNG THANH TOÁN:</td>
                <td className="fm-num">{formatVND(order.grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Nút thao tác */}
      {actionMsg && (
        <div className={`fm-alert ${actionMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={actionMsg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12 }}>
          {actionMsg.text}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="fm-btn fm-btn--primary" onClick={() => onEdit(order.id)}>
          <Pencil size={15} /> Sửa đơn hàng
        </button>
        <button className="fm-btn fm-btn--secondary" onClick={toggleClose} disabled={actionBusy}>
          <Lock size={15} /> {order.status === 'Open' ? 'Đóng đơn hàng (Closed)' : 'Mở lại đơn hàng'}
        </button>
        <button className="fm-btn fm-btn--secondary" onClick={syncNow} disabled={actionBusy}>
          <CloudUpload size={15} /> Đẩy sang SAP B1 ngay
        </button>
        <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(true)}>
          <Printer size={15} /> In phiếu
        </button>
        <button className="fm-btn fm-btn--secondary" onClick={openEmail}>
          <Mail size={15} /> Gửi email
        </button>
        <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(true)}>
          <Download size={15} /> Xem trước bản in
        </button>
      </div>

      {/* Dialog xem trước bản in */}
      {showPrint && (
        <div className="fm-backdrop fm-print-hide" onClick={() => setShowPrint(false)}>
          <div
            className="fm-modal fm-modal--wide fm-print-preview"
            role="dialog"
            aria-modal="true"
            aria-label="Xem trước bản in"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 960 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }} className="fm-print-hide">
              <h3 style={{ margin: 0, fontSize: 18 }}>Xem trước bản in</h3>
              <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => setShowPrint(false)} aria-label="Đóng">
                <X size={16} />
              </button>
            </div>
            <OrderPrintView order={order} partner={partner} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }} className="fm-print-hide">
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(false)}>
                Đóng
              </button>
              <button className="fm-btn fm-btn--primary" onClick={doPrint}>
                <Printer size={15} /> In / Xuất PDF
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
            className="fm-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Gửi email đơn hàng"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Mail size={18} /> Gửi email đơn hàng SO-{order.docNum}
              </h3>
              <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => { if (!emailBusy) setShowEmail(false) }} aria-label="Đóng" disabled={emailBusy}>
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
                <Mail size={15} /> {emailBusy ? 'Đang gửi…' : 'Gửi email'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
