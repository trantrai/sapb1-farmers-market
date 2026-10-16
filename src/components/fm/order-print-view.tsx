'use client'

import { formatVND, formatDateVN } from '@/lib/fm-shared'

interface PrintLine {
  itemCode: string
  itemName: string
  quantity: number
  uom: string
  unitPrice: number
  discPct: number
  vatPct: number
  isBomChild?: boolean
  bomGroupKey?: string | null
  bomEditable?: boolean
  bomType?: string
}

interface PrintOrder {
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  remarks?: string
  warehouseCode?: string
  createdBy: string
  totalBeforeDisc: number
  vatAmt: number
  grandTotal: number
  lines: PrintLine[]
}

interface Props {
  order: PrintOrder
  partner?: { address?: string; contactPerson?: string; contactPhone?: string } | null
}

/**
 * Layout tối ưu cho in ấn đơn hàng (A4).
 * Chỉ hiển thị khi in (class fm-print-area).
 */
export default function OrderPrintView({ order, partner }: Props) {
  const today = new Date()

  return (
    <div className="fm-print-area">
      {/* Header công ty */}
      <div className="fm-print__header">
        <div className="fm-print__brand">
          <div className="fm-print__logo">F</div>
          <div>
            <div className="fm-print__company">FARMERS MARKET</div>
            <div className="fm-print__tagline">Hệ thống Đơn hàng bán — SAP Business One</div>
          </div>
        </div>
        <div className="fm-print__title-block">
          <div className="fm-print__doctitle">ĐƠN HÀNG BÁN</div>
          <div className="fm-print__docnum">Số: SO-{order.docNum}</div>
        </div>
      </div>

      {/* Thông tin đơn */}
      <div className="fm-print__info">
        <div className="fm-print__info-col">
          <div><b>Khách hàng:</b> {order.cardName} ({order.cardCode})</div>
          <div><b>Địa chỉ:</b> {partner?.address || '—'}</div>
          <div>
            <b>Người liên hệ:</b>{' '}
            {partner?.contactPerson
              ? `${partner.contactPerson}${partner.contactPhone ? ` · ${partner.contactPhone}` : ''}`
              : '—'}
          </div>
        </div>
        <div className="fm-print__info-col">
          <div><b>Ngày chứng từ:</b> {formatDateVN(order.docDate)}</div>
          <div><b>Ngày giao hàng:</b> {formatDateVN(order.docDueDate)}</div>
          <div><b>Kho xuất:</b> {order.warehouseCode || '—'}</div>
          <div><b>Người lập:</b> {order.createdBy}</div>
        </div>
      </div>

      {/* Bảng chi tiết */}
      <table className="fm-print__table">
        <thead>
          <tr>
            <th style={{ width: 36 }}>STT</th>
            <th>Mã hàng</th>
            <th>Tên hàng</th>
            <th className="fm-num" style={{ width: 60 }}>Số lượng</th>
            <th style={{ width: 60 }}>Đơn vị tính</th>
            <th className="fm-num" style={{ width: 110 }}>Đơn giá</th>
            <th className="fm-num" style={{ width: 60 }}>Chiết khấu %</th>
            <th className="fm-num" style={{ width: 60 }}>Thuế %</th>
            <th className="fm-num" style={{ width: 130 }}>Thành tiền</th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            const parentType = new Map(
              order.lines
                .filter((l) => !l.isBomChild && l.bomGroupKey)
                .map((l) => [l.bomGroupKey as string, l.bomType ?? 'none']),
            )
            const visible = order.lines.filter((l) => {
              if (!l.isBomChild) return true
              const pt = parentType.get(l.bomGroupKey as string)
              if (pt === 'production' || pt === 'assembly') return false
              if (pt === 'template') return true
              return l.bomEditable !== false
            })
            return visible.map((line, i) => {
            const afterDisc = line.unitPrice * line.quantity * (1 - line.discPct / 100)
            const lineTotal = afterDisc * (1 + line.vatPct / 100)
            const isChild = Boolean(line.isBomChild)
            const isBomParent = !isChild && Boolean(line.bomGroupKey)
            // STT: đếm trên mảng visible (đã lọc), không dùng slice trên order.lines
            const stt = visible.slice(0, i + 1).filter((l) => !l.isBomChild).length
            return (
              <tr key={i}>
                <td>{isChild ? '' : stt}</td>
                <td>{isChild && <span aria-hidden>└─ </span>}<b>{line.itemCode}</b>{isBomParent && ' (BOM)'}</td>
                <td>{line.itemName}</td>
                <td className="fm-num">{line.quantity}</td>
                <td>{line.uom}</td>
                <td className="fm-num">{formatVND(line.unitPrice)}</td>
                <td className="fm-num">{line.discPct}%</td>
                <td className="fm-num">{line.vatPct}%</td>
                <td className="fm-num"><b>{formatVND(lineTotal)}</b></td>
              </tr>
            )
            })
          })()}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={8} style={{ textAlign: 'right' }}>Tổng tiền hàng:</td>
            <td className="fm-num">{formatVND(order.totalBeforeDisc)}</td>
          </tr>
          <tr>
            <td colSpan={8} style={{ textAlign: 'right' }}>Tiền thuế:</td>
            <td className="fm-num">{formatVND(order.vatAmt)}</td>
          </tr>
          <tr className="fm-print__grand">
            <td colSpan={8} style={{ textAlign: 'right' }}>Tổng chứng từ:</td>
            <td className="fm-num">{formatVND(order.grandTotal)}</td>
          </tr>
        </tfoot>
      </table>

      {order.remarks && (
        <div className="fm-print__remarks">
          <b>Ghi chú:</b> {order.remarks}
        </div>
      )}

      {/* Chữ ký */}
      <div className="fm-print__sign">
        <div className="fm-print__sign-col">
          <div><b>Người lập phiếu</b></div>
          <div className="fm-print__sign-note">(Ký, ghi rõ họ tên)</div>
        </div>
        <div className="fm-print__sign-col fm-print__sign-date">
          Ngày {today.getDate()} tháng {today.getMonth() + 1} năm {today.getFullYear()}
          <div style={{ marginTop: 8 }}><b>Khách hàng</b></div>
          <div className="fm-print__sign-note">(Ký, ghi rõ họ tên)</div>
        </div>
      </div>
    </div>
  )
}
