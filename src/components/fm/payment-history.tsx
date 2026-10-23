'use client'

// ============================================================
// GHI NHẬN THANH TOÁN (MỤC 11) — card "Thanh toán": hiển thị
// tổng chứng từ / đã thu / còn lại + trạng thái, danh sách lịch
// sử thanh toán và form nhỏ ghi nhận 1 lần thanh toán.
// Dùng trong trang chi tiết hóa đơn / phiếu ghi có / hóa đơn
// đặt cọc. Props: { docType, docId, grandTotal, paidAmount, onChanged }.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import { formatDateVN, formatVND } from '@/lib/fm-shared'
import { api, safeJson } from '@/lib/fm-client'
import {
  PAYMENT_API_BASE,
  PAYMENT_EPS,
  PAYMENT_STATUS_LABEL,
  derivePaymentStatus,
  type PaymentDocType,
  type PaymentStatus,
} from '@/lib/payments'

interface PaymentRow {
  id: string
  amount: number
  payDate: string
  remarks: string | null
  createdBy: string
  createdAt: string
}

export interface PaymentHistoryProps {
  docType: PaymentDocType
  docId: string
  grandTotal: number
  paidAmount: number
  onChanged: () => void
}

const STATUS_CHIP: Record<PaymentStatus, string> = {
  unpaid: 'fm-chip fm-chip--overdue',
  partial: 'fm-chip fm-chip--open',
  paid: 'fm-chip fm-chip--sap',
}

function todayStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function PaymentHistory({
  docType,
  docId,
  grandTotal,
  paidAmount,
  onChanged,
}: PaymentHistoryProps) {
  const base = PAYMENT_API_BASE[docType]
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [amount, setAmount] = useState('')
  const [payDate, setPayDate] = useState(todayStr())
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const remaining = Math.max(0, grandTotal - paidAmount)
  const status = derivePaymentStatus(paidAmount, grandTotal)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api(`/api/${base}/${docId}/payments`)
      const data = (await safeJson(res)) as
        | { ok?: boolean; payments?: PaymentRow[]; error?: string }
        | undefined
      if (!res.ok) {
        setError(data?.error ?? 'Không tải được lịch sử thanh toán')
        setPayments([])
        return
      }
      setPayments(Array.isArray(data?.payments) ? data.payments : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không tải được lịch sử thanh toán')
      setPayments([])
    } finally {
      setLoading(false)
    }
  }, [base, docId])

  useEffect(() => {
    load()
  }, [load])

  async function save() {
    setSaveError('')
    const a = Number(amount)
    if (!Number.isFinite(a) || a <= 0) {
      setSaveError('Số tiền ghi nhận phải lớn hơn 0')
      return
    }
    if (a - remaining > PAYMENT_EPS) {
      setSaveError(`Số tiền vượt số còn phải thu (${formatVND(remaining)})`)
      return
    }
    setSaving(true)
    try {
      const res = await api(`/api/${base}/${docId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount: a,
          payDate: payDate || undefined,
          remarks: remarks.trim() || undefined,
        }),
      })
      const data = (await safeJson(res)) as { ok?: boolean; error?: string } | undefined
      if (!res.ok || !data?.ok) {
        setSaveError(data?.error ?? 'Không ghi nhận được thanh toán')
        return
      }
      setAmount('')
      setRemarks('')
      setPayDate(todayStr())
      await load()
      onChanged()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Không ghi nhận được thanh toán')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fm-card">
      <h2 className="fm-card__title">
        <Wallet size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
        Thanh toán
      </h2>

      {/* Tổng hợp: tổng CT / đã thu / còn lại + trạng thái */}
      <div className="fm-totals fm-totals--card" style={{ marginBottom: 12 }}>
        <div className="fm-totals__row">
          <span>Tổng chứng từ</span>
          <b className="fm-num">{formatVND(grandTotal)}</b>
        </div>
        <div className="fm-totals__row">
          <span>Đã thanh toán</span>
          <b className="fm-num">{formatVND(paidAmount)}</b>
        </div>
        <div className="fm-totals__row fm-totals__grand">
          <span>Còn lại</span>
          <b className="fm-num">{formatVND(remaining)}</b>
        </div>
        <div className="fm-totals__row">
          <span>Trạng thái</span>
          <span className={STATUS_CHIP[status]}>{PAYMENT_STATUS_LABEL[status]}</span>
        </div>
      </div>

      {/* Lịch sử thanh toán */}
      {loading ? (
        <div style={{ color: 'var(--fm-text-2)', padding: '8px 0' }}>Đang tải lịch sử…</div>
      ) : error ? (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>
          {error}{' '}
          <button type="button" className="fm-btn fm-btn--secondary fm-ml-2" onClick={load}>
            Thử lại
          </button>
        </div>
      ) : payments.length === 0 ? (
        <div style={{ color: 'var(--fm-text-2)', padding: '8px 0' }}>Chưa có lần thanh toán nào.</div>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table className="fm-table">
            <thead>
              <tr>
                <th>Ngày</th>
                <th style={{ textAlign: 'right' }}>Số tiền</th>
                <th>Ghi chú</th>
                <th>Người tạo</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{formatDateVN(p.payDate)}</td>
                  <td className="fm-num" style={{ textAlign: 'right' }}>{formatVND(p.amount)}</td>
                  <td>{p.remarks || '—'}</td>
                  <td>{p.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Form ghi nhận thanh toán */}
      <div className="fm-form-grid">
        <div className="fm-field">
          <label className="fm-label" htmlFor="fm-pay-amount">
            Số tiền <span className="fm-required">*</span>
          </label>
          <input
            id="fm-pay-amount"
            type="number"
            min={0}
            step="any"
            className="fm-input fm-num"
            placeholder={`Còn lại: ${formatVND(remaining)}`}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="fm-field">
          <label className="fm-label" htmlFor="fm-pay-date">Ngày thanh toán</label>
          <input
            id="fm-pay-date"
            type="date"
            className="fm-input"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className="fm-field" style={{ gridColumn: '1 / -1' }}>
          <label className="fm-label" htmlFor="fm-pay-remarks">Ghi chú</label>
          <input
            id="fm-pay-remarks"
            type="text"
            className="fm-input"
            placeholder="Vd: thu tiền mặt đợt 1…"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            disabled={saving}
          />
        </div>
      </div>
      {saveError && (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginTop: 8 }}>
          {saveError}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          className="fm-btn fm-btn--primary"
          onClick={save}
          disabled={saving || remaining <= PAYMENT_EPS}
        >
          {saving ? 'Đang lưu…' : 'Ghi nhận thanh toán'}
        </button>
      </div>
    </div>
  )
}
