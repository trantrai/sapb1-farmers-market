'use client'

// ============================================================
// CHI TIẾT DELIVERY (phiếu giao hàng)
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useFocusTrap } from './use-focus-trap'
import { ArrowLeft, CloudUpload, Truck, Pencil, Ban, X, Printer, Receipt, Undo2, BadgeCheck } from 'lucide-react'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import DeliveryPrintView from './delivery-print-view'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import { type CopyTarget, docNumLabel } from './sales-doc-shared'

interface DeliveryLine {
  id: string
  lineNum: number
  itemCode: string
  itemName: string
  quantity: number
  uom: string
  unitPrice: number
  lineTotal: number
  warehouseCode?: string | null
  taxCode?: string | null
  discPct?: number
  sourceOrderLineId?: string | null
  /** Số lô (SAP BatchNumbers) — truy xuất nguồn gốc */
  batchNumber?: string | null
}

interface Delivery {
  id: string
  docNum: number
  docDate: string
  cardCode: string
  cardName: string
  status: string
  remarks?: string | null
  warehouseCode?: string | null
  grandTotal: number
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP DiscountPercent) */
  headerDiscPct?: number | null
  /** Ghi chú soạn/đóng gói (SAP PickAndPackNotes) */
  pickAndPackNotes?: string | null
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
  /** 'sap' = dữ liệu lấy trực tiếp từ SAP B1, không có bản ghi local */
  source?: string | null
  /** Phase 2 — Nháp: true = bản nháp chưa có hiệu lực */
  isDraft?: boolean
  /** Người tạo phiếu (user id) — không có với phiếu SAP */
  createdBy?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  /** Optimistic locking version */
  version?: number
  sapSyncedAt?: string | null
  sapDocEntry?: number | null
  sapDocNum?: number | null
  sapSyncStatus?: string
  sapSyncError?: string | null
  sourceOrder?: { id: string; docNum: number; docDate: string; cardCode: string; cardName: string; status: string } | null
  lines: DeliveryLine[]
}

interface Props {
  deliveryId: string
  onBack: () => void
  onGoOrder: (orderId: string) => void
  /** Wire ở app-shell: mở form loại đích với sourceType='delivery' + sourceId (Phase 1 Sales A/R) */
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
  /** Wire ở app-shell: mở form chỉnh sửa đầy đủ (delivery-form-view) */
  onEdit?: (id: string) => void
  /** Quyền sửa phiếu giao hàng (RBAC) — ẩn nút Chỉnh sửa nếu không có quyền */
  canEditDelivery?: boolean
}

interface EditRow {
  id: string
  itemCode: string
  itemName: string
  uom: string
  unitPrice: number
  oldQuantity: number
  maxQty: number // Infinity = không giới hạn (dòng không liên kết đơn nguồn)
  qtyRaw: string
}

const STATUS_LABEL: Record<string, string> = {
  Open: 'Mở',
  Closed: 'Đã đóng',
  Cancelled: 'Đã hủy',
}

export default function DeliveryDetailView({ deliveryId, onBack, onGoOrder, onCopyTo, onEdit, canEditDelivery }: Props) {
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** Tên NVBH / ĐKTT (best-effort từ danh mục; 404 → chỉ hiện mã số) */
  const [spNames, setSpNames] = useState<Record<number, string>>({})
  const [ptNames, setPtNames] = useState<Record<number, string>>({})
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

  // Modal sửa SL dòng
  const [showEdit, setShowEdit] = useState(false)
  const [editRows, setEditRows] = useState<EditRow[]>([])
  const [editLoading, setEditLoading] = useState(false)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const editTrapRef = useFocusTrap<HTMLDivElement>(showEdit, () => {
    if (!editBusy) setShowEdit(false)
  })

  // Modal xác nhận hủy phiếu
  const [showCancel, setShowCancel] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const cancelTrapRef = useFocusTrap<HTMLDivElement>(showCancel, () => {
    if (!cancelBusy) setShowCancel(false)
  })

  // Xem trước bản in
  const [showPrint, setShowPrint] = useState(false)
  const printTrapRef = useFocusTrap<HTMLDivElement>(showPrint, () => setShowPrint(false))
  const doPrint = () => window.print()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api(`/api/deliveries/${deliveryId}`)
      let j: { ok?: boolean; delivery?: Delivery; error?: string }
      try {
        const text = await r.text()
        j = text ? JSON.parse(text) : {}
      } catch {
        j = {}
      }
      if (r.ok && j.ok && j.delivery) {
        setDelivery(j.delivery)
        setError('')
      } else {
        setError(j.error ?? 'Không tải được chi tiết phiếu giao hàng')
      }
    } catch {
      setError('Không kết nối được máy chủ')
    } finally {
      setLoading(false)
    }
  }, [deliveryId])

  useEffect(() => { void load() }, [load])

  // B2B: tải tên NVBH / ĐKTT (best-effort — 404/lỗi thì chỉ hiện mã số)
  useEffect(() => {
    let cancelled = false
    const loadNames = async (url: string, set: (m: Record<number, string>) => void) => {
      try {
        const r = await api(url)
        if (!r.ok || cancelled) return
        const j = await r.json().catch(() => null)
        const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []
        const m: Record<number, string> = {}
        for (const x of arr as Array<{ code?: unknown; name?: unknown }>) {
          const c = Number(x.code)
          if (Number.isFinite(c)) m[c] = String(x.name ?? '')
        }
        if (!cancelled) set(m)
      } catch { /* bỏ qua — chỉ hiện mã */ }
    }
    void loadNames('/api/sales-persons', setSpNames)
    void loadNames('/api/payment-terms', setPtNames)
    return () => { cancelled = true }
  }, [])

  const doPush = async () => {
    if (!delivery) return
    // Đẩy SAP tạo chứng từ THẬT — xác nhận trước 1-click
    setConfirmCfg(null)
    setActionBusy(true)
    setActionMsg(null)
    try {
      const r = await api(`/api/deliveries/${delivery.id}/push`, { method: 'POST' })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setActionMsg({ type: 'success', text: j.message ?? 'Đã đẩy sang SAP B1' })
        void load()
      } else {
        setActionMsg({ type: 'error', text: j.error ?? 'Đẩy thất bại' })
      }
    } catch {
      setActionMsg({ type: 'error', text: 'Không kết nối được máy chủ' })
    } finally {
      setActionBusy(false)
    }
  }

  const askPush = () => {
    if (!delivery) return
    setConfirmCfg({
      title: 'Đẩy sang SAP B1',
      message: `Đẩy phiếu giao hàng #${delivery.docNum} sang SAP B1?\nThao tác tạo chứng từ thật trên SAP và không thể hoàn tác tự động.`,
      confirmLabel: 'Đẩy sang SAP',
      tone: 'warning',
      run: () => { void doPush() },
    })
  }

  // Phase 2 — chuyển bản nháp thành chứng từ chính thức
  const doFinalize = () => {
    if (!delivery || actionBusy) return
    setConfirmCfg({
      title: 'Chuyển thành chứng từ chính thức',
      message: `Chuyển phiếu giao hàng ${delivery.docNum ?? '(nháp)'} từ bản nháp thành chứng từ chính thức?\nSau khi chuyển, phiếu sẽ có hiệu lực và có thể đẩy sang SAP B1.`,
      confirmLabel: 'Chuyển chính thức',
      tone: 'primary',
      run: () => {
        const runFinalize = async () => {
          setConfirmCfg(null)
          setActionBusy(true)
          setActionMsg(null)
          try {
            const res = await api(`/api/deliveries/${delivery.id}/finalize`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ version: delivery.version ?? 0 }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.ok) {
              setActionMsg({ type: 'error', text: json.error ?? 'Không thể chuyển thành chứng từ chính thức' })
              return
            }
            setActionMsg({ type: 'success', text: 'Đã chuyển thành chứng từ chính thức.' })
            await load()
          } catch {
            setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
          } finally {
            setActionBusy(false)
          }
        }
        void runFinalize()
      },
    })
  }

  const canEdit = delivery !== null && delivery.source !== 'sap' && delivery.sapSyncStatus !== 'synced' && delivery.status !== 'Cancelled'

  // Mở modal sửa SL: lấy đơn nguồn để tính maxQty từng dòng
  // maxQty = SL đặt của đơn - SL đã giao ở các phiếu khác (không tính phiếu này)
  const openEditModal = async () => {
    if (!delivery || editLoading) return
    setEditLoading(true)
    try {
      const maxQtyByLine = new Map<string, number>()
      if (delivery.sourceOrder?.id) {
        const r = await api(`/api/orders/${delivery.sourceOrder.id}`)
        const j = await r.json().catch(() => null)
        const o = j?.order ?? j
        if (r.ok && o) {
          const delivered = new Map<string, number>()
          for (const d of o.deliveries ?? []) {
            if (d.id === delivery.id || d.status === 'Cancelled') continue
            for (const dl of d.lines ?? []) {
              if (!dl.sourceOrderLineId) continue
              delivered.set(dl.sourceOrderLineId, (delivered.get(dl.sourceOrderLineId) ?? 0) + dl.quantity)
            }
          }
          for (const ol of o.lines ?? []) {
            maxQtyByLine.set(
              ol.id,
              Math.max(0, Math.round((ol.quantity - (delivered.get(ol.id) ?? 0)) * 1000) / 1000),
            )
          }
        }
      }
      setEditRows(delivery.lines.map((l) => ({
        id: l.id,
        itemCode: l.itemCode,
        itemName: l.itemName,
        uom: l.uom,
        unitPrice: l.unitPrice,
        oldQuantity: l.quantity,
        maxQty: l.sourceOrderLineId ? (maxQtyByLine.get(l.sourceOrderLineId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY,
        qtyRaw: String(l.quantity),
      })))
      setEditError(null)
      setShowEdit(true)
    } finally {
      setEditLoading(false)
    }
  }

  const setEditRowQty = (lineId: string, raw: string) => {
    setEditRows((rows) => rows.map((r) => (r.id === lineId ? { ...r, qtyRaw: raw } : r)))
  }

  const doSaveEdit = async () => {
    if (!delivery) return
    const payload: Array<{ id: string; quantity: number }> = []
    for (const r of editRows) {
      const qty = parseFloat(r.qtyRaw)
      if (Number.isNaN(qty) || qty <= 0) {
        setEditError(`Số lượng dòng ${r.itemCode} phải > 0`)
        return
      }
      if (qty > r.maxQty) {
        setEditError(`Số lượng dòng ${r.itemCode} (${qty}) vượt quá số lượng còn mở (${r.maxQty}) của đơn nguồn`)
        return
      }
      payload.push({ id: r.id, quantity: qty })
    }
    setEditBusy(true)
    setEditError(null)
    try {
      const r = await api(`/api/deliveries/${delivery.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: payload,
          ...(typeof delivery.version === 'number' ? { version: delivery.version } : {}),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setShowEdit(false)
        setActionMsg({ type: 'success', text: `Đã cập nhật số lượng các dòng phiếu #${delivery.docNum}.` })
        void load()
      } else if (r.status === 409 && j.code === 'VERSION_CONFLICT') {
        setEditError('Phiếu đã bị sửa bởi người khác — vui lòng tải lại rồi thử lại')
      } else {
        setEditError(j.error ?? 'Lưu thất bại')
      }
    } catch {
      setEditError('Không kết nối được máy chủ')
    } finally {
      setEditBusy(false)
    }
  }

  const doCancel = async () => {
    if (!delivery) return
    setCancelBusy(true)
    try {
      const r = await api(`/api/deliveries/${delivery.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'Cancelled',
          ...(typeof delivery.version === 'number' ? { version: delivery.version } : {}),
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        setShowCancel(false)
        setActionMsg({ type: 'success', text: `Đã hủy phiếu giao hàng #${delivery.docNum}.` })
        void load()
      } else if (r.status === 409 && j.code === 'VERSION_CONFLICT') {
        setActionMsg({ type: 'error', text: 'Phiếu đã bị sửa bởi người khác — vui lòng tải lại rồi thử lại' })
        setShowCancel(false)
      } else {
        setActionMsg({ type: 'error', text: j.error ?? 'Hủy phiếu thất bại' })
        setShowCancel(false)
      }
    } catch {
      setActionMsg({ type: 'error', text: 'Không kết nối được máy chủ' })
      setShowCancel(false)
    } finally {
      setCancelBusy(false)
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', 'Giao hàng', 'Chi tiết']} title="Chi tiết phiếu giao hàng" />
        <div className="fm-card">
          <div aria-busy="true">
            <div className="fm-skeleton fm-skeleton--text" style={{ width: '45%', marginBottom: 10 }} />
            <div className="fm-skeleton fm-skeleton--text" style={{ width: '70%', marginBottom: 18 }} />
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="fm-skeleton fm-skeleton--row" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (error || !delivery) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', 'Giao hàng', 'Chi tiết']} title="Chi tiết phiếu giao hàng" />
        <div className="fm-alert fm-alert--error" role="alert">{error || 'Không tìm thấy'}</div>
        <button className="fm-btn fm-btn--secondary fm-mt-3" onClick={onBack}>
          <ArrowLeft size={16} /> Quay lại
        </button>
      </div>
    )
  }

  // ---------- B2B / SAP B1 (Đợt 2+3): chỉ hiện card khi có ít nhất 1 trường ----------
  const hasB2B = Boolean(
    delivery.salesPersonCode != null || delivery.paymentGroupCode != null ||
    delivery.shipToCode || delivery.billToCode || delivery.numAtCard || delivery.taxDate ||
    (delivery.docCurrency && delivery.docCurrency !== 'VND') || delivery.docRate != null ||
    delivery.projectCode || delivery.reqDate || delivery.attachmentsJson ||
    (delivery.headerDiscPct != null && delivery.headerDiscPct > 0) || delivery.pickAndPackNotes,
  )
  const spLabel = (code?: number | null) =>
    code == null ? '—' : spNames[code] ? `${code} · ${spNames[code]}` : String(code)
  const ptLabel = (code?: number | null) =>
    code == null ? '—' : ptNames[code] ? `${code} · ${ptNames[code]}` : String(code)
  const b2bAttachments: { name: string; url: string }[] = (() => {
    try {
      const arr = JSON.parse(delivery.attachmentsJson ?? 'null')
      return Array.isArray(arr) ? arr.filter((a) => a && (a.name || a.url)) : []
    } catch {
      return []
    }
  })()

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Giao hàng', `Phiếu #${delivery.docNum}`]}
        title={`Phiếu giao hàng #${delivery.docNum}`}
        actions={
          <>
            <button className="fm-btn fm-btn--secondary" onClick={onBack}>
              <ArrowLeft size={16} /> Quay lại
            </button>
            <button className="fm-btn fm-btn--secondary" onClick={() => setShowPrint(true)}>
              <Printer size={16} /> In
            </button>
            {canEdit && (
              <>
                <button
                  className="fm-btn fm-btn--secondary"
                  onClick={() => void openEditModal()}
                  disabled={actionBusy || editLoading}
                >
                  <Pencil size={16} /> {editLoading ? 'Đang tải…' : 'Sửa SL'}
                </button>
                {onEdit && canEditDelivery !== false && (
                  <button
                    className="fm-btn fm-btn--secondary"
                    onClick={() => onEdit(delivery.id)}
                    disabled={actionBusy}
                    title="Mở form chỉnh sửa đầy đủ (ngày chứng từ, ghi chú, số lượng dòng)"
                  >
                    <Pencil size={16} /> Chỉnh sửa
                  </button>
                )}
                <button className="fm-btn fm-btn--secondary" onClick={() => setShowCancel(true)} disabled={actionBusy}>
                  <Ban size={16} /> Hủy phiếu
                </button>
              </>
            )}
            {onCopyTo && delivery.status !== 'Cancelled' && (
              <>
                <button
                  className="fm-btn fm-btn--secondary"
                  onClick={() => onCopyTo('invoice', delivery.id)}
                  disabled={actionBusy}
                  title="Tạo hóa đơn bán hàng từ phiếu giao hàng này (wire ở app-shell)"
                >
                  <Receipt size={16} /> Sao chép sang hóa đơn bán hàng
                </button>
                <button
                  className="fm-btn fm-btn--secondary"
                  onClick={() => onCopyTo('return', delivery.id)}
                  disabled={actionBusy}
                  title="Tạo phiếu trả hàng bán từ phiếu giao hàng này (wire ở app-shell)"
                >
                  <Undo2 size={16} /> Sao chép sang phiếu trả hàng bán
                </button>
              </>
            )}
            {/* Phase 2 — bản nháp KHÔNG hiện nút đẩy SAP */}
            {delivery.isDraft && delivery.status !== 'Cancelled' && (
              <button className="fm-btn fm-btn--primary" onClick={doFinalize} disabled={actionBusy}>
                <BadgeCheck size={16} /> {actionBusy ? 'Đang chuyển…' : 'Chuyển thành chứng từ chính thức'}
              </button>
            )}
            {!delivery.isDraft && delivery.sapSyncStatus !== 'synced' && delivery.status !== 'Cancelled' && (
              <button className="fm-btn fm-btn--primary" onClick={askPush} disabled={actionBusy}>
                <CloudUpload size={16} /> {actionBusy ? 'Đang đẩy…' : 'Đẩy sang SAP B1'}
              </button>
            )}
          </>
        }
      />

      {/* Folio — số chứng từ lớn neo đầu trang (Phase 3, anchor Swiss) */}
      <div className="fm-docnum" style={{ fontSize: 30, margin: '4px 0 16px' }}>{docNumLabel(delivery.docNum, delivery.isDraft)}</div>

      {/* Phase 2 — banner bản nháp */}
      {delivery.isDraft && (
        <div className="fm-alert fm-alert--warning" style={{ marginBottom: 12 }} role="status">
          <b><span className="fm-chip fm-chip--warn">Nháp</span></b>{' '}
          Đây là bản nháp — chưa có hiệu lực, chưa đẩy được sang SAP B1.
        </div>
      )}

      {actionMsg && (
        <div className={`fm-alert fm-alert--${actionMsg.type === 'success' ? 'success' : 'error'}`} role="alert" style={{ marginBottom: 12 }}>
          {actionMsg.text}
        </div>
      )}

      {/* Đơn nguồn */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
          <h2 className="fm-card__title" style={{ margin: 0 }}>Đơn nguồn</h2>
          {delivery.sourceOrder && (
            <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => onGoOrder(delivery.sourceOrder!.id)}>
              <ArrowLeft size={16} style={{ transform: 'rotate(180deg)' }} /> Xem đơn nguồn
            </button>
          )}
        </div>
        {delivery.sourceOrder ? (
          <dl className="fm-view-detail">
            <div><dt>Số chứng từ</dt><dd><b>SO #{delivery.sourceOrder.docNum}</b></dd></div>
            <div><dt>Mã khách hàng</dt><dd>{delivery.sourceOrder.cardCode}</dd></div>
            <div><dt>Tên khách hàng</dt><dd>{delivery.sourceOrder.cardName}</dd></div>
            <div><dt>Ngày chứng từ</dt><dd>{formatDateVN(delivery.sourceOrder.docDate)}</dd></div>
            <div><dt>Trạng thái</dt><dd><span className={`fm-chip fm-chip--${(delivery.sourceOrder.status ?? 'Open').toLowerCase()}`}>{STATUS_LABEL[delivery.sourceOrder.status] ?? delivery.sourceOrder.status}</span></dd></div>
          </dl>
        ) : delivery.source === 'sap' ? (
          <p style={{ color: 'var(--fm-text-2)', fontSize: 12.5, margin: '8px 0 0' }}>Phiếu từ SAP B1 (không có bản ghi đơn nguồn trên local)</p>
        ) : (
          <p style={{ color: 'var(--fm-text-2)', fontSize: 12.5, margin: '8px 0 0' }}>Tạo thủ công (không từ đơn hàng)</p>
        )}
      </div>

      {/* Thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title">Thông tin chung</h2>
        <dl className="fm-view-detail">
          <div><dt>Khách hàng</dt><dd><b>{delivery.cardCode}</b> — {delivery.cardName}</dd></div>
          <div><dt>Ngày giao</dt><dd>{formatDateVN(delivery.docDate)}</dd></div>
          <div><dt>Kho xuất hàng</dt><dd>{delivery.warehouseCode || '— (theo mặc định SAP)'}</dd></div>
          <div><dt>Trạng thái</dt><dd><span className={`fm-chip fm-chip--${delivery.status.toLowerCase()}`}>{STATUS_LABEL[delivery.status] ?? delivery.status}</span></dd></div>
          <div>
            <dt>SAP B1</dt>
            <dd>
              {delivery.source === 'sap' ? (
                <span className="fm-chip fm-chip--sap">Từ SAP B1 — DocNum {delivery.sapDocNum}</span>
              ) : delivery.sapSyncStatus === 'synced' ? (
                <span className="fm-chip fm-chip--sap">Đã đẩy — DocNum {delivery.sapDocNum}</span>
              ) : delivery.sapSyncStatus === 'pending' ? (
                <span className="fm-chip fm-chip--error" title={delivery.sapSyncError ?? ''}>Đẩy lỗi</span>
              ) : (
                <span style={{ color: 'var(--fm-text-2)', fontWeight: 400 }}>Chưa đẩy</span>
              )}
            </dd>
          </div>
          {delivery.source !== 'sap' && (
            <>
              <div><dt>Người tạo</dt><dd>{delivery.createdBy || '—'}</dd></div>
              <div><dt>Ngày tạo</dt><dd>{delivery.createdAt ? formatDateVN(delivery.createdAt) : '—'}</dd></div>
              <div><dt>Cập nhật cuối</dt><dd>{delivery.updatedAt ? formatDateVN(delivery.updatedAt) : '—'}</dd></div>
              <div><dt>Version</dt><dd>v{delivery.version ?? 0}</dd></div>
            </>
          )}
          <div><dt>Ghi chú</dt><dd>{delivery.remarks || '—'}</dd></div>
        </dl>
      </div>

      {/* Thông tin B2B / SAP B1 (Đợt 2+3) — chỉ hiện khi có dữ liệu */}
      {hasB2B && (
        <div className="fm-card" style={{ marginBottom: 16 }}>
          <h2 className="fm-card__title">Thông tin B2B / SAP B1</h2>
          <dl className="fm-view-detail">
            <div><dt>Nhân viên bán hàng</dt><dd>{spLabel(delivery.salesPersonCode)}</dd></div>
            <div><dt>Điều khoản thanh toán</dt><dd>{ptLabel(delivery.paymentGroupCode)}</dd></div>
            <div><dt>Số PO / Tham chiếu KH</dt><dd>{delivery.numAtCard || '—'}</dd></div>
            <div><dt>Ngày tính thuế</dt><dd>{delivery.taxDate ? formatDateVN(delivery.taxDate) : '—'}</dd></div>
            <div><dt>Ngày cần giao</dt><dd>{delivery.reqDate ? formatDateVN(delivery.reqDate) : '—'}</dd></div>
            <div>
              <dt>Tiền tệ</dt>
              <dd>
                {delivery.docCurrency || 'VND'}
                {delivery.docCurrency && delivery.docCurrency !== 'VND' && delivery.docRate != null ? ` · Tỷ giá ${delivery.docRate}` : ''}
              </dd>
            </div>
            <div><dt>Mã dự án</dt><dd>{delivery.projectCode || '—'}</dd></div>
            <div><dt>Địa chỉ giao hàng</dt><dd>{delivery.shipToCode || '—'}</dd></div>
            <div><dt>Địa chỉ ghi hóa đơn</dt><dd>{delivery.billToCode || '—'}</dd></div>
            {delivery.headerDiscPct != null && delivery.headerDiscPct > 0 && (
              <div><dt>Chiết khấu đầu chứng từ</dt><dd>{delivery.headerDiscPct}%</dd></div>
            )}
            {delivery.pickAndPackNotes && (
              <div><dt>Ghi chú soạn/đóng gói</dt><dd>{delivery.pickAndPackNotes}</dd></div>
            )}
            <div>
              <dt>Đính kèm</dt>
              <dd>
                {b2bAttachments.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {b2bAttachments.map((a, i) => (
                      <li key={i}>
                        {a.url ? (
                          <a href={a.url} target="_blank" rel="noreferrer">{a.name || a.url}</a>
                        ) : (
                          a.name
                        )}
                      </li>
                    ))}
                  </ul>
                ) : '—'}
              </dd>
            </div>
          </dl>
        </div>
      )}

      {/* Dòng hàng */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title">Hàng hóa & chi tiết</h2>
        <div className="fm-table-wrap">
          <table className="fm-table">
            <thead>
              <tr>
                <th>STT</th>
                <th>Mã hàng</th>
                <th>Tên hàng</th>
                <th>Kho</th>
                <th className="fm-num">Số lượng</th>
                <th>Đơn vị tính</th>
                <th className="fm-num">Đơn giá</th>
                <th>Mã thuế</th>
                <th>Số lô</th>
                <th className="fm-num">CK %</th>
                <th className="fm-num">Thành tiền</th>
              </tr>
            </thead>
            <tbody>
              {delivery.lines.map((l, i) => (
                <tr key={l.id}>
                  <td>{i + 1}</td>
                  <th scope="row"><b>{l.itemCode}</b></th>
                  <td>{l.itemName}</td>
                  <td>{l.warehouseCode || delivery.warehouseCode || '—'}</td>
                  <td className="fm-num">{l.quantity}</td>
                  <td>{l.uom}</td>
                  <td className="fm-num">{formatVND(l.unitPrice)}</td>
                  <td>{l.taxCode || '—'}</td>
                  <td>{l.batchNumber || '—'}</td>
                  <td className="fm-num">{(l.discPct ?? 0) > 0 ? `${l.discPct}%` : '—'}</td>
                  <td className="fm-num"><b>{formatVND(l.lineTotal)}</b></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} style={{ textAlign: 'right' }}><b>Tổng SL:</b></td>
                <td className="fm-num"><b>{delivery.lines.reduce((s, l) => s + (l.quantity || 0), 0)}</b></td>
                <td colSpan={6} />
              </tr>
              <tr>
                <td colSpan={10} style={{ textAlign: 'right', fontSize: 16 }}><b>Tổng chứng từ:</b></td>
                <td className="fm-num" style={{ fontSize: 17, color: 'var(--fm-navy)' }}><b>{formatVND(delivery.grandTotal)}</b></td>
              </tr>
            </tfoot>
          </table>
          {/* Mobile (<=640px): card thay cho bảng 7 cột cuộn ngang */}
          <div className="fm-lcard-list">
            {delivery.lines.map((l, i) => (
              <div key={l.id} className="fm-lcard">
                <div className="fm-lcard__head">
                  <span className="fm-lcard__num">{i + 1}</span>
                  <div>
                    <div className="fm-lcard__name">{l.itemName}</div>
                    <div className="fm-lcard__code">{l.itemCode} · {l.uom}{l.warehouseCode ? ` · Kho ${l.warehouseCode}` : ''}</div>
                  </div>
                </div>
                <div className="fm-lcard__grid">
                  <div><span className="k">Số lượng</span><span className="v">{l.quantity}</span></div>
                  <div><span className="k">Đơn giá</span><span className="v">{formatVND(l.unitPrice)}</span></div>
                  <div><span className="k">Mã thuế</span><span className="v">{l.taxCode || '—'}</span></div>
                  <div><span className="k">Số lô</span><span className="v">{l.batchNumber || '—'}</span></div>
                  <div><span className="k">CK %</span><span className="v">{(l.discPct ?? 0) > 0 ? `${l.discPct}%` : '—'}</span></div>
                </div>
                <div className="fm-lcard__total">
                  <span>Thành tiền</span>
                  <b>{formatVND(l.lineTotal)}</b>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Lịch sử thao tác — suy ra từ các mốc thời gian của phiếu (chỉ phiếu local) */}
      {delivery.source !== 'sap' && (() => {
        const events: { label: string; time: string; tone: string }[] = [
          { label: 'Tạo phiếu', time: delivery.createdAt ?? '', tone: 'var(--fm-navy)' },
        ]
        if (delivery.updatedAt && delivery.updatedAt !== delivery.createdAt) {
          events.push({ label: 'Cập nhật', time: delivery.updatedAt, tone: 'var(--fm-text-2)' })
        }
        if (delivery.sapSyncedAt) {
          events.push({ label: 'Đẩy sang SAP B1', time: delivery.sapSyncedAt, tone: 'var(--fm-navy)' })
        }
        if (delivery.status === 'Cancelled') {
          events.push({ label: 'Hủy phiếu', time: delivery.updatedAt ?? '', tone: 'var(--fm-coral)' })
        }
        return (
          <div className="fm-card" style={{ marginTop: 16 }}>
            <div style={{ padding: '12px 16px 4px', fontWeight: 600 }}>Lịch sử thao tác</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: '0 16px 16px' }}>
              {events.map((e, i) => (
                <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
                  <span
                    aria-hidden
                    style={{
                      width: 10, height: 10, borderRadius: '50%', background: e.tone,
                      marginTop: 5, flexShrink: 0,
                    }}
                  />
                  <div>
                    <div><b>{e.label}</b></div>
                    <div className="fm-hint">{formatDateVN(e.time)}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      })()}

      {/* Modal sửa số lượng dòng */}
      {showEdit && delivery && (
        <div className="fm-backdrop" onClick={() => { if (!editBusy) setShowEdit(false) }}>
          <div
            ref={editTrapRef}
            className="fm-modal fm-modal--wide"
            role="dialog"
            aria-modal="true"
            aria-label={`Sửa số lượng phiếu ${delivery.docNum}`}
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 640 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Pencil size={18} /> Sửa số lượng — Phiếu #{delivery.docNum}
              </h3>
              <button className="fm-icon-btn" onClick={() => setShowEdit(false)} aria-label="Đóng" disabled={editBusy}>
                <X size={16} />
              </button>
            </div>

            <p className="fm-hint" style={{ margin: '0 0 10px' }}>
              Số lượng mới không được vượt quá số lượng còn mở của đơn nguồn (nếu dòng có liên kết).
            </p>

            <div className="fm-table-wrap" style={{ marginBottom: 12 }}>
              <table className="fm-table fm-stack-table fm-stack-table--form">
                <thead>
                  <tr>
                    <th>Mã hàng</th>
                    <th>Tên hàng</th>
                    <th className="fm-num">Số lượng cũ</th>
                    <th className="fm-num">Số lượng mới</th>
                  </tr>
                </thead>
                <tbody>
                  {editRows.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Mã hàng"><b>{r.itemCode}</b></td>
                      <td data-label="Tên hàng">{r.itemName}</td>
                      <td className="fm-num" data-label="Số lượng cũ">{r.oldQuantity}</td>
                      <td className="fm-num" data-label="Số lượng mới">
                        <input
                          type="number"
                          className="fm-input"
                          style={{ width: 96, textAlign: 'right' }}
                          min={0}
                          step="any"
                          value={r.qtyRaw}
                          onChange={(e) => setEditRowQty(r.id, e.target.value)}
                          aria-label={`Số lượng mới cho ${r.itemCode}${Number.isFinite(r.maxQty) ? ` (tối đa ${r.maxQty})` : ''}`}
                          disabled={editBusy}
                        />
                        {Number.isFinite(r.maxQty) && (
                          <div className="fm-hint" style={{ fontSize: 11 }}>tối đa {r.maxQty}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {editError && (
              <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>
                {editError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowEdit(false)} disabled={editBusy}>
                Hủy
              </button>
              <button className="fm-btn fm-btn--primary" onClick={() => void doSaveEdit()} disabled={editBusy}>
                <Pencil size={16} /> {editBusy ? 'Đang lưu…' : 'Lưu'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal xác nhận hủy phiếu */}
      {showCancel && delivery && (
        <div className="fm-backdrop" onClick={() => { if (!cancelBusy) setShowCancel(false) }}>
          <div
            ref={cancelTrapRef}
            className="fm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Xác nhận hủy phiếu ${delivery.docNum}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 className="fm-modal__title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Ban size={18} /> Hủy phiếu giao hàng
              </h3>
              <button className="fm-icon-btn" onClick={() => setShowCancel(false)} aria-label="Đóng" disabled={cancelBusy}>
                <X size={16} />
              </button>
            </div>
            <p style={{ margin: '0 0 8px' }}>
              Hủy phiếu giao hàng <b>#{delivery.docNum}</b>? Các dòng đã giao của phiếu này sẽ được trả lại
              thành số lượng còn mở của đơn nguồn.
            </p>
            <p className="fm-hint" style={{ margin: '0 0 16px' }}>
              Phiếu đã hủy sẽ không thể sửa và không thể đẩy sang SAP. Nếu cần giao tiếp, hãy tạo phiếu mới từ đơn nguồn.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowCancel(false)} disabled={cancelBusy}>
                Giữ phiếu
              </button>
              <button className="fm-btn fm-btn--danger" onClick={() => void doCancel()} disabled={cancelBusy}>
                <Ban size={16} /> {cancelBusy ? 'Đang hủy…' : 'Xác nhận hủy phiếu'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialog xem trước bản in */}
      {showPrint && delivery && (
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
            <DeliveryPrintView delivery={delivery} />
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
