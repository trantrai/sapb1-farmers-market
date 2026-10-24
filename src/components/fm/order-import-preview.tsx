'use client'

// ============================================================
// XEM TRƯỚC NHẬP EXCEL — hiện kết quả khớp từng dòng trước khi điền vào đơn:
// khớp mã · khớp mã vạch · tên gần đúng (chọn ứng viên) · không tìm thấy ·
// lỗi dữ liệu. Người dùng tick/bỏ tick; chỉ dòng được chọn mới điền vào đơn.
// ============================================================

import { useMemo, useState } from 'react'
import { AlertOctagon, AlertTriangle, CheckCircle2, FileSpreadsheet, X } from 'lucide-react'
import { useFocusTrap } from './use-focus-trap'
import type { ImportItem, ImportMatch, ImportRowError, ParsedImportRow } from '@/lib/order-import'

export interface ImportPreviewData {
  fileName: string
  templateName: string
  rows: { parsed: ParsedImportRow; match: ImportMatch }[]
  errors: ImportRowError[]
}

export interface ImportPick {
  parsed: ParsedImportRow
  item: ImportItem
}

type Status = 'code' | 'barcode' | 'name' | 'mismatch' | 'none' | 'invalid'

const STATUS_LABEL: Record<Status, string> = {
  code: 'Khớp mã',
  barcode: 'Khớp mã vạch',
  name: 'Tên gần đúng',
  mismatch: 'Tên khác danh mục',
  none: 'Không tìm thấy',
  invalid: 'Lỗi dữ liệu',
}
const STATUS_TONE: Record<Status, 'ok' | 'warn' | 'error'> = {
  code: 'ok', barcode: 'ok', name: 'warn', mismatch: 'warn', none: 'error', invalid: 'error',
}

const fmtQty = (n: number) => n.toLocaleString('vi-VN', { maximumFractionDigits: 3 })

export default function OrderImportPreview({ data, onConfirm, onCancel }: {
  data: ImportPreviewData
  onConfirm: (picks: ImportPick[]) => void
  onCancel: () => void
}) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel)

  // Mặt hàng chọn cho từng dòng (theo excelRow) + dòng có được nhập không
  const [picked, setPicked] = useState<Record<number, string>>(() =>
    Object.fromEntries(data.rows.filter((r) => r.match.item).map((r) => [r.parsed.excelRow, r.match.item!.itemCode])),
  )
  const [included, setIncluded] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(data.rows.map((r) => [r.parsed.excelRow, Boolean(r.match.item)])),
  )
  const [onlyReview, setOnlyReview] = useState(false)

  type ViewRow =
    | { kind: 'row'; excelRow: number; status: Status; parsed: ParsedImportRow; match: ImportMatch }
    | { kind: 'error'; excelRow: number; status: 'invalid'; err: ImportRowError }
  const all = useMemo<ViewRow[]>(() => {
    const rows: ViewRow[] = data.rows.map(({ parsed, match }) => ({
      kind: 'row', excelRow: parsed.excelRow, parsed, match,
      status: match.kind === 'none' ? 'none' : match.nameMismatch ? 'mismatch' : match.kind,
    }))
    const errs: ViewRow[] = data.errors.map((err) => ({ kind: 'error', excelRow: err.excelRow, status: 'invalid', err }))
    return [...rows, ...errs].sort((a, b) => a.excelRow - b.excelRow)
  }, [data])

  const counts = all.reduce<Record<Status, number>>(
    (m, r) => ({ ...m, [r.status]: m[r.status] + 1 }),
    { code: 0, barcode: 0, name: 0, mismatch: 0, none: 0, invalid: 0 },
  )
  const needReview = all.filter((r) => STATUS_TONE[r.status] !== 'ok').length
  const visible = onlyReview ? all.filter((r) => STATUS_TONE[r.status] !== 'ok') : all

  const itemFor = (r: { parsed: ParsedImportRow; match: ImportMatch }): ImportItem | null => {
    const code = picked[r.parsed.excelRow]
    if (!code) return null
    if (r.match.item?.itemCode === code) return r.match.item
    return r.match.candidates.find((c) => c.item.itemCode === code)?.item ?? null
  }
  const picks: ImportPick[] = data.rows.flatMap((r) => {
    const item = included[r.parsed.excelRow] ? itemFor(r) : null
    return item ? [{ parsed: r.parsed, item }] : []
  })
  const skipped = all.length - picks.length

  const selectable = data.rows.filter((r) => itemFor(r))
  const allOn = selectable.length > 0 && selectable.every((r) => included[r.parsed.excelRow])
  const toggleAll = () =>
    setIncluded((m) => ({ ...m, ...Object.fromEntries(selectable.map((r) => [r.parsed.excelRow, !allOn])) }))

  return (
    <div className="fm-backdrop" onClick={onCancel}>
      <div
        ref={trapRef}
        className="fm-modal fm-modal--wide fm-import-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fm-import-preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fm-import-preview__head">
          <h3 id="fm-import-preview-title" className="fm-modal__title">
            <FileSpreadsheet size={18} aria-hidden /> Xem trước nhập Excel
          </h3>
          <button type="button" className="fm-icon-btn" aria-label="Đóng" onClick={onCancel}><X size={16} /></button>
        </div>
        <p className="fm-import-preview__file">
          <b>{data.fileName}</b> · mẫu “{data.templateName}” · {all.length} dòng
        </p>

        <div className="fm-import-preview__summary" aria-label="Tóm tắt kết quả khớp">
          {(Object.keys(STATUS_LABEL) as Status[]).filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className={`fm-import-tag is-${STATUS_TONE[s]}`}>{STATUS_LABEL[s]}: {counts[s]}</span>
          ))}
          {needReview > 0 && (
            <label className="fm-import-preview__filter">
              <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
              Chỉ hiện {needReview} dòng cần xem
            </label>
          )}
        </div>

        <div className="fm-import-preview__list fm-scroll">
          <table className="fm-table fm-stack-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allOn} onChange={toggleAll} disabled={selectable.length === 0} aria-label="Chọn tất cả dòng nhập được" />
                </th>
                <th style={{ width: 56 }}>Dòng</th>
                <th>Trong file</th>
                <th className="fm-num" style={{ width: 80 }}>SL</th>
                <th>Mặt hàng sẽ nhập</th>
                <th style={{ width: 150 }}>Kết quả</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                if (r.kind === 'error') {
                  return (
                    <tr key={`e${r.excelRow}`} className="is-invalid">
                      <td data-label=""><input type="checkbox" disabled checked={false} aria-label={`Dòng ${r.excelRow} không nhập được`} /></td>
                      <td data-label="Dòng">{r.excelRow}</td>
                      <td data-label="Trong file"><FileCell code={r.err.code} name={r.err.name} /></td>
                      <td data-label="SL" className="fm-num">—</td>
                      <td data-label="Mặt hàng" className="fm-import-preview__err">{r.err.message}</td>
                      <td data-label="Kết quả"><StatusTag status="invalid" /></td>
                    </tr>
                  )
                }
                const { parsed, match, excelRow } = r
                const item = itemFor(r)
                const on = Boolean(included[excelRow] && item)
                return (
                  <tr key={excelRow} className={on ? undefined : 'is-off'}>
                    <td data-label="">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!item}
                        onChange={(e) => setIncluded((m) => ({ ...m, [excelRow]: e.target.checked }))}
                        aria-label={`Nhập dòng ${excelRow}`}
                      />
                    </td>
                    <td data-label="Dòng">{excelRow}</td>
                    <td data-label="Trong file"><FileCell code={parsed.code} name={parsed.name} /></td>
                    <td data-label="SL" className="fm-num">{fmtQty(parsed.quantity)}{parsed.uom ? ` ${parsed.uom}` : ''}</td>
                    <td data-label="Mặt hàng" data-full={match.kind === 'name' ? '' : undefined}>
                      {match.kind === 'name' ? (
                        <select
                          className="fm-select fm-import-preview__pick"
                          value={picked[excelRow] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            setPicked((m) => ({ ...m, [excelRow]: v }))
                            setIncluded((m) => ({ ...m, [excelRow]: Boolean(v) }))
                          }}
                          aria-label={`Chọn mặt hàng cho dòng ${excelRow}`}
                        >
                          <option value="">— Chọn mặt hàng —</option>
                          {match.candidates.map((c) => (
                            <option key={c.item.itemCode} value={c.item.itemCode}>
                              {c.item.itemCode} — {c.item.itemName} ({Math.round(c.score * 100)}%)
                            </option>
                          ))}
                        </select>
                      ) : item ? (
                        <span><b>{item.itemCode}</b> — {item.itemName}</span>
                      ) : (
                        <span className="fm-import-preview__err">Không có trong danh mục</span>
                      )}
                    </td>
                    <td data-label="Kết quả"><StatusTag status={r.status} /></td>
                  </tr>
                )
              })}
              {visible.length === 0 && (
                <tr><td colSpan={6} data-label="" className="fm-hint">Không có dòng nào cần xem.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="fm-import-preview__foot">
          <span className="fm-hint" aria-live="polite">
            Sẽ điền <b>{picks.length}</b> dòng{skipped > 0 ? ` · bỏ qua ${skipped} dòng` : ''}. Giá, VAT, tồn kho được tính lại sau khi điền.
          </span>
          <button type="button" className="fm-btn fm-btn--secondary" onClick={onCancel}>Hủy</button>
          <button type="button" className="fm-btn fm-btn--primary" disabled={picks.length === 0} onClick={() => onConfirm(picks)}>
            Điền {picks.length} dòng vào đơn
          </button>
        </div>
      </div>
    </div>
  )
}

function FileCell({ code, name }: { code: string; name: string }) {
  return (
    <span className="fm-import-preview__src">
      {code ? <b>{code}</b> : <i>(không mã)</i>}
      {name ? <span>{name}</span> : null}
    </span>
  )
}

function StatusTag({ status }: { status: Status }) {
  const tone = STATUS_TONE[status]
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : AlertOctagon
  return (
    <span className={`fm-import-tag is-${tone}`}>
      <Icon size={13} aria-hidden /> {STATUS_LABEL[status]}
    </span>
  )
}
