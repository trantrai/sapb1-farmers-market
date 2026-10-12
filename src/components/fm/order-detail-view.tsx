'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, Pencil, LockOpen, RefreshCw, RotateCcw, ShoppingCart, ShoppingBasket, Calculator } from 'lucide-react'
import { formatVND, formatDateVN, formatNum, isOverdue } from '@/lib/fm-shared'
import type { SessionUser } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import type { EditOrderData } from './order-form-view'
import type { Order } from './orders-list-view'

interface Props {
  user: SessionUser
  order: Order
  onBack: () => void
  onGoEdit: (data: EditOrderData) => void
  /** Sau khi đóng/mở/đẩy SAP: báo app-shell refresh danh sách */
  onChanged: () => void
}

export default function OrderDetailView({ user, order, onBack, onGoEdit, onChanged }: Props) {
  const [detail, setDetail] = useState<Order>(order)
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [linesLoading, setLinesLoading] = useState(false)
  const [linesError, setLinesError] = useState('')
  const [retryTick, setRetryTick] = useState(0)
  const [closingId, setClosingId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  /** Thông tin KH từ danh mục (địa chỉ + người liên hệ) — tải riêng vì đơn không lưu snapshot */
  const [custInfo, setCustInfo] = useState<{ address?: string; contactPerson?: string; contactPhone?: string } | null>(null)

  useEffect(() => {
    if (!detail.cardCode) return
    let cancelled = false
    api(`/api/partners?q=${encodeURIComponent(detail.cardCode)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        const list: Array<{ cardCode?: string; address?: string; contactPerson?: string; contactPhone?: string }> = json.data ?? []
        const hit = list.find((p) => p.cardCode === detail.cardCode) ?? list[0]
        if (!cancelled && hit) setCustInfo({ address: hit.address, contactPerson: hit.contactPerson, contactPhone: hit.contactPhone })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [detail.cardCode])

  // Đơn lấy trực tiếp từ SAP B1 chưa có dòng hàng → tải khi mở trang chi tiết.
  // Đơn local thiếu dòng (hiếm) → tải từ /api/orders/[id].
  useEffect(() => {
    if (detail.lines.length > 0 || linesLoading) return
    const isSap = detail.source === 'sap' && !!detail.sapDocEntry
    const isLocal = detail.source !== 'sap'
    if (!isSap && !isLocal) return
    const url = isSap ? `/api/orders?docEntry=${detail.sapDocEntry}` : `/api/orders/${detail.id}`
    let cancelled = false
    setLinesLoading(true)
    setLinesError('')
    api(url)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.ok) throw new Error(json.error ?? `Lỗi HTTP ${res.status}`)
        const loaded = json.order
        if (!cancelled && loaded) setDetail((d) => ({ ...d, ...loaded, source: d.source }))
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Lỗi không rõ'
          setLinesError(msg)
          setAlert({ type: 'error', msg: `Không lấy được dòng hàng: ${msg}` })
        }
      })
      .finally(() => { if (!cancelled) setLinesLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryTick])

  const retryLines = () => {
    setDetail((d) => ({ ...d, lines: [] }))
    setRetryTick((t) => t + 1)
  }

  const canEdit = user.permissions.orders?.edit
  const canCreate = user.permissions.ordersNew?.create

  /** Đơn này SỬA được không? — mọi đơn Open:
   *  - đơn local → sửa local (+ PATCH SAP nếu đã synced);
   *  - đơn lấy trực tiếp từ SAP B1 → sửa thẳng chứng từ trên SL (PATCH /Orders).
   *    Điều kiện: đã tải được dòng hàng. */
  const editable = (o: Order): boolean =>
    Boolean(canEdit && o.status === 'Open' && o.lines.length > 0 && (o.source !== 'sap' || o.sapDocEntry != null))

  /** Đơn chi tiết → dữ liệu cho form sửa */
  const toEditData = (o: Order): EditOrderData => ({
    id: o.source === 'sap' ? o.localId ?? o.id : o.id,
    docNum: o.docNum,
    cardCode: o.cardCode,
    cardName: o.cardName,
    docDate: o.docDate,
    docDueDate: o.docDueDate,
    status: o.status,
    remarks: o.remarks,
    warehouseCode: (o as { warehouseCode?: string | null }).warehouseCode ?? null,
    headerDiscPct: o.headerDiscPct ?? 0,
    sapSyncStatus: o.sapSyncStatus ?? (o.source === 'sap' ? 'synced' : 'none'),
    lines: o.lines.map((l) => ({
      dbId: o.source === 'sap' ? undefined : l.id,
      sapLineNum: o.source === 'sap' ? l.lineNum : undefined,
      itemCode: l.itemCode,
      itemName: l.itemName,
      uom: l.uom,
      warehouseCode: l.warehouseCode ?? undefined,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct ?? 0,
      taxCode: l.taxCode ?? undefined,
      vatPct: l.vatPct ?? 0,
    })),
  })

  const closeOrder = async () => {
    if (closingId) return // chống bấm đúp gửi 2 request
    const o = detail
    setClosingId(o.id)
    try {
      const next = o.status === 'Open' ? 'Closed' : 'Open'
      const res = await api(`/api/orders/${o.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      const json = await res.json()
      if (!res.ok) {
        setAlert({ type: 'error', msg: json.error ?? 'Không thể cập nhật trạng thái' })
        return
      }
      setAlert({ type: 'success', msg: `Đã ${next === 'Closed' ? 'đóng' : 'mở lại'} đơn hàng #${o.docNum}` })
      setDetail((d) => ({ ...d, status: next }))
      onChanged()
    } finally {
      setClosingId(null)
    }
  }

  const syncOrder = async () => {
    const o = detail
    setSyncing(true)
    try {
      const res = await api(`/api/orders/${o.id}/sync`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        setAlert({ type: 'error', msg: json.error ?? json.sap?.error ?? 'Không thể đẩy đơn sang SAP B1' })
      } else {
        setAlert({ type: 'success', msg: `Đã đẩy đơn #${o.docNum} sang SAP B1 — DocNum ${json.order?.sapDocNum}` })
        if (json.order) setDetail((d) => ({ ...d, ...json.order }))
      }
      onChanged()
    } finally {
      setSyncing(false)
    }
  }

  const sapChip = () => {
    const o = detail
    if (o.sapSyncStatus === 'synced') {
      return <span className="fm-chip fm-chip--sap" title={`Đã đồng bộ SAP B1 — DocNum ${o.sapDocNum}`}>SAP #{o.sapDocNum}</span>
    }
    if (o.sapSyncStatus === 'pending') {
      return (
        <button
          type="button"
          className="fm-chip fm-chip--pending fm-chip--btn"
          title={o.sapSyncError ? `Đẩy lại sang SAP B1 — lỗi trước đó: ${o.sapSyncError}` : 'Đẩy lại sang SAP B1'}
          disabled={syncing || !canCreate}
          onClick={syncOrder}
        >
          <RefreshCw size={11} style={{ flex: 'none' }} />
          {syncing ? 'Đang đẩy…' : 'Chưa đẩy'}
        </button>
      )
    }
    return (
      <span className="fm-chip fm-chip--closed" title="Chưa cấu hình SAP B1 — đơn chỉ lưu local">
        —
      </span>
    )
  }

  const statusChip = isOverdue(detail.docDueDate, detail.status) ? (
    <span className="fm-chip fm-chip--overdue">Quá hạn</span>
  ) : detail.status === 'Open' ? (
    <span className="fm-chip fm-chip--open">Open</span>
  ) : (
    <span className="fm-chip fm-chip--closed">Closed</span>
  )

  const linesBody = detail.lines.length === 0 ? (
    <div className="fm-empty" style={{ border: '1px dashed var(--fm-line)', borderRadius: 'var(--fm-r-lg)', margin: 14 }}>
      {linesLoading ? (
        <span style={{ color: 'var(--fm-text-2)' }}>
          {detail.source === 'sap' ? 'Đang tải dòng hàng từ SAP B1…' : 'Đang tải dòng hàng…'}
        </span>
      ) : linesError ? (
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--fm-red)' }}>⚠ Không tải được dòng hàng — {linesError}</span>
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={retryLines}>
            <RotateCcw size={13} style={{ verticalAlign: -2, marginRight: 4 }} /> Thử lại
          </button>
        </span>
      ) : (
        'Không có dòng hàng nào'
      )}
    </div>
  ) : (
    <>
      {/* Bảng 11 cột — chỉ desktop; mobile dùng card fm-lcard bên dưới */}
      <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto', border: 'none', boxShadow: 'none', borderRadius: 0 }}>
        <table className="fm-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Mã hàng</th>
              <th>Tên hàng</th>
              <th className="fm-num">SL</th>
              <th>DVT</th>
              <th>Kho</th>
              <th className="fm-num">Đơn giá</th>
              <th className="fm-num">CK (%)</th>
              <th className="fm-num">Thành tiền sau CK</th>
              <th className="fm-num">VAT (%)</th>
              <th className="fm-num">Tiền dòng (sau VAT)</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((l) => {
              const afterDisc = l.lineTotal - (l.discAmt || 0)
              return (
                <tr key={l.id}>
                  <td>{l.lineNum}</td>
                  <td>{l.itemCode}</td>
                  <td>{l.itemName}</td>
                  <td className="fm-num">{formatNum(l.quantity)}</td>
                  <td>{l.uom}</td>
                  <td>{l.warehouseCode || '—'}</td>
                  <td className="fm-num">{formatVND(l.unitPrice)}</td>
                  <td className="fm-num">{formatNum(l.discPct || 0)}%</td>
                  <td className="fm-num">{formatVND(afterDisc)}</td>
                  <td className="fm-num">{formatNum(l.vatPct ?? 0)}%</td>
                  <td className="fm-num"><b>{formatVND(l.grandTotal || afterDisc)}</b></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Card dòng hàng (mobile) */}
      <div className="fm-only-mobile">
        {detail.lines.map((l) => {
          const afterDiscM = l.lineTotal - (l.discAmt || 0)
          return (
            <div key={l.id} className="fm-lcard">
              <div className="fm-lcard__head">
                <span className="fm-lcard__num">{l.lineNum}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="fm-lcard__name">{l.itemName}</div>
                  <div className="fm-lcard__code">{l.itemCode}{l.uom ? ` · ${l.uom}` : ''}</div>
                </div>
              </div>
              <div className="fm-lcard__grid">
                <div><span className="k">Số lượng</span><span className="v">{formatNum(l.quantity)}</span></div>
                <div><span className="k">Kho</span><span className="v">{l.warehouseCode || '—'}</span></div>
                <div><span className="k">Đơn giá</span><span className="v">{formatVND(l.unitPrice)}</span></div>
                <div><span className="k">CK (%)</span><span className="v">{formatNum(l.discPct || 0)}%</span></div>
                <div><span className="k">Mã thuế</span><span className="v">{l.taxCode || '—'}</span></div>
                <div><span className="k">VAT (%)</span><span className="v">{formatNum(l.vatPct ?? 0)}%</span></div>
                <div><span className="k">Sau CK</span><span className="v">{formatVND(afterDiscM)}</span></div>
              </div>
              <div className="fm-lcard__total">
                <span>Tiền dòng (sau VAT)</span>
                <b>{formatVND(l.grandTotal || afterDiscM)}</b>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )

  return (
    <div>
      {alert && (
        <div className={`fm-alert ${alert.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={alert.type === 'error' ? 'alert' : 'status'}>
          <div><b>{alert.type === 'success' ? 'Thành công' : 'Lỗi'}</b>{alert.msg}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      {/* Bước 1 — Thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingCart size={18} /> Sale Order #{detail.docNum} {statusChip}
        </h2>
        <p className="fm-card__desc">Chi tiết chứng từ bán hàng — cấu trúc ORDR / RDR1 của SAP B1.</p>
        <div className="fm-form-grid">
          <div className="fm-field"><span className="fm-label">Mã khách hàng</span><div style={{ fontWeight: 600 }}>{detail.cardCode}</div></div>
          <div className="fm-field"><span className="fm-label">Tên khách hàng</span><div style={{ fontWeight: 600 }}>{detail.cardName}</div></div>
          <div className="fm-field"><span className="fm-label">Ngày chứng từ</span><div style={{ fontWeight: 600 }}>{formatDateVN(detail.docDate)}</div></div>
          <div className="fm-field"><span className="fm-label">Ngày giao hàng</span><div style={{ fontWeight: 600 }}>{formatDateVN(detail.docDueDate)}</div></div>
          <div className="fm-field"><span className="fm-label">Người tạo</span><div style={{ fontWeight: 600 }}>{detail.source === 'sap' ? 'SAP B1 (chứng từ gốc)' : detail.createdBy}</div></div>
          <div className="fm-field"><span className="fm-label">Ghi chú</span><div style={{ fontWeight: 600 }}>{detail.remarks || '—'}</div></div>
          <div className="fm-field"><span className="fm-label">Địa chỉ</span><div style={{ fontWeight: 600 }}>{custInfo?.address || '—'}</div></div>
          <div className="fm-field"><span className="fm-label">Người liên hệ</span><div style={{ fontWeight: 600 }}>{custInfo?.contactPerson ? <>{custInfo.contactPerson}{custInfo.contactPhone ? <span style={{ fontWeight: 400, color: 'var(--fm-text-2)' }}> · {custInfo.contactPhone}</span> : null}</> : '—'}</div></div>
          <div className="fm-field">
            <span className="fm-label">SAP B1</span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {sapChip()}
              {detail.sapSyncStatus === 'pending' && detail.sapSyncError && (
                <small style={{ color: 'var(--fm-red)' }}>{detail.sapSyncError}</small>
              )}
              {detail.sapSyncStatus === 'synced' && detail.sapSyncedAt && (
                <small style={{ color: 'var(--fm-text-3)' }}>
                  DocEntry {detail.sapDocEntry ?? '—'} · đồng bộ lúc {formatDateVN(detail.sapSyncedAt)}
                </small>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bước 2 — Hàng hóa */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShoppingBasket size={18} /> Bước 2 — Hàng hóa
        </h2>
        <p className="fm-card__desc">Mỗi dòng tương ứng 1 bản ghi trong bảng RDR1. Nhập số lượng, đơn giá, chiết khấu % và thuế suất VAT % riêng cho từng mặt hàng.</p>
        {linesBody}
      </div>

      {/* Bước 3 — Tổng kết */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Calculator size={18} /> Bước 3 — Tổng kết
        </h2>
        <p className="fm-card__desc">Tổng hợp giá trị chứng từ sau chiết khấu và thuế VAT.</p>
        <div className="fm-totals">
          <div className="fm-totals__row"><span>Tổng trước chiết khấu</span><b>{formatVND(detail.totalBeforeDisc)}</b></div>
          <div className="fm-totals__row"><span>Chiết khấu các dòng</span><b>{detail.discountAmt > 0 ? `−${formatVND(detail.discountAmt)}` : formatVND(0)}</b></div>
          {(detail.headerDiscAmt ?? 0) > 0 && (
            <div className="fm-totals__row"><span>Chiết khấu đầu chứng từ ({detail.headerDiscPct ?? 0}%)</span><b>−{formatVND(detail.headerDiscAmt ?? 0)}</b></div>
          )}
          <div className="fm-totals__row"><span>Thuế VAT các dòng</span><b>{formatVND(detail.vatAmt ?? 0)}</b></div>
          <div className="fm-totals__grand"><span>TỔNG CỘNG</span><span>{formatVND(detail.grandTotal)}</span></div>
        </div>
      </div>

      {/* Hành động */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="fm-btn fm-btn--ghost" onClick={onBack}>
          <ArrowLeft size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
          Quay lại danh sách
        </button>
        <span style={{ flex: 1 }} />
        {canEdit && detail.status === 'Open' && (
          <button
            className="fm-btn fm-btn--primary"
            title={editable(detail) ? 'Sửa nội dung đơn hàng đang Open (cập nhật trực tiếp lên SAP B1)' : 'Không sửa được — chưa tải được dòng hàng của chứng từ'}
            disabled={!editable(detail)}
            onClick={() => onGoEdit(toEditData(detail))}
          >
            <Pencil size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
            Sửa đơn hàng
          </button>
        )}
        {canEdit && detail.source !== 'sap' && (
          <button
            className={`fm-btn ${detail.status === 'Open' ? 'fm-btn--secondary' : 'fm-btn--ghost'}`}
            disabled={closingId === detail.id}
            onClick={closeOrder}
          >
            <LockOpen size={14} style={{ verticalAlign: -2, marginRight: 5 }} />
            {closingId === detail.id ? 'Đang cập nhật…' : detail.status === 'Open' ? 'Đóng đơn hàng (Closed)' : 'Mở lại đơn hàng (Open)'}
          </button>
        )}
      </div>
    </div>
  )
}
