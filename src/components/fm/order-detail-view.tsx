'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, Pencil, Lock, CloudUpload, Printer, Download, History } from 'lucide-react'
import { formatVND, formatDateVN, isOverdue } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

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
  const [partner, setPartner] = useState<{ address?: string; contactPerson?: string; contactPhone?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setLoading(true)
    })
    api(`/api/orders/${orderId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((o: Order) => {
        if (cancelled) return
        setOrder(o)
        setError('')
        // Lấy thông tin địa chỉ/người liên hệ
        if (o.cardCode) {
          api(`/api/partners?q=${encodeURIComponent(o.cardCode)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (cancelled) return
              const p = j?.items?.find((x: any) => x.cardCode === o.cardCode) ?? j?.items?.[0]
              if (p) setPartner({ address: p.address, contactPerson: p.contactPerson, contactPhone: p.contactPhone })
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
                <td className="fm-num">{formatVND(order.totalBeforeDisc)} ₫</td>
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>Tiền VAT:</td>
                <td className="fm-num">{formatVND(order.vatAmt)} ₫</td>
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right' }}>TỔNG CỘNG THANH TOÁN:</td>
                <td className="fm-num">{formatVND(order.grandTotal)} ₫</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Nút thao tác */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="fm-btn fm-btn--primary" onClick={() => onEdit(order.id)}>
          <Pencil size={15} /> Sửa đơn hàng
        </button>
        <button className="fm-btn fm-btn--secondary">
          <Lock size={15} /> Đóng đơn hàng (Closed)
        </button>
        <button className="fm-btn fm-btn--secondary">
          <CloudUpload size={15} /> Đẩy sang SAP B1 ngay
        </button>
        <button className="fm-btn fm-btn--secondary">
          <Printer size={15} /> In phiếu
        </button>
        <button className="fm-btn fm-btn--secondary">
          <Download size={15} /> Xuất PDF
        </button>
        <button className="fm-btn fm-btn--secondary">
          <History size={15} /> Nhật ký
        </button>
      </div>
    </div>
  )
}
