'use client'

import { formatVND, formatDateVN } from '@/lib/fm-shared'

interface PrintLine {
  itemCode: string
  itemName: string
  quantity: number
  uom: string
  unitPrice: number
  lineTotal: number
}

interface PrintDelivery {
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  remarks?: string | null
  createdBy: string
  grandTotal: number
  sourceOrder?: { docNum: number } | null
  lines: PrintLine[]
}

interface Props {
  delivery: PrintDelivery
}

/**
 * Layout tối ưu cho in ấn phiếu giao hàng (A4).
 * Chỉ hiển thị khi in (class fm-print-area), tái dùng CSS của OrderPrintView.
 */
export default function DeliveryPrintView({ delivery }: Props) {
  const today = new Date()
  const totalQty = delivery.lines.reduce((s, l) => s + (l.quantity || 0), 0)

  return (
    <div className="fm-print-area">
      {/* Header công ty */}
      <div className="fm-print__header">
        <div className="fm-print__brand">
          <div className="fm-print__logo">F</div>
          <div>
            <div className="fm-print__company">FARMERS MARKET</div>
            <div className="fm-print__tagline">Hệ thống Sale Order — SAP Business One</div>
          </div>
        </div>
        <div className="fm-print__title-block">
          <div className="fm-print__doctitle">PHIẾU GIAO HÀNG</div>
          <div className="fm-print__docnum">Số: DL-{delivery.docNum}</div>
        </div>
      </div>

      {/* Thông tin phiếu */}
      <div className="fm-print__info">
        <div className="fm-print__info-col">
          <div><b>Khách hàng:</b> {delivery.cardName} ({delivery.cardCode})</div>
          <div>
            <b>Đơn nguồn:</b>{' '}
            {delivery.sourceOrder ? `SO-${delivery.sourceOrder.docNum}` : 'Tạo thủ công'}
          </div>
        </div>
        <div className="fm-print__info-col">
          <div><b>Ngày giao:</b> {formatDateVN(delivery.docDate)}</div>
          <div><b>Người lập:</b> {delivery.createdBy}</div>
        </div>
      </div>

      {/* Bảng chi tiết */}
      <table className="fm-print__table">
        <thead>
          <tr>
            <th style={{ width: 36 }}>STT</th>
            <th>Mã hàng</th>
            <th>Tên hàng</th>
            <th className="fm-num" style={{ width: 70 }}>SL</th>
            <th style={{ width: 60 }}>ĐVT</th>
            <th className="fm-num" style={{ width: 120 }}>Đơn giá</th>
            <th className="fm-num" style={{ width: 140 }}>Thành tiền</th>
          </tr>
        </thead>
        <tbody>
          {delivery.lines.map((line, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td><b>{line.itemCode}</b></td>
              <td>{line.itemName}</td>
              <td className="fm-num">{line.quantity}</td>
              <td>{line.uom}</td>
              <td className="fm-num">{formatVND(line.unitPrice)}</td>
              <td className="fm-num"><b>{formatVND(line.lineTotal)}</b></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} style={{ textAlign: 'right' }}>Tổng SL:</td>
            <td className="fm-num"><b>{totalQty}</b></td>
            <td colSpan={3} />
          </tr>
          <tr className="fm-print__grand">
            <td colSpan={6} style={{ textAlign: 'right' }}>TỔNG CỘNG:</td>
            <td className="fm-num">{formatVND(delivery.grandTotal)}</td>
          </tr>
        </tfoot>
      </table>

      {delivery.remarks && (
        <div className="fm-print__remarks">
          <b>Ghi chú:</b> {delivery.remarks}
        </div>
      )}

      {/* Chữ ký */}
      <div className="fm-print__sign">
        <div className="fm-print__sign-col">
          <div><b>Người giao hàng</b></div>
          <div className="fm-print__sign-note">(Ký, ghi rõ họ tên)</div>
        </div>
        <div className="fm-print__sign-date">
          Ngày {today.getDate()} tháng {today.getMonth() + 1} năm {today.getFullYear()}
          <div style={{ marginTop: 8 }}><b>Khách hàng</b></div>
          <div className="fm-print__sign-note">(Ký, ghi rõ họ tên)</div>
        </div>
      </div>
    </div>
  )
}
