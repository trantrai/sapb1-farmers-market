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
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'
import CopyToMenu, { copyTargetIcon, copyTargetName } from './copy-to-menu'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import PaymentHistory from './payment-history'
import {
  DOC_STATUS_LABEL,
  docLabelFor,
  docNumLabel,
  PAYMENT_STATUS_LABEL,
  unwrapDoc,
  type CopyTarget,
  type DocKindConfig,
  type SalesDoc,
  type SalesDocLine,
} from './sales-doc-shared'

interface Props {
  config: DocKindConfig
  id: string
  onBack: () => void
  onEdit: (id: string) => void
  /** Wire ở app-shell: mở form loại đích với sourceType/sourceId */
  onCopyTo?: (target: CopyTarget, sourceId: string) => void
}

/** Đợt 2 — Chip trạng thái thanh toán (unpaid | partial | paid) */
function paymentChip(status?: string | null) {
  const s = status ?? 'unpaid'
  if (s === 'paid') return <span className="fm-chip fm-chip--open">{PAYMENT_STATUS_LABEL.paid}</span>
  if (s === 'partial') return <span className="fm-chip fm-chip--warn">{PAYMENT_STATUS_LABEL.partial}</span>
  return <span className="fm-chip fm-chip--overdue">{PAYMENT_STATUS_LABEL.unpaid}</span>
}

/** Đợt 2 — Parse attachmentsJson [{name,url}] để hiển thị danh sách đính kèm */
function parseAttachments(raw?: string | null): { name: string; url: string }[] {
  if (!raw) return []
  try {
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return (arr as Record<string, unknown>[])
      .map((a) => ({ name: String(a?.name ?? ''), url: String(a?.url ?? '') }))
      .filter((a) => a.name || a.url)
  } catch {
    return []
  }
}

export default function SalesDocDetailView({ config, id, onBack, onEdit, onCopyTo }: Props) {
  const { apiBase, docLabel, copyButtons, showRemaining, showBatchNumberCol, showPaymentStatus } = config
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
  /** Đợt 2 — số cột nhãn trong tfoot (cột Số lô chỉ ở phiếu trả hàng) */
  const footSpan = showBatchNumberCol ? 11 : 10
  /** BOM: chỉ hiện dòng con của BOM Template (SL sửa được); Production/Assembly
   *  (bomEditable=false) ẩn như màn đơn hàng. STT chỉ đếm dòng không phải con. */
  const bomView = (() => {
    const visible = (doc.lines ?? []).filter((l) => !l.isBomChild || l.bomEditable !== false)
    const stt = new Map<SalesDocLine, number>()
    let n = 0
    for (const l of visible) if (!l.isBomChild) stt.set(l, ++n)
    return { visible, stt }
  })()

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

      {/* Thông tin chung */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <h2 className="fm-card__title">Thông tin chung</h2>
        <dl className="fm-view-detail">
          <div><dt>Mã khách hàng</dt><dd>{doc.cardCode}</dd></div>
          <div><dt>Tên khách hàng</dt><dd>{doc.cardName}</dd></div>
          <div><dt>Ngày chứng từ</dt><dd>{formatDateVN(doc.docDate)}</dd></div>
          <div><dt>Hạn</dt><dd>{formatDateVN(doc.docDueDate)}</dd></div>
          <div><dt>Kho hàng</dt><dd>{doc.warehouseCode || '—'}</dd></div>
          <div><dt>Người tạo</dt><dd>{doc.createdBy || '—'}</dd></div>
          <div>
            <dt>Trạng thái</dt>
            <dd>
              {isOpen ? <span className="fm-chip fm-chip--open">Mở</span>
                : isCancelled ? <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
                : <span className="fm-chip fm-chip--closed">{DOC_STATUS_LABEL[doc.status] ?? doc.status}</span>}
            </dd>
          </div>
          <div><dt>Chiết khấu đầu chứng từ</dt><dd>{(doc.headerDiscPct ?? 0) > 0 ? `${doc.headerDiscPct}% (${formatVND(doc.headerDiscAmt ?? 0)})` : '—'}</dd></div>
          {/* Phase 2 — Số dư chưa khấu trừ (chỉ Hóa đơn đặt cọc phải thu).
              API trả Decimal serialize thành chuỗi → Number() để chắc chắn */}
          {showRemaining && doc.remainingAmount != null && (
            <div><dt>Số dư chưa khấu trừ</dt><dd><b style={{ color: 'var(--fm-navy)' }}>{formatVND(Number(doc.remainingAmount ?? 0))}</b></dd></div>
          )}
          <div>
            <dt>Đồng bộ SAP B1</dt>
            <dd>
              {doc.sapSyncStatus === 'synced' ? (
                <span className="fm-chip fm-chip--sap" title={doc.sapSyncedAt ? `Đẩy thành công lúc ${new Date(doc.sapSyncedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` : undefined}>
                  Đã đẩy{doc.sapDocNum ? ` — DocNum ${doc.sapDocNum}` : ''}
                </span>
              ) : doc.sapSyncStatus === 'pending' ? (
                <span className="fm-chip fm-chip--overdue">Chờ đẩy / đẩy lỗi</span>
              ) : (
                <span className="fm-chip fm-chip--role">Chưa đẩy</span>
              )}
            </dd>
          </div>
          <div><dt>Ghi chú</dt><dd>{doc.remarks || '—'}</dd></div>
        </dl>
      </div>

      {/* Đợt 2 — Thông tin B2B / SAP B1 (chỉ hiện khi có dữ liệu) */}
      {(() => {
        const attList = parseAttachments(doc.attachmentsJson)
        const hasB2b =
          doc.salesPersonCode != null ||
          doc.paymentGroupCode != null ||
          !!doc.numAtCard ||
          !!doc.taxDate ||
          !!doc.projectCode ||
          !!doc.shipToCode ||
          !!doc.billToCode ||
          (doc.docCurrency != null && doc.docCurrency !== 'VND') ||
          (doc.docRate != null && doc.docRate !== 1) ||
          attList.length > 0
        if (!hasB2b) return null
        return (
          <div className="fm-card" style={{ marginBottom: 16 }}>
            <h2 className="fm-card__title">Thông tin B2B / SAP B1</h2>
            <dl className="fm-view-detail">
              {doc.salesPersonCode != null && <div><dt>Nhân viên bán hàng</dt><dd>{doc.salesPersonCode}</dd></div>}
              {doc.paymentGroupCode != null && <div><dt>Điều khoản thanh toán</dt><dd>{doc.paymentGroupCode}</dd></div>}
              {doc.numAtCard && <div><dt>Số PO của khách hàng</dt><dd>{doc.numAtCard}</dd></div>}
              {doc.taxDate && <div><dt>Ngày tính thuế</dt><dd>{formatDateVN(doc.taxDate)}</dd></div>}
              {((doc.docCurrency != null && doc.docCurrency !== 'VND') || (doc.docRate != null && doc.docRate !== 1)) && (
                <div><dt>Tiền tệ / Tỷ giá</dt><dd>{doc.docCurrency || 'VND'} — {doc.docRate ?? 1}</dd></div>
              )}
              {doc.projectCode && <div><dt>Mã dự án</dt><dd>{doc.projectCode}</dd></div>}
              {doc.shipToCode && <div><dt>Địa chỉ giao hàng</dt><dd>{doc.shipToCode}</dd></div>}
              {doc.billToCode && <div><dt>Địa chỉ ghi hóa đơn</dt><dd>{doc.billToCode}</dd></div>}
              {attList.length > 0 && (
                <div>
                  <dt>Đính kèm</dt>
                  <dd>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {attList.map((a, i) => (
                        <li key={i}>
                          {a.url
                            ? <a href={a.url} target="_blank" rel="noreferrer">{a.name || a.url}</a>
                            : (a.name || '—')}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )
      })()}

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
                <th className="fm-num">Số lượng</th>
                <th>Đơn vị tính</th>
                <th>Kho</th>
                {showBatchNumberCol && <th title="Số lô (SAP BatchNumbers) — truy xuất nguồn gốc">Số lô</th>}
                <th className="fm-num">Đơn giá</th>
                <th className="fm-num">Chiết khấu (%)</th>
                <th className="fm-num">Sau chiết khấu</th>
                <th className="fm-num">Thuế (%)</th>
                <th className="fm-num">Tiền dòng (sau thuế)</th>
              </tr>
            </thead>
            <tbody>
              {bomView.visible.map((line, i) => {
                const afterDisc = line.unitPrice * line.quantity * (1 - (line.discPct ?? 0) / 100)
                const vatAmt = afterDisc * ((line.vatPct ?? 0) / 100)
                const isChild = Boolean(line.isBomChild)
                const isBomParent = !isChild && Boolean(line.bomGroupKey)
                return (
                  <tr key={line.id || i} className={isChild ? 'is-bom-child' : isBomParent ? 'is-bom-parent' : undefined}>
                    <td>{isChild ? '' : bomView.stt.get(line)}</td>
                    <th scope="row">
                      {isChild && <span className="fm-bom-branch" aria-hidden>└─ </span>}
                      <b>{line.itemCode}</b>
                      {isBomParent && (
                        <span className="fm-chip fm-chip--bom" title="Mặt hàng BOM — các dòng con bên dưới thuộc công thức của mặt hàng này">BOM</span>
                      )}
                    </th>
                    <td>{line.itemName}</td>
                    <td className="fm-num">{line.quantity}</td>
                    <td>{line.uom || '—'}</td>
                    <td>{line.warehouseCode || '—'}</td>
                    {showBatchNumberCol && <td>{line.batchNumber || '—'}</td>}
                    <td className="fm-num">{formatVND(line.unitPrice)}</td>
                    <td className="fm-num">{line.discPct ?? 0}%</td>
                    <td className="fm-num">{formatVND(afterDisc)}</td>
                    <td className="fm-num">{line.vatPct ?? 0}%</td>
                    <td className="fm-num"><b>{formatVND(afterDisc + vatAmt)}</b></td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={footSpan} style={{ textAlign: 'right' }}>Tổng trước chiết khấu:</td>
                <td className="fm-num">{formatVND(doc.totalBeforeDisc)}</td>
              </tr>
              <tr>
                <td colSpan={footSpan} style={{ textAlign: 'right' }}>Chiết khấu các dòng:</td>
                <td className="fm-num">{doc.discountAmt > 0 ? `−${formatVND(doc.discountAmt)}` : formatVND(0)}</td>
              </tr>
              {(doc.headerDiscAmt ?? 0) > 0 && (
                <tr>
                  <td colSpan={footSpan} style={{ textAlign: 'right' }}>Chiết khấu đầu chứng từ ({doc.headerDiscPct ?? 0}%):</td>
                  <td className="fm-num">−{formatVND(doc.headerDiscAmt ?? 0)}</td>
                </tr>
              )}
              <tr>
                <td colSpan={footSpan} style={{ textAlign: 'right' }}>Sau chiết khấu:</td>
                <td className="fm-num">{formatVND(doc.totalBeforeDisc - doc.discountAmt - (doc.headerDiscAmt ?? 0))}</td>
              </tr>
              <tr>
                <td colSpan={footSpan} style={{ textAlign: 'right' }}>Thuế các dòng:</td>
                <td className="fm-num">{formatVND(doc.vatAmt)}</td>
              </tr>
              <tr>
                <td colSpan={footSpan} style={{ textAlign: 'right' }}><b>Tổng chứng từ:</b></td>
                <td className="fm-num"><b>{formatVND(doc.grandTotal)}</b></td>
              </tr>
            </tfoot>
          </table>
          {/* Mobile (<=640px): card thay cho bảng 11 cột cuộn ngang */}
          <div className="fm-lcard-list">
            {bomView.visible.filter((l) => !l.isBomChild).map((line, i) => {
              const afterDisc = line.unitPrice * line.quantity * (1 - (line.discPct ?? 0) / 100)
              const vatAmt = afterDisc * ((line.vatPct ?? 0) / 100)
              const isBomParent = Boolean(line.bomGroupKey)
              const children = isBomParent ? bomView.visible.filter((l) => l.isBomChild && l.bomGroupKey === line.bomGroupKey) : []
              return (
                <div key={line.id || i} className="fm-lcard">
                  <div className="fm-lcard__head">
                    <span className="fm-lcard__num">{i + 1}</span>
                    <div>
                      <div className="fm-lcard__name">{line.itemName}
                        {isBomParent && <span className="fm-chip fm-chip--bom">BOM</span>}
                      </div>
                      <div className="fm-lcard__code">{line.itemCode} · {line.uom || '—'} · Kho {line.warehouseCode || '—'}{showBatchNumberCol && line.batchNumber ? ` · Lô ${line.batchNumber}` : ''}</div>
                    </div>
                  </div>
                  <div className="fm-lcard__grid">
                    <div><span className="k">Số lượng</span><span className="v">{line.quantity}</span></div>
                    <div><span className="k">Đơn giá</span><span className="v">{formatVND(line.unitPrice)}</span></div>
                    <div><span className="k">CK</span><span className="v">{line.discPct ?? 0}%</span></div>
                    <div><span className="k">VAT</span><span className="v">{line.vatPct ?? 0}%</span></div>
                  </div>
                  {children.length > 0 && (
                    <div className="fm-lcard__bom">
                      <div className="fm-lcard__bom-title">Thành phần ({children.length}):</div>
                      {children.map((c, ci) => (
                        <div key={c.id || ci} className="fm-lcard__bom-row">
                          <span aria-hidden>└─ </span>{c.itemCode} — {c.itemName} × {c.quantity} {c.uom}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="fm-lcard__total">
                    <span>Thành tiền (sau thuế)</span>
                    <b>{formatVND(afterDisc + vatAmt)}</b>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

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
