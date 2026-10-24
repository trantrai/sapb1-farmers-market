'use client'

import { useCallback, useEffect, useState } from 'react'
import { CloudOff, RefreshCw } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import ConfirmDialog from './confirm-dialog'
import SapReconcileDialog, { sapSyncHint } from './sap-reconcile-dialog'

// ============================================================
// DASHBOARD: "Đơn chờ đồng bộ SAP" — đơn đã lưu nhưng chưa lên SAP B1
// (GET /api/orders/sync-queue). Ẩn khi không có đơn nào / không có quyền.
// ============================================================

interface QueueOrder {
  id: string
  docNum: number | null
  cardCode: string
  cardName: string
  docDate: string
  grandTotal: number
  sapSyncStatus: string
  sapSyncError: string | null
  sapSyncErrorKind: string | null
  sapSyncAttempts: number
  sapNextRetryAt: string | null
}

interface QueueData {
  total: number
  reconcile: number
  orders: QueueOrder[]
}

export default function SapSyncQueueCard({ onGoOrderDetail }: { onGoOrderDetail: (id: string) => void }) {
  const [data, setData] = useState<QueueData | null>(null)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [askPush, setAskPush] = useState<QueueOrder | null>(null)
  const [reconcileId, setReconcileId] = useState<string | null>(null)

  const load = useCallback(() => {
    api('/api/orders/sync-queue?limit=10')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setData(j?.ok ? (j as QueueData) : null))
      .catch(() => setData(null))
  }, [])

  useEffect(() => {
    load()
    // Job nền tự thử lại mỗi 2 phút → làm mới danh sách cùng nhịp
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load])

  const push = async (o: QueueOrder) => {
    setAskPush(null)
    setBusyId(o.id)
    try {
      const res = await api(`/api/orders/${o.id}/sync`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (json.code === 'NEEDS_RECONCILE') setReconcileId(o.id)
      else if (!res.ok || !json.ok) setMsg({ type: 'error', text: json.error ?? json.sap?.error ?? 'Không thể đẩy đơn sang SAP B1' })
      else setMsg({ type: 'success', text: `Đã đẩy đơn #${o.docNum} sang SAP B1 — DocNum ${json.order?.sapDocNum ?? '?'}` })
    } catch (e) {
      setMsg({ type: 'error', text: e instanceof Error ? e.message : 'Không thể đẩy đơn sang SAP B1' })
    } finally {
      setBusyId(null)
      load()
    }
  }

  if (!data || data.total === 0) {
    return msg ? <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role="status">{msg.text}</div> : null
  }

  return (
    <div className="fm-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="fm-card__title fm-row" style={{ alignItems: 'center', margin: 0 }}>
          <CloudOff size={18} /> {data.total} đơn chờ đồng bộ SAP
          {data.reconcile > 0 && <span className="fm-chip fm-chip--warn" style={{ marginLeft: 8 }}>{data.reconcile} cần đối chiếu</span>}
        </h2>
        <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={load}><RefreshCw size={14} /> Tải lại</button>
      </div>
      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={msg.type === 'error' ? 'alert' : 'status'} style={{ marginTop: 8 }}>
          {msg.text}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {data.orders.map((o) => {
          const reconcile = o.sapSyncErrorKind === 'reconcile'
          return (
            <div key={o.id} className="fm-ocard" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div>
                  <b>#{o.docNum ?? '—'}</b> · {o.cardName} · {formatDateVN(o.docDate)} ·{' '}
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatVND(o.grandTotal)}</span>
                </div>
                <div className="fm-hint" style={{ margin: 0 }}>{sapSyncHint(o) || 'Chưa đẩy được sang SAP B1'}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {reconcile ? (
                  <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => setReconcileId(o.id)}>Đối chiếu</button>
                ) : (
                  <button className="fm-btn fm-btn--secondary fm-btn--sm" disabled={busyId === o.id} onClick={() => setAskPush(o)}>
                    {busyId === o.id ? 'Đang đẩy…' : 'Đẩy lại ngay'}
                  </button>
                )}
                <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => onGoOrderDetail(o.id)}>Xem</button>
              </div>
            </div>
          )
        })}
        {data.total > data.orders.length && (
          <p className="fm-hint" style={{ margin: '8px 0 0' }}>Còn {data.total - data.orders.length} đơn khác — xem ở Danh sách đơn hàng bán.</p>
        )}
      </div>

      {askPush && (
        <ConfirmDialog
          open
          title="Đẩy lại đơn sang SAP B1"
          message={`Đẩy lại đơn hàng bán #${askPush.docNum} sang SAP B1?\nThao tác tạo chứng từ thật trên SAP và không thể hoàn tác tự động.`}
          confirmLabel="Đẩy sang SAP"
          tone="danger"
          onConfirm={() => { void push(askPush) }}
          onCancel={() => setAskPush(null)}
        />
      )}
      {reconcileId && (
        <SapReconcileDialog
          orderId={reconcileId}
          onClose={() => setReconcileId(null)}
          onDone={(type, text) => {
            setReconcileId(null)
            setMsg({ type, text })
            load()
          }}
        />
      )}
    </div>
  )
}
