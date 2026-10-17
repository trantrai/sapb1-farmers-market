'use client'

// ============================================================
// FORM tạo/sửa Phiếu giao hàng — standalone, đơn giản hơn
// order-form-view (không BOM, không ATP).
// - Chế độ TẠO (deliveryId undefined): chọn khách hàng, ngày chứng từ,
//   ghi chú, thêm dòng mặt hàng → POST /api/deliveries
// - Chế độ SỬA (deliveryId có giá trị): tải phiếu qua GET, khách hàng
//   chỉ đọc (không đổi được — giữ liên kết đơn nguồn), sửa được ngày
//   chứng từ / ghi chú / SL từng dòng → PUT /api/deliveries/[id]
// Thuật ngữ chuẩn SAP B1. Nút lưu có trạng thái "Đang lưu…".
// ============================================================

import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, Save, Trash2, Copy } from 'lucide-react'
import Autocomplete, { ACOption } from './autocomplete'
import PageHeader from './page-header'
import { formatVND } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import CopyFromPicker from './copy-from-picker'
import type { PrefillDoc } from '@/lib/copy-from'

interface FormLine {
  key: number
  /** Chế độ sửa: id dòng trong DB (để PUT nhận diện) */
  dbId?: string
  item: ACOption | null
  quantity: number
  unitPrice: number
  vatPct: number
}

let keyCounter = 0
const nextKey = () => ++keyCounter

interface Props {
  /** Id phiếu cần sửa — có nghĩa là đang ở chế độ CẬP NHẬT */
  deliveryId?: string
  onSaved: (id: string) => void
  onCancel: () => void
}

export default function DeliveryFormView({ deliveryId, onSaved, onCancel }: Props) {
  const isEdit = Boolean(deliveryId)

  const [partner, setPartner] = useState<ACOption | null>(null)
  const [partnerErr, setPartnerErr] = useState('')
  const [docDate, setDocDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [remarks, setRemarks] = useState('')
  const [lines, setLines] = useState<FormLine[]>([
    { key: nextKey(), item: null, quantity: 1, unitPrice: 0, vatPct: 10 },
  ])
  const [loading, setLoading] = useState(isEdit)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  /** Optimistic locking version (chế độ sửa) */
  const [version, setVersion] = useState<number | undefined>(undefined)
  /** Chế độ sửa: phiếu có liên kết đơn nguồn không (có → khóa thêm/xóa dòng) */
  const [hasSourceOrder, setHasSourceOrder] = useState(false)
  /** "Sao chép từ…" (copy-from): mở picker + thông tin nguồn đã chọn */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copyFromInfo, setCopyFromInfo] = useState<PrefillDoc | null>(null)

  // ---- "Sao chép từ…" (copy-from): điền dữ liệu prefill (?prefill=1) vào form ----
  // Chỉ dùng khi TẠO phiếu mới. SL từng dòng = SL còn mở (OpenQty) của đơn nguồn.
  const applyCopyFrom = (p: PrefillDoc) => {
    setPartner({ code: p.cardCode, name: p.cardName })
    setDocDate((p.docDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10))
    setRemarks(p.remarks ?? '')
    setLines(
      (p.lines ?? []).map((l) => ({
        key: nextKey(),
        item: { code: l.itemCode, name: l.itemName },
        quantity: l.quantity,
        unitPrice: l.unitPrice ?? 0,
        vatPct: l.vatPct ?? 10,
      })),
    )
    setPartnerErr('')
    setSaveError('')
    setCopyFromInfo(p)
    setPickerOpen(false)
  }

  // Tải phiếu khi ở chế độ sửa
  useEffect(() => {
    if (!deliveryId) return
    let cancelled = false
    setLoading(true)
    api(`/api/deliveries/${deliveryId}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return
        const d = j?.delivery ?? j
        if (!ok || !d) {
          setLoadError(j?.error ?? 'Không tải được phiếu giao hàng')
          return
        }
        setPartner({ code: d.cardCode, name: d.cardName })
        setDocDate(String(d.docDate ?? '').slice(0, 10))
        setRemarks(d.remarks ?? '')
        setVersion(d.version)
        setHasSourceOrder(Boolean(d.sourceOrderId ?? d.sourceOrder?.id))
        setLines(
          (d.lines ?? []).map((l: { id: string; itemCode: string; itemName: string; quantity: number; unitPrice: number }) => ({
            key: nextKey(),
            dbId: l.id,
            item: { code: l.itemCode, name: l.itemName },
            quantity: l.quantity,
            unitPrice: l.unitPrice ?? 0,
            vatPct: 10,
          })),
        )
      })
      .catch(() => {
        if (!cancelled) setLoadError('Không kết nối được máy chủ')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [deliveryId])

  const setLine = (key: number, patch: Partial<FormLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }
  const addLine = () => {
    setLines((ls) => [...ls, { key: nextKey(), item: null, quantity: 1, unitPrice: 0, vatPct: 10 }])
  }
  const removeLine = (key: number) => {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls))
  }

  const lineTotal = (l: FormLine) => l.quantity * l.unitPrice
  const grandTotal = lines.reduce((s, l) => s + lineTotal(l), 0)

  const validate = (): boolean => {
    setPartnerErr('')
    setSaveError('')
    if (!partner) {
      setPartnerErr('Vui lòng chọn khách hàng')
      return false
    }
    if (!docDate) {
      setSaveError('Vui lòng chọn ngày chứng từ')
      return false
    }
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (!l.item) {
        setSaveError(`Dòng ${i + 1}: vui lòng chọn mặt hàng`)
        return false
      }
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) {
        setSaveError(`Dòng ${i + 1} (${l.item.code}): số lượng phải > 0`)
        return false
      }
      if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
        setSaveError(`Dòng ${i + 1} (${l.item.code}): đơn giá không hợp lệ`)
        return false
      }
    }
    return true
  }

  const handleSave = async (asDraft = false) => {
    if (saving || !validate()) return
    setSaving(true)
    setSaveError('')
    try {
      if (isEdit) {
        // Sửa: PUT chỉ nhận SL dòng + ngày/ghi chú (khách hàng và dòng hàng giữ nguyên khi có đơn nguồn)
        // Nếu đang sửa bản nháp thì giữ nguyên trạng thái nháp
        const body: Record<string, unknown> = {
          version,
          docDate,
          remarks: remarks.trim() || null,
          lines: lines.map((l) => ({ id: l.dbId, quantity: l.quantity })),
        }
        const r = await api(`/api/deliveries/${deliveryId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) {
          setSaveError(j.error ?? 'Không lưu được phiếu giao hàng')
          return
        }
        onSaved(deliveryId!)
      } else {
        const r = await api(`/api/deliveries${asDraft ? '?draft=true' : ''}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cardCode: partner!.code,
            cardName: partner!.name,
            docDate,
            remarks: remarks.trim() || undefined,
            lines: lines.map((l) => ({
              itemCode: l.item!.code,
              itemName: l.item!.name,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
            })),
          }),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) {
          setSaveError(j.error ?? 'Không tạo được phiếu giao hàng')
          return
        }
        const id = j.delivery?.id ?? j.id
        if (!id) {
          setSaveError('Máy chủ không trả về id phiếu')
          return
        }
        onSaved(id)
      }
    } catch {
      setSaveError('Không kết nối được máy chủ')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader
          breadcrumb={['Chức năng chính', 'Giao hàng', isEdit ? 'Chỉnh sửa' : 'Tạo mới']}
          title={isEdit ? 'Chỉnh sửa phiếu giao hàng' : 'Tạo phiếu giao hàng'}
        />
        <div className="fm-empty">Đang tải…</div>
      </div>
    )
  }

  if (loadError) {
    return (
      <div>
        <PageHeader
          breadcrumb={['Chức năng chính', 'Giao hàng', 'Chỉnh sửa']}
          title="Chỉnh sửa phiếu giao hàng"
          actions={<button className="fm-btn fm-btn--secondary" onClick={onCancel}><ArrowLeft size={16} /> Quay lại</button>}
        />
        <div className="fm-alert fm-alert--error" role="alert">{loadError}</div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Giao hàng', isEdit ? 'Chỉnh sửa' : 'Tạo mới']}
        title={isEdit ? 'Chỉnh sửa phiếu giao hàng' : 'Tạo phiếu giao hàng'}
        actions={<>
          <button className="fm-btn fm-btn--secondary" onClick={onCancel} disabled={saving}>
            <ArrowLeft size={16} /> Quay lại
          </button>
          {!isEdit && (
            <>
              <button
                className="fm-btn fm-btn--secondary"
                onClick={() => setPickerOpen(true)}
                disabled={saving}
                title="Sao chép dữ liệu từ đơn hàng bán (không tạo phiếu ngay)"
              >
                <Copy size={16} /> Sao chép từ…
              </button>
              <button className="fm-btn fm-btn--secondary" onClick={() => void handleSave(true)} disabled={saving}>
                <Save size={16} /> {saving ? 'Đang lưu nháp…' : 'Lưu nháp'}
              </button>
            </>
          )}
          <button className="fm-btn fm-btn--primary" onClick={() => void handleSave()} disabled={saving}>
            <Save size={16} /> {saving ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Tạo phiếu giao hàng'}
          </button>
        </>}
      />

      {/* "Sao chép từ…" (copy-from): dữ liệu đã điền sẵn từ chứng từ nguồn */}
      {!isEdit && copyFromInfo && (
        <div className="fm-alert fm-alert--info" role="status" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1 }}>
            <b>Tạo từ {copyFromInfo.sourceLabel}
              {copyFromInfo.sourceDocNum != null ? ` #${copyFromInfo.sourceDocNum}` : ''} — {copyFromInfo.cardName}</b>
            {' '}— dữ liệu đã điền sẵn (số lượng = số lượng còn mở của đơn nguồn). Kiểm tra lại rồi bấm Lưu.
          </div>
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={() => setPickerOpen(true)} disabled={saving}>
            Đổi nguồn
          </button>
          <button type="button" className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => setCopyFromInfo(null)} disabled={saving}>
            Xóa
          </button>
        </div>
      )}
      {pickerOpen && (
        <CopyFromPicker targetType="delivery" onPick={applyCopyFrom} onClose={() => setPickerOpen(false)} />
      )}

      {saveError && (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>{saveError}</div>
      )}

      <div className="fm-card" style={{ marginBottom: 12 }}>
        <h2 className="fm-card__title">Thông tin chung</h2>
        <div className="fm-form-grid">
          <div className="fm-field">
            <label className="fm-label">Khách hàng <span className="fm-required">*</span></label>
            {isEdit ? (
              <div className="fm-input" style={{ background: 'var(--fm-bg-2)' }} aria-label="Khách hàng (không đổi được)">
                {partner ? `${partner.code} — ${partner.name}` : '—'}
              </div>
            ) : (
              <Autocomplete
                label="Khách hàng"
                hideLabel
                required
                placeholder="Tìm mã / tên khách hàng…"
                fetchUrl="/api/partners"
                value={partner}
                onChange={(v) => {
                  setPartner(v)
                  // Giá tự giải theo Price List 1 khi chọn khách hàng mới (mirror order-form)
                  if (v?.price) {
                    setLines((ls) => ls.map((l) => ({ ...l, unitPrice: l.unitPrice || v.price || 0 })))
                  }
                }}
                error={partnerErr}
                disabled={saving}
              />
            )}
            {isEdit && <div className="fm-hint">Không đổi được khách hàng trên phiếu đã tạo</div>}
          </div>
          <div className="fm-field">
            <label className="fm-label" htmlFor="dl-docdate">Ngày chứng từ <span className="fm-required">*</span></label>
            <input
              id="dl-docdate"
              type="date"
              className="fm-input"
              value={docDate}
              onChange={(e) => setDocDate(e.target.value)}
              disabled={saving}
            />
          </div>
          <div className="fm-field" style={{ gridColumn: '1 / -1' }}>
            <label className="fm-label" htmlFor="dl-remarks">Ghi chú</label>
            <textarea
              id="dl-remarks"
              className="fm-input"
              rows={2}
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Ghi chú thêm trên phiếu giao hàng…"
              disabled={saving}
            />
          </div>
        </div>
      </div>

      <div className="fm-card" style={{ marginBottom: 12 }}>
        <h2 className="fm-card__title">Dòng hàng</h2>
        {isEdit && hasSourceOrder && (
          <div className="fm-hint" style={{ marginBottom: 8 }}>
            Phiếu tạo từ đơn hàng bán — chỉ sửa được số lượng từng dòng, không thêm/xóa dòng.
          </div>
        )}
        <table className="fm-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Mặt hàng</th>
              <th style={{ width: 110 }}>Số lượng</th>
              <th style={{ width: 140 }}>Đơn giá</th>
              <th style={{ width: 90 }}>Thuế %</th>
              <th style={{ width: 140, textAlign: 'right' }}>Thành tiền</th>
              {(!isEdit || !hasSourceOrder) && <th style={{ width: 48 }} />}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td>{i + 1}</td>
                <td style={{ minWidth: 220 }}>
                  {isEdit && hasSourceOrder ? (
                    <span>{l.item ? `${l.item.code} — ${l.item.name}` : '—'}</span>
                  ) : (
                    <Autocomplete
                      label={`Mặt hàng dòng ${i + 1}`}
                      hideLabel
                      placeholder="Tìm mã / tên mặt hàng…"
                      fetchUrl="/api/items"
                      value={l.item}
                      onChange={(v) => setLine(l.key, {
                        item: v,
                        unitPrice: v?.price ?? l.unitPrice,
                        vatPct: v?.vatRate ?? l.vatPct,
                      })}
                      disabled={saving}
                    />
                  )}
                </td>
                <td>
                  <input
                    type="number"
                    className="fm-input"
                    min={0}
                    step="any"
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: parseFloat(e.target.value) || 0 })}
                    disabled={saving}
                    aria-label={`Số lượng dòng ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="fm-input"
                    min={0}
                    step="any"
                    value={l.unitPrice}
                    onChange={(e) => setLine(l.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                    disabled={saving || (isEdit && hasSourceOrder)}
                    aria-label={`Đơn giá dòng ${i + 1}`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    className="fm-input"
                    min={0}
                    max={100}
                    step="any"
                    value={l.vatPct}
                    onChange={(e) => setLine(l.key, { vatPct: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)) })}
                    disabled={saving || (isEdit && hasSourceOrder)}
                    aria-label={`Thuế suất dòng ${i + 1}`}
                  />
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatVND(lineTotal(l))}</td>
                {(!isEdit || !hasSourceOrder) && (
                  <td>
                    <button
                      type="button"
                      className="fm-row-del"
                      onClick={() => removeLine(l.key)}
                      disabled={saving || lines.length <= 1}
                      title="Xóa dòng"
                      aria-label={`Xóa dòng ${i + 1}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {(!isEdit || !hasSourceOrder) && (
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" onClick={addLine} disabled={saving} style={{ marginTop: 8 }}>
            <Plus size={14} /> Thêm dòng
          </button>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <table style={{ minWidth: 280 }}>
            <tbody>
              <tr>
                <td style={{ fontWeight: 700 }}>Tổng phiếu giao hàng:</td>
                <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 16 }}>{formatVND(grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', position: 'sticky', bottom: 0, background: 'var(--fm-bg)', padding: '12px 0' }}>
        <button className="fm-btn fm-btn--secondary" onClick={onCancel} disabled={saving}>Hủy bỏ</button>
        {!isEdit && (
          <button className="fm-btn fm-btn--secondary" onClick={() => void handleSave(true)} disabled={saving}>
            <Save size={16} /> {saving ? 'Đang lưu nháp…' : 'Lưu nháp'}
          </button>
        )}
        <button className="fm-btn fm-btn--primary" onClick={() => void handleSave()} disabled={saving}>
          <Save size={16} /> {saving ? 'Đang lưu…' : isEdit ? 'Lưu thay đổi' : 'Tạo phiếu giao hàng'}
        </button>
      </div>
    </div>
  )
}
