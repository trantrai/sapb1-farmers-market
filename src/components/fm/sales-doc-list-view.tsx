'use client'

// ============================================================
// DANH SÁCH chứng từ Sales A/R dùng chung cho 4 loại Phase 1:
// Báo giá bán hàng · Hóa đơn bán hàng · Phiếu ghi có phải thu · Phiếu trả hàng bán
// Mirror theo orders-list-view: filter/search debounce/phân trang,
// nút Tải lại + Xuất Excel, chip SAP B1, xóa dòng có xác nhận.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { Filter, Plus, RotateCcw, Trash2, Search, Inbox, RefreshCw, Download } from 'lucide-react'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import type { SessionUser } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import FmPagination from './fm-pagination'
import PageHeader from './page-header'
import ConfirmDialog, { type ConfirmTone } from './confirm-dialog'
import {
  DOC_STATUS_LABEL,
  docNumLabel,
  hasPerm,
  type DocKindConfig,
  type SalesDoc,
} from './sales-doc-shared'

interface Props {
  config: DocKindConfig
  /** Optional: khi có, các nút Tạo/Xóa được gating theo quyền; không có thì ẩn */
  user?: SessionUser
  onGoDetail: (id: string) => void
  onGoNew: () => void
  refreshKey?: number
}

/** Chip trạng thái đẩy chứng từ sang SAP B1.
 *  Phase 1: API tự đẩy khi tạo (nếu đã cấu hình SAP), chưa có endpoint đẩy
 *  lại thủ công — chip chỉ hiển thị, không bấm được. */
function sapChip(o: SalesDoc) {
  if (o.sapSyncStatus === 'synced') {
    return (
      <span
        className="fm-chip fm-chip--sap"
        title={`DocEntry ${o.sapDocEntry ?? '—'}${o.sapSyncedAt ? ` · đồng bộ lúc ${formatDateVN(o.sapSyncedAt)}` : ''}`}
      >
        SAP #{o.sapDocNum ?? '?'}
      </span>
    )
  }
  if (o.sapSyncStatus === 'pending') {
    return (
      <span className="fm-chip fm-chip--pending" title={o.sapSyncError ?? 'Chưa đẩy được sang SAP B1'}>
        Chưa đẩy
      </span>
    )
  }
  return (
    <span className="fm-chip fm-chip--closed" title="Chưa cấu hình SAP B1 — chứng từ chỉ lưu local">
      —
    </span>
  )
}

function statusChip(status: string) {
  if (status === 'Open') return <span className="fm-chip fm-chip--open">Mở</span>
  if (status === 'Cancelled') return <span className="fm-chip fm-chip--cancelled">Đã hủy</span>
  return <span className="fm-chip fm-chip--closed">{DOC_STATUS_LABEL[status] ?? status}</span>
}

/** Phase 2 — chip "Nháp" trên dòng chứng từ nháp (kiểu dáng giống chip trạng thái) */
function draftChip(o: SalesDoc) {
  return o.isDraft ? <span className="fm-chip fm-chip--warn" title="Bản nháp — chưa có hiệu lực">Nháp</span> : null
}

export default function SalesDocListView({ config, user, onGoDetail, onGoNew, refreshKey }: Props) {
  const { apiBase, docLabel, permModule } = config
  const [docs, setDocs] = useState<SalesDoc[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(8)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [q, setQ] = useState('')
  /** Từ khóa đã debounce 300ms — API chỉ gọi theo giá trị này */
  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300)
    return () => clearTimeout(t)
  }, [q])
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  /** Phase 2 — lọc nhanh theo trạng thái nháp: '' | 'true' | 'false' (→ ?isDraft=) */
  const [draftFilter, setDraftFilter] = useState<'' | 'true' | 'false'>('')

  const [alert, setAlert] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [sapWarn, setSapWarn] = useState('')

  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    // Guard chống race: filter đổi nhanh → response cũ về sau phải bị bỏ
    const seq = ++loadSeq.current
    try {
      const sp = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (debouncedQ) sp.set('q', debouncedQ)
      if (status) sp.set('status', status)
      if (from) sp.set('from', from)
      if (to) sp.set('to', to)
      if (draftFilter) sp.set('isDraft', draftFilter)
      const res = await api(`/api/${apiBase}?${sp.toString()}`)
      if (seq !== loadSeq.current) return
      if (res.status === 401) { window.location.reload(); return }
      let json: { data?: SalesDoc[]; total?: number; totalPages?: number; warning?: string; error?: string }
      try {
        const text = await res.text()
        json = text ? JSON.parse(text) : {}
      } catch {
        json = {}
      }
      if (!res.ok) {
        setAlert({ type: 'error', msg: json.error ?? `Tải danh sách ${docLabel} thất bại (HTTP ${res.status})` })
        setDocs([])
        setTotal(0)
        setTotalPages(1)
        return
      }
      setDocs(json.data ?? [])
      setTotal(json.total ?? 0)
      setTotalPages(json.totalPages ?? 1)
      setSapWarn(json.warning ?? '')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [apiBase, docLabel, page, pageSize, debouncedQ, status, from, to, draftFilter])

  useEffect(() => { load() }, [load, refreshKey])

  const resetFilter = () => { setQ(''); setStatus(''); setFrom(''); setTo(''); setDraftFilter(''); setPage(1) }

  const openDetail = (o: SalesDoc) => onGoDetail(o.id)

  const deleteDoc = async (o: SalesDoc) => {
    if (deletingId) return
    setConfirmCfg(null)
    setDeletingId(o.id)
    try {
      const res = await api(`/api/${apiBase}/${o.id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAlert({ type: 'error', msg: json.error ?? `Không thể xóa ${docLabel}` })
        return
      }
      setDocs((os) => os.filter((x) => x.id !== o.id))
      setAlert({ type: 'success', msg: `Đã xóa ${docLabel} ${docNumLabel(o.docNum, o.isDraft)}` })
      load()
    } finally {
      setDeletingId(null)
    }
  }

  const askDelete = (o: SalesDoc) => {
    setConfirmCfg({
      title: `Xóa ${docLabel}`,
      message: `Xóa ${docLabel} ${docNumLabel(o.docNum, o.isDraft)} — ${o.cardName}?\nHành động không thể hoàn tác.`,
      confirmLabel: `Xóa ${docLabel}`,
      tone: 'danger',
      run: () => { void deleteDoc(o) },
    })
  }

  /** Tham số bộ lọc chung cho xuất Excel — xuất TOÀN BỘ kết quả đã lọc, không chỉ trang hiện tại */
  const filterParams = () => {
    const sp = new URLSearchParams()
    if (debouncedQ) sp.set('q', debouncedQ)
    if (status) sp.set('status', status)
    if (from) sp.set('from', from)
    if (to) sp.set('to', to)
    if (draftFilter) sp.set('isDraft', draftFilter)
    return sp
  }

  const fetchAllFiltered = async (): Promise<SalesDoc[]> => {
    const sp = filterParams()
    const fetchPage = async (p: number): Promise<{ data?: SalesDoc[]; totalPages?: number; error?: string }> => {
      const res = await api(`/api/${apiBase}?page=${p}&pageSize=50&${sp.toString()}`)
      let json: { data?: SalesDoc[]; totalPages?: number; error?: string }
      try {
        const text = await res.text()
        json = text ? JSON.parse(text) : {}
      } catch {
        json = {}
      }
      if (!res.ok) throw new Error(json.error ?? `Tải dữ liệu xuất thất bại (HTTP ${res.status})`)
      return json
    }
    const first = await fetchPage(1)
    const all = [...(first.data ?? [])]
    const tp = first.totalPages ?? 1
    for (let p = 2; p <= tp; p++) {
      const j = await fetchPage(p)
      all.push(...(j.data ?? []))
    }
    return all
  }

  const [exporting, setExporting] = useState(false)

  const exportExcel = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const all = await fetchAllFiltered()
      if (all.length === 0) {
        setAlert({ type: 'error', msg: `Không có ${docLabel} nào phù hợp bộ lọc để xuất` })
        return
      }
      // B4: lazy load xlsx chỉ khi xuất
      const XLSX = await import('xlsx')

      // Sheet 1: Danh sách chứng từ
      const headerRows = all.map((o, i) => ({
        'STT': i + 1,
        'Số chứng từ': o.docNum,
        'Ngày chứng từ': formatDateVN(o.docDate),
        'Hạn': formatDateVN(o.docDueDate),
        'Mã khách hàng': o.cardCode,
        'Tên khách hàng': o.cardName,
        'Trạng thái': DOC_STATUS_LABEL[o.status] ?? o.status,
        'Tổng chứng từ': o.grandTotal,
        'Ghi chú': o.remarks ?? '',
      }))
      const ws1 = XLSX.utils.json_to_sheet(headerRows)

      // Sheet 2: Chi tiết dòng hàng
      const detailRows: Record<string, string | number>[] = []
      for (const o of all) {
        for (const l of o.lines ?? []) {
          detailRows.push({
            'Số chứng từ': o.docNum,
            'Mã hàng': l.itemCode,
            'Tên hàng': l.itemName,
            'Số lượng': l.quantity,
            'Đơn vị tính': l.uom ?? '',
            'Đơn giá': l.unitPrice,
            'Chiết khấu %': l.discPct ?? 0,
            'Thuế %': l.vatPct ?? 0,
            'Thành tiền': l.grandTotal ?? l.quantity * l.unitPrice,
          })
        }
      }
      const ws2 = XLSX.utils.json_to_sheet(detailRows)

      // Style header: in đậm + nền vàng nhạt
      const headerStyle = { font: { bold: true }, fill: { fgColor: { rgb: 'FFFDE7' } } }
      for (const ws of [ws1, ws2]) {
        const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = ws[XLSX.utils.encode_cell({ r: 0, c })]
          if (cell) cell.s = headerStyle
        }
      }
      ws1['!cols'] = [
        { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 32 }, { wch: 12 }, { wch: 16 }, { wch: 30 },
      ]
      ws2['!cols'] = [
        { wch: 10 }, { wch: 16 }, { wch: 34 }, { wch: 10 }, { wch: 10 },
        { wch: 14 }, { wch: 8 }, { wch: 8 }, { wch: 16 },
      ]

      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws1, 'Chung tu')
      XLSX.utils.book_append_sheet(wb, ws2, 'Chi tiet')

      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const fname = `${apiBase}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.xlsx`
      XLSX.writeFile(wb, fname)
      setAlert({ type: 'success', msg: `Đã xuất ${all.length} ${docLabel} (toàn bộ kết quả đã lọc) ra file ${fname}` })
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Xuất Excel thất bại' })
    } finally {
      setExporting(false)
    }
  }

  const canCreate = user ? hasPerm(user, permModule, 'create') : false
  const canDelete = user ? hasPerm(user, permModule, 'delete') : false
  // Dialog xác nhận thay window.confirm() — 1 state dùng chung cho mọi action
  const [confirmCfg, setConfirmCfg] = useState<{
    title: string
    message: string
    confirmLabel?: string
    tone?: ConfirmTone
    run: () => void
  } | null>(null)

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', `Danh sách ${docLabel}`]}
        title={`Danh sách ${docLabel}`}
        badge="Làm mới mỗi 45 giây"
        actions={<>
          <button className="fm-btn fm-btn--secondary" onClick={() => load()}><RefreshCw size={14} /> Tải lại</button>
          <button className="fm-btn fm-btn--secondary" onClick={exportExcel} disabled={exporting}><Download size={14} /> {exporting ? 'Đang xuất…' : 'Xuất Excel'}</button>
        </>}
      />
      {alert && (
        <div className={`fm-alert ${alert.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={alert.type === 'error' ? 'alert' : 'status'}>
          <div><b>{alert.type === 'success' ? 'Thành công' : 'Lỗi'}</b>{' '}{alert.msg}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <div className="fm-card">
        {/* Lọc nhanh theo trạng thái nháp (Phase 2) */}
        <div className="fm-quickfilter" role="group" aria-label="Lọc nhanh theo bản nháp">
          {([
            { key: '', label: 'Tất cả' },
            { key: 'false', label: 'Chính thức' },
            { key: 'true', label: 'Nháp' },
          ] as const).map((f) => (
            <button
              key={f.key}
              type="button"
              className={`fm-btn fm-btn--sm ${draftFilter === f.key ? 'fm-btn--primary' : 'fm-btn--secondary'}`}
              onClick={() => { setDraftFilter(f.key); setPage(1) }}
              aria-pressed={draftFilter === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'flex-end', marginBottom: 14 }}>
          {canCreate && (
            <button className="fm-btn fm-btn--primary" onClick={onGoNew}>
              <Plus size={16} style={{ verticalAlign: -2, marginRight: 4 }} /> Tạo {docLabel}
            </button>
          )}
        </div>

        <div className="fm-filterbar">
          <div style={{ position: 'relative' }} data-search>
            <input
              className="fm-input"
              style={{ paddingLeft: 32 }}
              placeholder="Số chứng từ, số PO, mã/tên khách hàng…"
              aria-label={`Tìm kiếm ${docLabel} theo số chứng từ, số PO, mã hoặc tên khách hàng`}
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1) }}
            />
            <Search size={14} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--fm-text-3)' }} />
          </div>
          <select className="fm-select" aria-label="Lọc theo trạng thái" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">Tất cả trạng thái</option>
            <option value="Open">Mở</option>
            <option value="Closed">Đã đóng</option>
            <option value="Cancelled">Đã hủy</option>
          </select>
          <input type="date" className="fm-datepicker" title="Từ ngày" aria-label="Lọc từ ngày" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} />
          <input type="date" className="fm-datepicker" title="Đến ngày" aria-label="Lọc đến ngày" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} />
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={resetFilter}>
            <RotateCcw size={14} style={{ verticalAlign: -2, marginRight: 4 }} /> Đặt lại
          </button>
          <div className="fm-filterbar__spacer" />
          <span className="fm-chip fm-chip--role"><Filter size={14} style={{ verticalAlign: -1, marginRight: 3 }} />{total} kết quả</span>
        </div>

        {/* Cảnh báo SAP lỗi khi load danh sách */}
        {sapWarn && (
          <div className="fm-hint" style={{ color: 'var(--fm-red)', marginBottom: 8 }} role="alert">⚠ {sapWarn}</div>
        )}

        {/* Bảng dữ liệu */}
        {loading ? (
          <div aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="fm-skeleton fm-skeleton--row" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="fm-empty">
            <Inbox />
            Không có {docLabel} phù hợp bộ lọc
            {canCreate && (
              <button type="button" className="fm-btn fm-btn--primary" style={{ marginTop: 10 }} onClick={onGoNew}>
                <Plus size={16} /> Tạo {docLabel}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Bảng (desktop) */}
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Số chứng từ</th>
                    <th>Mã khách hàng</th>
                    <th>Khách hàng</th>
                    <th>Ngày chứng từ</th>
                    <th>Hạn</th>
                    <th>Trạng thái</th>
                    <th>SAP B1</th>
                    <th className="fm-num">Tổng chứng từ</th>
                    <th><span className="fm-sr-only">Thao tác</span></th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map((o) => (
                    <tr
                      key={o.id}
                      style={{ cursor: deletingId === o.id ? 'wait' : 'pointer', opacity: deletingId === o.id ? 0.55 : undefined }}
                      title={deletingId === o.id ? `Đang xóa ${docLabel}…` : 'Bấm để xem chi tiết'}
                      tabIndex={0}
                      aria-label={deletingId === o.id ? `Đang xóa ${docLabel} ${docNumLabel(o.docNum, o.isDraft)}` : `Xem chi tiết ${docLabel} ${docNumLabel(o.docNum, o.isDraft)} — ${o.cardName}`}
                      aria-busy={deletingId === o.id || undefined}
                      onClick={() => { if (deletingId !== o.id) openDetail(o) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openDetail(o)
                        }
                      }}
                    >
                      <th scope="row"><b>{docNumLabel(o.docNum, o.isDraft)}</b>{o.isDraft && <span className="fm-chip fm-chip--warn" title="Bản nháp — chưa có hiệu lực">Nháp</span>}</th>
                      <td>{o.cardCode}</td>
                      <td>{o.cardName}</td>
                      <td>{formatDateVN(o.docDate)}</td>
                      <td>{formatDateVN(o.docDueDate)}</td>
                      <td>{statusChip(o.status)}{draftChip(o)}</td>
                      <td>{sapChip(o)}</td>
                      <td className="fm-num"><b>{formatVND(o.grandTotal)}</b></td>
                      <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        {canDelete && o.source !== 'sap' && (
                          <button className="fm-row-del" title={deletingId === o.id ? 'Đang xóa…' : `Xóa ${docLabel}`} aria-label={deletingId === o.id ? `Đang xóa ${docLabel}` : `Xóa ${docLabel}`} disabled={deletingId === o.id} onClick={() => askDelete(o)}>
                            {deletingId === o.id ? <span className="fm-spin" style={{ width: 14, height: 14, border: '2px solid var(--fm-line)', borderTopColor: 'var(--fm-red)', borderRadius: '50%', display: 'inline-block' }} /> : <Trash2 size={14} />}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Danh sách card (mobile) */}
            <div className="fm-only-mobile">
              {docs.map((o) => (
                <div
                  key={o.id}
                  className="fm-ocard"
                  role="button"
                  tabIndex={0}
                  aria-label={`Xem chi tiết ${docLabel} ${docNumLabel(o.docNum, o.isDraft)} — ${o.cardName}`}
                  onClick={() => openDetail(o)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail(o)
                    }
                  }}
                >
                  <div className="fm-ocard__top">
                    <span className="fm-ocard__num">{docNumLabel(o.docNum, o.isDraft)}</span>
                    {statusChip(o.status)}
                    {draftChip(o)}
                    {sapChip(o)}
                  </div>
                  <div>
                    <div className="fm-ocard__name">{o.cardName}</div>
                    <div className="fm-ocard__meta">{o.cardCode}</div>
                  </div>
                  <div className="fm-ocard__meta">
                    Ngày chứng từ {formatDateVN(o.docDate)} · Hạn {formatDateVN(o.docDueDate)}
                  </div>
                  <div className="fm-ocard__bottom">
                    <span className="fm-ocard__total">{formatVND(o.grandTotal)}</span>
                    {canDelete && o.source !== 'sap' && (
                      <button
                        className="fm-ocard__del"
                        title={`Xóa ${docLabel}`}
                        aria-label={`Xóa ${docLabel} ${o.docNum}`}
                        onClick={(e) => { e.stopPropagation(); askDelete(o) }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Phân trang */}
            <FmPagination page={page} totalPages={totalPages} onPage={setPage} />
          </>
        )}
      </div>

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
