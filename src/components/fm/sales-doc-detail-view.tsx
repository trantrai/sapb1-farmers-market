'use client'

// ============================================================
// CHI TIẾT chứng từ Sales A/R dùng chung cho 4 loại Phase 1:
// Báo giá bán hàng · Hóa đơn bán hàng · Phiếu ghi có phải thu · Phiếu trả hàng bán
// Mirror theo order-detail-view: busyAction → text "Đang…", ConfirmDialog
// thay window.confirm(), bảng dòng + mobile card, nút Đóng/Hủy/Đẩy SAP,
// nút Sửa/Xóa và nút "Sao chép sang …" (wire qua onCopyTo ở app-shell).
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Pencil, Lock, LockOpen, Trash2, FileText, BadgeCheck } from 'lucide-react'
import { formatVND } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import CopyToMenu, { copyTargetIcon, copyTargetName } from './copy-to-menu'
import { DocField, DocInfoCards, DocLinesCard } from './doc-detail-sections'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import PaymentHistory from './payment-history'
import {
  INVOICE_DOC_TYPE_OPTIONS,
  docLabelFor,
  docNumLabel,
  unwrapDoc,
  type CopyTarget,
  type DocKindConfig,
  type SalesDoc,
} from './sales-doc-shared'

interface Props {
  config: DocKindConfig
  id: string
  onBack: () => void
  onEdit: (id: string) => void
  /** Wire ở app-shell: mở form loại đích với sourceType/sourceId */
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}



export default function SalesDocDetailView({ config, id, onBack, onEdit, onCopyTo }: Props) {
  const { apiBase, docLabel, copyButtons, showRemaining, showPaymentStatus } = config
  const [doc, setDoc] = useState<SalesDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  /** action đang chạy: 'close' | 'cancel' | 'sync' | 'delete' | 'finalize' — chống bấm đúp + hiện text Đang… */
  const [busyAction, setBusyAction] = useState<string | null>(null)

  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

  const loadDoc = useCallback(async (signal: { cancelled: boolean }) => {
    setLoading(true)
    setActionMsg(null)
    try {
      const r = await api(`/api/${apiBase}/${id}`)
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      if (signal.cancelled) return
      setDoc(unwrapDoc(j, config))
      setError('')
    } catch (e) {
      if (!signal.cancelled) setError(e instanceof Error ? e.message : `Không tải được chi tiết ${docLabel}`)
    } finally {
      if (!signal.cancelled) setLoading(false)
    }
  }, [apiBase, docLabel, id, config])

  useEffect(() => {
    const signal = { cancelled: false }
    void loadDoc(signal)
    return () => { signal.cancelled = true }
  }, [loadDoc])

  /** Đổi trạng thái nhanh qua PATCH (chế độ 1 của API: { status, version }) */
  const changeStatus = (next: 'Open' | 'Closed' | 'Cancelled', busyKey: string, successMsg: string) => {
    if (!doc || busyAction) return
    const run = async () => {
      setConfirmCfg(null)
      setBusyAction(busyKey)
      setActionMsg(null)
      try {
        const res = await api(`/api/${apiBase}/${doc.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // API yêu cầu optimistic locking version (thiếu → 400 VERSION_REQUIRED)
          body: JSON.stringify({ status: next, version: doc.version ?? 0 }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.ok) {
          setActionMsg({ type: 'error', text: json.error ?? successMsg.replace('Đã', 'Không thể').replace('.', '') })
          return
        }
        setActionMsg({ type: 'success', text: successMsg })
        await loadDoc({ cancelled: false })
      } catch {
        setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      } finally {
        setBusyAction(null)
      }
    }
    return run
  }

  // Đóng chứng từ (chỉ khi Open)
  const doClose = () => {
    if (!doc || busyAction) return
    setConfirmCfg({
      title: `Đóng ${docLabel}`,
      message: `Đóng ${docLabel} #${doc.docNum}?\nChứng từ đã đóng sẽ không sửa được nữa.`,
      confirmLabel: 'Đóng',
      tone: 'warning',
      run: () => { void changeStatus('Closed', 'close', `Đã đóng ${docLabel} #${doc.docNum}.`)?.() },
    })
  }

  // Mở lại chứng từ đã đóng
  const doReopen = () => {
    if (!doc || busyAction) return
    setConfirmCfg({
      title: `Mở lại ${docLabel}`,
      message: `Mở lại ${docLabel} #${doc.docNum}?`,
      confirmLabel: 'Mở lại',
      tone: 'primary',
      run: () => { void changeStatus('Open', 'toggle', `Đã mở lại ${docLabel} #${doc.docNum}.`)?.() },
    })
  }

  // Hủy chứng từ (chỉ khi chưa hủy)
  const doCancel = () => {
    if (!doc || busyAction) return
    setConfirmCfg({
      title: `Hủy ${docLabel}`,
      message: `Hủy ${docLabel} #${doc.docNum}?\nChứng từ đã hủy sẽ không sửa, không sao chép và không đẩy SAP được.`,
      confirmLabel: 'Hủy',
      tone: 'danger',
      run: () => { void changeStatus('Cancelled', 'cancel', `Đã hủy ${docLabel} #${doc.docNum}.`)?.() },
    })
  }

  // Xóa chứng từ
  const doDelete = () => {
    if (!doc || busyAction) return
    const run = async () => {
      setConfirmCfg(null)
      setBusyAction('delete')
      try {
        const res = await api(`/api/${apiBase}/${doc.id}`, { method: 'DELETE' })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setActionMsg({ type: 'error', text: json.error ?? `Không thể xóa ${docLabel}` })
          return
        }
        onBack()
      } catch {
        setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      } finally {
        setBusyAction(null)
      }
    }
    setConfirmCfg({
      title: `Xóa ${docLabel}`,
      message: `Xóa ${docLabel} ${docNumLabel(doc.docNum, doc.isDraft)} — ${doc.cardName}?\nHành động không thể hoàn tác.`,
      confirmLabel: `Xóa ${docLabel}`,
      tone: 'danger',
      run: () => void run(),
    })
  }

  // Phase 2 — Chuyển bản nháp thành chứng từ chính thức
  // (contract: PATCH /api/{base}/{id}/finalize { version } — do WORKER A triển khai)
  const doFinalize = () => {
    if (!doc || busyAction) return
    setConfirmCfg({
      title: `Chuyển thành chứng từ chính thức`,
      message: `Chuyển ${docLabel} ${docNumLabel(doc.docNum, doc.isDraft)} từ bản nháp thành chứng từ chính thức?\nSau khi chuyển, chứng từ sẽ có hiệu lực và có thể đẩy sang SAP B1.`,
      confirmLabel: 'Chuyển chính thức',
      tone: 'primary',
      run: () => {
        const runFinalize = async () => {
          setConfirmCfg(null)
          setBusyAction('finalize')
          setActionMsg(null)
          try {
            const res = await api(`/api/${apiBase}/${doc.id}/finalize`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ version: doc.version ?? 0 }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.ok) {
              setActionMsg({ type: 'error', text: json.error ?? `Không thể chuyển ${docLabel} thành chứng từ chính thức` })
              return
            }
            setActionMsg({ type: 'success', text: `Đã chuyển ${docLabel} ${docNumLabel(doc.docNum, doc.isDraft)} thành chứng từ chính thức.` })
            await loadDoc({ cancelled: false })
          } catch {
            setActionMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
          } finally {
            setBusyAction(null)
          }
        }
        void runFinalize()
      },
    })
  }

  // Ghi chú: Phase 1 chưa có endpoint đẩy lại thủ công (API tự đẩy khi tạo
  // chứng từ nếu đã cấu hình SAP; "Đẩy SAP do WORKER C bổ sung sau").
  // Chip "Đồng bộ SAP B1" ở Thông tin chung vẫn hiển thị trạng thái.

  if (loading) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', `Chi tiết ${docLabel}`]} title={`Chi tiết ${docLabel}`} />
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

  if (error || !doc) {
    return (
      <div>
        <PageHeader breadcrumb={['Chức năng chính', `Chi tiết ${docLabel}`]} title={`Chi tiết ${docLabel}`} />
        <div className="fm-alert fm-alert--error" role="alert">{error || 'Không tìm thấy'}</div>
        <button className="fm-btn fm-btn--secondary fm-mt-3" onClick={onBack}>
          <ArrowLeft size={16} /> Quay lại
        </button>
      </div>
    )
  }

  const isOpen = doc.status === 'Open'
  const isCancelled = doc.status === 'Cancelled'
  /** Phase 2 — bản nháp / loại hóa đơn (Reserve → "Hóa đơn bán hàng dự trữ") */
  const isDraft = doc.isDraft === true
  /** Chứng từ đọc trực tiếp từ SAP B1 (không có bản trên hệ thống) → chỉ xem */
  const readOnly = doc.source === 'sap'
  const dl = docLabelFor(config, doc.docType)

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', { label: `Danh sách ${dl}`, onNavigate: onBack }, `${dl} ${docNumLabel(doc.docNum, doc.isDraft)}`]}
        title={`${dl} ${docNumLabel(doc.docNum, doc.isDraft)}`}
        actions={readOnly ? (
          <span className="fm-chip fm-chip--role" title="Chứng từ đọc trực tiếp từ SAP B1 — sửa, đóng, hủy thực hiện trên SAP B1">Chỉ xem · SAP B1</span>
        ) : (
          <>
            {isDraft && (
              <button className="fm-btn fm-btn--primary" onClick={doFinalize} disabled={!!busyAction}>
                <BadgeCheck size={16} /> {busyAction === 'finalize' ? 'Đang chuyển…' : 'Chuyển thành chứng từ chính thức'}
              </button>
            )}
            {isOpen && (
              <button className="fm-btn fm-btn--primary" onClick={() => onEdit(doc.id)}>
                <Pencil size={16} /> Sửa {docLabel}
              </button>
            )}
            {isOpen && onCopyTo && (
              <CopyToMenu
                disabled={!!busyAction}
                items={copyButtons.map((cb) => ({
                  key: cb.target,
                  label: copyTargetName(cb.label),
                  icon: copyTargetIcon(cb.target),
                  onSelect: () => onCopyTo(cb.target, doc.id),
                  hint: `Tạo chứng từ mới từ ${docLabel} này`,
                }))}
              />
            )}
            {isOpen && (
              <button className="fm-btn fm-btn--secondary" onClick={doClose} disabled={!!busyAction}>
                <Lock size={16} /> {busyAction === 'close' ? 'Đang đóng…' : 'Đóng'}
              </button>
            )}
            {doc.status === 'Closed' && (
              <button className="fm-btn fm-btn--secondary" onClick={doReopen} disabled={!!busyAction}>
                <LockOpen size={16} /> {busyAction === 'toggle' ? 'Đang mở lại…' : 'Mở lại'}
              </button>
            )}
            {!isCancelled && (
              <button className="fm-btn fm-btn--danger" onClick={doCancel} disabled={!!busyAction}>
                <FileText size={16} /> {busyAction === 'cancel' ? 'Đang hủy…' : 'Hủy'}
              </button>
            )}
            {isCancelled && (
              <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
            )}
          </>
        )}
      />
      <div className="fm-docnum" style={{ fontSize: 30, margin: '4px 0 16px' }}>{docNumLabel(doc.docNum, doc.isDraft)}</div>

      {readOnly && (
        <div className="fm-alert fm-alert--info" style={{ marginBottom: 16 }} role="note">
          {docLabel} này đọc trực tiếp từ SAP B1 (không được tạo trên hệ thống này) — chỉ xem. Sửa, đóng, hủy hoặc ghi nhận
          thanh toán thực hiện trên SAP B1.
        </div>
      )}

      {isCancelled && (
        <div className="fm-alert fm-alert--info" style={{ marginBottom: 16 }}>
          {docLabel} đã bị hủy — không thể sửa, sao chép hoặc đẩy lên SAP B1.
        </div>
      )}

      {/* Phase 2 — banner bản nháp */}
      {isDraft && (
        <div className="fm-alert fm-alert--warning" style={{ marginBottom: 16 }} role="status">
          <b><span className="fm-chip fm-chip--warn">Nháp</span></b>{' '}
          Đây là bản nháp — chưa có hiệu lực, chưa đẩy được sang SAP B1.
          Bấm “Chuyển thành chứng từ chính thức” để kích hoạt.
        </div>
      )}

      {actionMsg && (
        <div className={`fm-alert ${actionMsg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={actionMsg.type === 'error' ? 'alert' : 'status'} style={{ marginBottom: 12 }}>
          {actionMsg.text}
        </div>
      )}

      {/* Chứng từ nguồn */}
      {doc.sourceLabel && (
        <div className="fm-card" style={{ marginBottom: 16 }}>
          <h2 className="fm-card__title">Chứng từ nguồn</h2>
          <dl className="fm-view-detail">
            <div>
              <dt>Tạo từ</dt>
              <dd><b>{doc.sourceLabel}{doc.sourceDocNum != null ? ` #${doc.sourceDocNum}` : ''}</b></dd>
            </div>
          </dl>
        </div>
      )}

      <DocInfoCards
        doc={doc}
        dueLabel="Hạn"
        showReqDate={false}
        generalExtra={
          <>
            {config.enableDocType && (
              <DocField label="Loại hóa đơn">
                {INVOICE_DOC_TYPE_OPTIONS.find((o) => o.value === (doc.docType || 'Item'))?.label ?? doc.docType}
              </DocField>
            )}
            {/* Phase 2 — Số dư chưa khấu trừ (chỉ Hóa đơn đặt cọc). API trả Decimal dạng chuỗi → Number() */}
            {showRemaining && doc.remainingAmount != null && (
              <DocField label="Số dư chưa khấu trừ"><b className="fm-text-navy">{formatVND(Number(doc.remainingAmount ?? 0))}</b></DocField>
            )}
          </>
        }
      />

      <DocLinesCard
        lines={doc.lines ?? []}
        defaultWarehouse={doc.warehouseCode}
        totals={{
          totalBeforeDisc: doc.totalBeforeDisc,
          discountAmt: doc.discountAmt,
          headerDiscPct: doc.headerDiscPct ?? 0,
          headerDiscAmt: doc.headerDiscAmt ?? 0,
          vatAmt: doc.vatAmt,
          grandTotal: doc.grandTotal,
        }}
      />

      {/* Đợt 2 — Ghi nhận thanh toán (hóa đơn / ghi có / đặt cọc):
          lịch sử + form ghi nhận qua PaymentHistory */}
      {showPaymentStatus && doc && !readOnly && (
        <PaymentHistory
          docType={config.docKey as 'invoice' | 'creditMemo' | 'downPayment'}
          docId={doc.id}
          grandTotal={doc.grandTotal ?? 0}
          paidAmount={doc.paidAmount ?? 0}
          onChanged={() => { void loadDoc({ cancelled: false }) }}
        />
      )}

      {/* Phase 2 — Khấu trừ đặt cọc trên hóa đơn */}
      {(doc.draws ?? []).length > 0 && (
        <div className="fm-card" style={{ marginBottom: 16 }}>
          <h2 className="fm-card__title">Khấu trừ đặt cọc</h2>
          <div className="fm-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="fm-table">
              <thead>
                <tr>
                  <th>Số đặt cọc</th>
                  <th className="fm-num">Số tiền khấu trừ</th>
                </tr>
              </thead>
              <tbody>
                {(doc.draws ?? []).map((d, i) => (
                  <tr key={d.downPaymentId || i}>
                    <th scope="row"><b>#{d.downPaymentDocNum ?? '—'}</b></th>
                    <td className="fm-num">{formatVND(d.drawAmount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ textAlign: 'right' }}><b>Tổng khấu trừ:</b></td>
                  <td className="fm-num"><b>{formatVND((doc.draws ?? []).reduce((s, d) => s + (d.drawAmount || 0), 0))}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Nút thao tác dưới (không lặp lại nút đã có trên header) */}
      {!isCancelled && !readOnly && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="fm-btn fm-btn--danger" onClick={doDelete} disabled={!!busyAction}>
            <Trash2 size={16} /> {busyAction === 'delete' ? 'Đang xóa…' : `Xóa ${docLabel}`}
          </button>
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
