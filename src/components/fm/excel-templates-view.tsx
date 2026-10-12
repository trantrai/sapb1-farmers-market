'use client'

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { Plus, Pencil, Trash2, Download, Star, X, Save } from 'lucide-react'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

/** Các trường đơn hàng có thể map từ cột Excel */
export const EXCEL_FIELDS = [
  { key: 'itemCode', label: 'Mã hàng (ItemCode)', required: true },
  { key: 'itemName', label: 'Tên hàng (ItemName)', required: false },
  { key: 'quantity', label: 'Số lượng (Quantity)', required: true },
  { key: 'unitPrice', label: 'Đơn giá (Price)', required: false },
  { key: 'uom', label: 'Đơn vị tính (UoM)', required: false },
  { key: 'discPct', label: 'Chiết khấu % (Discount%)', required: false },
  { key: 'taxCode', label: 'Mã thuế (TaxCode)', required: false },
  { key: 'warehouseCode', label: 'Kho (Warehouse)', required: false },
] as const

export type ExcelFieldKey = (typeof EXCEL_FIELDS)[number]['key']

export interface ExcelTemplate {
  id: string
  name: string
  description: string | null
  isDefault: boolean
  mapping: Record<string, string> // excelColumn -> fieldKey
  createdAt: string
  updatedAt: string
}

interface Props {
  onBack?: () => void
}

export default function ExcelTemplatesView({ onBack }: Props) {
  const [templates, setTemplates] = useState<ExcelTemplate[] | null>(null)
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [editing, setEditing] = useState<ExcelTemplate | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ExcelTemplate | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formDefault, setFormDefault] = useState(false)
  const [formMapping, setFormMapping] = useState<Array<{ id: string; col: string; field: string }>>([])
  // Counter id ổn định cho dòng mapping (không dùng index/length để tránh trùng sau khi xóa)
  const mappingIdRef = useRef(0)
  const nextMappingId = () => `m${++mappingIdRef.current}`
  const toMappingRows = (mapping: Record<string, string>) =>
    Object.entries(mapping).map(([col, field]) => ({ id: nextMappingId(), col, field }))
  const mappingRecord = (): Record<string, string> =>
    Object.fromEntries(formMapping.filter((r) => r.col.trim()).map((r) => [r.col.trim(), r.field]))

  const load = useCallback(async () => {
    setTemplates(null)
    try {
      const res = await api('/api/excel-templates')
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không tải được danh sách template' })
        setTemplates([])
        return
      }
      setTemplates(json.data ?? [])
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
      setTemplates([])
    }
  }, [])

  // Nạp danh sách khi mount: logic setState nằm trong useEffectEvent để
  // không vi phạm react-hooks/set-state-in-effect (event, không phải effect)
  const onMountLoad = useEffectEvent(() => {
    void load()
  })

  useEffect(() => {
    onMountLoad()
  }, [])

  const openForm = (t?: ExcelTemplate) => {
    if (t) {
      setEditing(t)
      setFormName(t.name)
      setFormDesc(t.description ?? '')
      setFormDefault(t.isDefault)
      setFormMapping(toMappingRows(t.mapping))
    } else {
      setEditing(null)
      setFormName('')
      setFormDesc('')
      setFormDefault(false)
      setFormMapping([
        { id: nextMappingId(), col: 'Mã hàng', field: 'itemCode' },
        { id: nextMappingId(), col: 'Số lượng', field: 'quantity' },
      ])
    }
    setShowForm(true)
  }

  const saveTemplate = async () => {
    if (!formName.trim()) {
      setMsg({ type: 'error', text: 'Tên template không được để trống' })
      return
    }
    if (formMapping.length === 0) {
      setMsg({ type: 'error', text: 'Mapping không được để trống' })
      return
    }
    try {
      const body = {
        name: formName.trim(),
        description: formDesc.trim() || null,
        isDefault: formDefault,
        mapping: mappingRecord(),
      }
      const res = editing
        ? await api(`/api/excel-templates/${editing.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await api('/api/excel-templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
      const json = await res.json()
      if (!res.ok) {
        setMsg({ type: 'error', text: json.error ?? 'Không lưu được template' })
        return
      }
      setMsg({ type: 'success', text: editing ? 'Đã cập nhật template' : 'Đã tạo template mới' })
      setShowForm(false)
      load()
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    }
  }

  const deleteTemplate = async () => {
    if (!confirmDelete) return
    try {
      const res = await api(`/api/excel-templates/${confirmDelete.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json()
        setMsg({ type: 'error', text: json.error ?? 'Không xóa được template' })
        return
      }
      setMsg({ type: 'success', text: 'Đã xóa template' })
      setConfirmDelete(null)
      load()
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    }
  }

  const setDefault = async (t: ExcelTemplate) => {
    try {
      const res = await api(`/api/excel-templates/${t.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      if (!res.ok) {
        const json = await res.json()
        setMsg({ type: 'error', text: json.error ?? 'Không đặt được mặc định' })
        return
      }
      setMsg({ type: 'success', text: `Đã đặt "${t.name}" làm mặc định` })
      load()
    } catch {
      setMsg({ type: 'error', text: 'Không thể kết nối máy chủ' })
    }
  }

  /** Tải file Excel mẫu với header theo mapping */
  const downloadSample = (t: ExcelTemplate) => {
    const headers = Object.keys(t.mapping)
    const sampleRow: Record<string, string | number> = {}
    for (const col of headers) {
      const field = t.mapping[col]
      sampleRow[col] =
        field === 'itemCode' ? 'A001'
        : field === 'itemName' ? 'Mặt hàng mẫu'
        : field === 'quantity' ? 10
        : field === 'unitPrice' ? 50000
        : field === 'uom' ? 'Cái'
        : field === 'discPct' ? 5
        : field === 'taxCode' ? 'S1'
        : field === 'warehouseCode' ? 'WH01'
        : ''
    }
    const ws = XLSX.utils.json_to_sheet([sampleRow], { header: headers })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Chi tiết đơn hàng')
    XLSX.writeFile(wb, `template-${t.name}.xlsx`)
  }

  const addMappingRow = () => {
    const col = `Cột ${formMapping.length + 1}`
    setFormMapping([...formMapping, { id: nextMappingId(), col, field: 'itemCode' }])
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Mẫu Excel']}
        title="Quản Lý Template Excel"
        badge="Cập nhật tức thời"
        actions={
          <button className="fm-btn fm-btn--primary" onClick={() => openForm()}>
            <Plus size={14} /> Thêm template
          </button>
        }
      />

      {msg && (
        <div className={`fm-alert ${msg.type === 'success' ? 'fm-alert--success' : 'fm-alert--error'}`} role={msg.type === 'error' ? 'alert' : 'status'}>
          <div><b>{msg.type === 'success' ? 'Thành công' : 'Lỗi'}</b> {msg.text}</div>
          <button className="fm-btn fm-btn--ghost fm-btn--sm" style={{ marginLeft: 'auto' }} aria-label="Đóng thông báo" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}

      <div className="fm-card">
        <h2 className="fm-card__title">Danh sách template</h2>
        {templates === null ? (
          <p style={{ color: 'var(--fm-text-2)' }}>Đang tải…</p>
        ) : templates.length === 0 ? (
          <p style={{ color: 'var(--fm-text-2)' }}>Chưa có template nào. Bấm "Thêm template" để tạo mới.</p>
        ) : (
          <div className="fm-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="fm-table">
              <thead>
                <tr>
                  <th>Tên template</th>
                  <th>Mô tả</th>
                  <th>Số cột map</th>
                  <th>Mặc định</th>
                  <th style={{ width: 180 }}>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.name}</b></td>
                    <td>{t.description || '—'}</td>
                    <td className="fm-num">{Object.keys(t.mapping).length}</td>
                    <td>
                      {t.isDefault ? (
                        <span className="fm-chip fm-chip--role"><Star size={12} /> Mặc định</span>
                      ) : (
                        <button className="fm-link" onClick={() => setDefault(t)}>Đặt mặc định</button>
                      )}
                    </td>
                    <td>
                      <button className="fm-icon-btn" title="Tải template mẫu" aria-label="Tải template mẫu" onClick={() => downloadSample(t)}>
                        <Download size={15} />
                      </button>
                      <button className="fm-icon-btn" title="Sửa" aria-label="Sửa template" onClick={() => openForm(t)}>
                        <Pencil size={15} />
                      </button>
                      <button className="fm-icon-btn fm-icon-btn--danger" title="Xóa" aria-label="Xóa template" onClick={() => setConfirmDelete(t)}>
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Form thêm/sửa */}
      {showForm && (
        <div className="fm-modal" role="dialog" aria-modal="true" aria-label={editing ? 'Sửa template' : 'Thêm template'}>
          <div className="fm-modal__box" style={{ maxWidth: 640 }}>
            <div className="fm-modal__head">
              <b>{editing ? 'Sửa template' : 'Thêm template mới'}</b>
              <button className="fm-icon-btn" onClick={() => setShowForm(false)} aria-label="Đóng"><X size={16} /></button>
            </div>
            <div className="fm-modal__body">
              <div className="fm-field">
                <label className="fm-label" htmlFor="et-name">Tên template *</label>
                <input id="et-name" className="fm-input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="VD: Template nhập hàng" />
              </div>
              <div className="fm-field" style={{ marginTop: 12 }}>
                <label className="fm-label" htmlFor="et-desc">Mô tả</label>
                <input id="et-desc" className="fm-input" value={formDesc} onChange={(e) => setFormDesc(e.target.value)} placeholder="Mô tả ngắn về template" />
              </div>
              <div className="fm-field" style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={formDefault} onChange={(e) => setFormDefault(e.target.checked)} />
                  Đặt làm template mặc định
                </label>
              </div>

              <h3 style={{ margin: '18px 0 8px', fontSize: 14 }}>Mapping cột Excel → Trường đơn hàng</h3>
              {formMapping.map((row) => (
                <div key={row.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <input
                    className="fm-input"
                    value={row.col}
                    onChange={(e) => {
                      const v = e.target.value
                      setFormMapping((rows) => rows.map((r) => (r.id === row.id ? { ...r, col: v } : r)))
                    }}
                    placeholder="Tên cột Excel"
                    aria-label="Tên cột Excel"
                    style={{ flex: 1 }}
                  />
                  <span>→</span>
                  <select
                    className="fm-select"
                    value={row.field}
                    onChange={(e) => {
                      const v = e.target.value
                      setFormMapping((rows) => rows.map((r) => (r.id === row.id ? { ...r, field: v } : r)))
                    }}
                    aria-label={`Trường đơn hàng cho cột ${row.col || 'mới'}`}
                    style={{ flex: 1 }}
                  >
                    {EXCEL_FIELDS.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                  <button
                    className="fm-icon-btn fm-icon-btn--danger"
                    onClick={() => setFormMapping((rows) => rows.filter((r) => r.id !== row.id))}
                    title="Xóa dòng mapping"
                    aria-label={`Xóa mapping cột ${row.col || 'mới'}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={addMappingRow} style={{ marginTop: 4 }}>
                <Plus size={13} /> Thêm cột
              </button>
            </div>
            <div className="fm-modal__foot">
              <button className="fm-btn fm-btn--secondary" onClick={() => setShowForm(false)}>Hủy</button>
              <button className="fm-btn fm-btn--primary" onClick={saveTemplate}>
                <Save size={14} /> Lưu template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Xác nhận xóa */}
      {confirmDelete && (
        <div className="fm-modal" role="dialog" aria-modal="true" aria-label="Xác nhận xóa">
          <div className="fm-modal__box" style={{ maxWidth: 420 }}>
            <div className="fm-modal__head">
              <b>Xác nhận xóa</b>
              <button className="fm-icon-btn" onClick={() => setConfirmDelete(null)} aria-label="Đóng"><X size={16} /></button>
            </div>
            <div className="fm-modal__body">
              <p>Bạn có chắc muốn xóa template <b>"{confirmDelete.name}"</b>?</p>
            </div>
            <div className="fm-modal__foot">
              <button className="fm-btn fm-btn--secondary" onClick={() => setConfirmDelete(null)}>Hủy</button>
              <button className="fm-btn fm-btn--danger" onClick={deleteTemplate}>
                <Trash2 size={14} /> Xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
