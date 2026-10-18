'use client'

// ============================================================
// CÔNG NỢ PHẢI THU (Phase 3, chuẩn SAP B1) — số liệu từ GET /api/reports/ar-aging
// - Công nợ RÒNG theo khách hàng = Σ(Hóa đơn: tổng − đã thu) − Σ(Phiếu ghi có:
//   tổng − đã thu)
// - Hóa đơn đặt cọc là tạm ứng (liability) — hiển thị riêng section
//   "Tạm ứng chưa áp dụng", KHÔNG trừ vào công nợ
// - Ngày đáo hạn = ngày chứng từ + số ngày ĐKTT (PaymentTerm.days, chuẩn SAP B1:
//   DueDate = StartFrom + ExtraMonth + ExtraDays); không có ĐKTT → docDueDate
// - Aging buckets theo ngày đáo hạn: Chưa đến hạn | 1–30 | 31–60 | 61–90 | >90
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Wallet, HandCoins } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

interface Bucket { key: string; label: string; total: number; count: number }
interface CustomerRow {
  cardCode: string
  cardName: string
  total: number
  count: number
  notDue: number
  d1_30: number
  d31_60: number
  d61_90: number
  over90: number
}
interface DocRow {
  id: string
  docType: 'invoice' | 'creditMemo'
  docNum: number | null
  cardCode: string
  cardName: string
  docDate: string
  dueDate: string
  termDays: number | null
  grandTotal: number
  paidAmount: number
  balance: number
  daysOverdue: number
  bucket: string
}
interface DownPaymentRow {
  id: string
  docNum: number | null
  cardCode: string
  cardName: string
  docDate: string
  grandTotal: number
  remainingAmount: number
}

interface ReportData {
  generatedAt: string
  grandTotal: number
  invoiceCount: number
  creditMemoCount: number
  openDocCount: number
  buckets: Bucket[]
  customers: CustomerRow[]
  documents: DocRow[]
  /** Tương thích ngược với API cũ (trả invoices) */
  invoices?: DocRow[]
  downPayments: DownPaymentRow[]
  unappliedTotal: number
}

const BUCKET_COLORS: Record<string, string> = {
  notDue: 'var(--fm-navy)',
  d1_30: 'var(--fm-gold)',
  d31_60: 'var(--fm-coral)',
  d61_90: 'var(--fm-coral-deep)',
  over90: 'var(--fm-navy-deep)',
}

const BUCKET_LABEL: Record<string, string> = {
  notDue: 'Chưa đến hạn',
  d1_30: '1–30 ngày',
  d31_60: '31–60 ngày',
  d61_90: '61–90 ngày',
  over90: '> 90 ngày',
}

const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: 'Hóa đơn',
  creditMemo: 'Ghi có',
}

export default function ArAgingReportView() {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [bucketFilter, setBucketFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await api('/api/reports/ar-aging')
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setData(j)
    } catch (e) {
      setData(null)
      setError(e instanceof Error ? e.message : 'Không tải được báo cáo')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  const reload = () => { setRefreshing(true); void load() }

  const docs = data?.documents ?? data?.invoices ?? []
  const filteredDocs = docs.filter(
    (d) =>
      (!bucketFilter || d.bucket === bucketFilter) &&
      (!typeFilter || d.docType === typeFilter),
  )

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Công nợ phải thu']}
        title="Công nợ phải thu"
        badge="Tuổi nợ theo hạn thanh toán (chuẩn SAP B1)"
        actions={
          <button type="button" className="fm-btn fm-btn--secondary" onClick={reload} disabled={refreshing || loading}>
            <RefreshCw size={16} className={refreshing ? 'fm-spin' : undefined} /> {refreshing ? 'Đang tải…' : 'Tải lại'}
          </button>
        }
      />

      {error && (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>
          <div><b>Không tải được báo cáo.</b> {error}</div>
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" style={{ marginTop: 8 }} onClick={reload}>
            Thử lại
          </button>
        </div>
      )}

      {loading ? (
        <div aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="fm-skeleton fm-skeleton--row" />
          ))}
        </div>
      ) : !data ? null : (
        <>
          {/* Tổng quan các nhóm tuổi nợ */}
          <div className="fm-stats" style={{ marginBottom: 16 }}>
            <div className="fm-stat fm-stat--navy">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><Wallet size={18} /></div>
              <div className="fm-stat__label">Tổng dư nợ ròng</div>
              <div className="fm-stat__value" style={{ fontSize: 22 }}>{formatVND(data.grandTotal)}</div>
              <div className="fm-stat__meta">
                {data.openDocCount} chứng từ mở ({data.invoiceCount} hóa đơn − {data.creditMemoCount} ghi có)
              </div>
            </div>
            {data.buckets.map((b) => (
              <div key={b.key} className="fm-stat">
                <div className="fm-stat__label">{b.label}</div>
                <div className="fm-stat__value" style={{ fontSize: 20 }}>{formatVND(b.total)}</div>
                <div className="fm-stat__meta">{b.count} chứng từ</div>
              </div>
            ))}
            <div className="fm-stat">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><HandCoins size={18} /></div>
              <div className="fm-stat__label">Tạm ứng chưa áp dụng</div>
              <div className="fm-stat__value" style={{ fontSize: 20 }}>{formatVND(data.unappliedTotal ?? 0)}</div>
              <div className="fm-stat__meta">{(data.downPayments ?? []).length} hóa đơn đặt cọc còn dư</div>
            </div>
          </div>

          {/* Biểu đồ cột theo nhóm tuổi nợ */}
          <div className="fm-card" style={{ marginBottom: 16 }}>
            <h2 className="fm-card__title">Dư nợ ròng theo nhóm tuổi nợ</h2>
            <div style={{ width: '100%', height: 260 }} role="img" aria-label="Biểu đồ cột dư nợ ròng theo nhóm tuổi nợ">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.buckets} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fm-line)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} angle={-12} height={56} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v >= 1000000 ? `${Math.round(v / 1000000)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`)} />
                  <Tooltip formatter={(v) => [formatVND(Number(v)), 'Dư nợ ròng']} />
                  <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                    {data.buckets.map((b) => (
                      <Cell key={b.key} fill={BUCKET_COLORS[b.key] ?? 'var(--fm-navy)'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tổng hợp theo khách hàng */}
          <div className="fm-card" style={{ marginBottom: 16 }}>
            <h2 className="fm-card__title">Tổng hợp công nợ ròng theo khách hàng</h2>
            {data.customers.length === 0 ? (
              <div className="fm-empty">Không có công nợ phải thu</div>
            ) : (
              <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Mã khách hàng</th>
                      <th>Khách hàng</th>
                      <th className="fm-num">Chưa đến hạn</th>
                      <th className="fm-num">1–30 ngày</th>
                      <th className="fm-num">31–60 ngày</th>
                      <th className="fm-num">61–90 ngày</th>
                      <th className="fm-num">&gt; 90 ngày</th>
                      <th className="fm-num">Tổng dư nợ ròng</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.customers.map((c) => (
                      <tr key={c.cardCode}>
                        <td>{c.cardCode}</td>
                        <td>{c.cardName}</td>
                        <td className="fm-num">{formatVND(c.notDue)}</td>
                        <td className="fm-num">{formatVND(c.d1_30)}</td>
                        <td className="fm-num">{formatVND(c.d31_60)}</td>
                        <td className="fm-num">{formatVND(c.d61_90)}</td>
                        <td className="fm-num">{formatVND(c.over90)}</td>
                        <td className="fm-num"><b>{formatVND(c.total)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'right' }}><b>Tổng cộng:</b></td>
                      <td className="fm-num"><b>{formatVND(data.grandTotal)}</b></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* Chi tiết chứng từ mở */}
          <div className="fm-card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <h2 className="fm-card__title" style={{ margin: 0 }}>Chi tiết chứng từ chưa thanh toán hết</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select
                  className="fm-select"
                  aria-label="Lọc theo loại chứng từ"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  style={{ width: 'auto' }}
                >
                  <option value="">Hóa đơn + Ghi có</option>
                  <option value="invoice">Hóa đơn bán hàng</option>
                  <option value="creditMemo">Phiếu ghi có</option>
                </select>
                <select
                  className="fm-select"
                  aria-label="Lọc theo nhóm tuổi nợ"
                  value={bucketFilter}
                  onChange={(e) => setBucketFilter(e.target.value)}
                  style={{ width: 'auto' }}
                >
                  <option value="">Tất cả nhóm</option>
                  {data.buckets.map((b) => (
                    <option key={b.key} value={b.key}>{b.label}</option>
                  ))}
                </select>
              </div>
            </div>
            {filteredDocs.length === 0 ? (
              <div className="fm-empty">Không có chứng từ phù hợp</div>
            ) : (
              <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 8 }}>
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Loại</th>
                      <th>Số chứng từ</th>
                      <th>Khách hàng</th>
                      <th>Ngày chứng từ</th>
                      <th>Hạn thanh toán</th>
                      <th>ĐKTT</th>
                      <th>Tuổi nợ</th>
                      <th className="fm-num">Tổng chứng từ</th>
                      <th className="fm-num">Đã thu / ghi giảm</th>
                      <th className="fm-num">Dư nợ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDocs.map((d) => (
                      <tr key={`${d.docType}-${d.id}`}>
                        <td>
                          <span className={`fm-chip ${d.docType === 'creditMemo' ? 'fm-chip--warn' : 'fm-chip--open'}`}>
                            {DOC_TYPE_LABEL[d.docType] ?? d.docType}
                          </span>
                        </td>
                        <th scope="row"><b>#{d.docNum ?? '—'}</b></th>
                        <td>{d.cardName}</td>
                        <td>{formatDateVN(d.docDate)}</td>
                        <td>{formatDateVN(d.dueDate)}</td>
                        <td>{d.termDays != null ? `${d.termDays} ngày` : '—'}</td>
                        <td>
                          <span className={`fm-chip ${d.daysOverdue <= 0 ? 'fm-chip--open' : d.daysOverdue > 90 ? 'fm-chip--overdue' : 'fm-chip--warn'}`}>
                            {BUCKET_LABEL[d.bucket] ?? d.bucket}
                          </span>
                        </td>
                        <td className="fm-num">{formatVND(d.grandTotal)}</td>
                        <td className="fm-num">{formatVND(d.paidAmount)}</td>
                        <td className="fm-num"><b>{formatVND(d.balance)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Tạm ứng đặt cọc chưa áp dụng — riêng, không trừ công nợ (chuẩn SAP B1) */}
          <div className="fm-card">
            <h2 className="fm-card__title">Tạm ứng đặt cọc chưa áp dụng</h2>
            {(data.downPayments ?? []).length === 0 ? (
              <div className="fm-empty">Không có khoản tạm ứng nào chưa áp dụng</div>
            ) : (
              <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Số đặt cọc</th>
                      <th>Khách hàng</th>
                      <th>Ngày đặt cọc</th>
                      <th className="fm-num">Tổng đặt cọc</th>
                      <th className="fm-num">Còn lại chưa khấu trừ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.downPayments ?? []).map((dp) => (
                      <tr key={dp.id}>
                        <th scope="row"><b>#{dp.docNum ?? '—'}</b></th>
                        <td>{dp.cardName}</td>
                        <td>{formatDateVN(dp.docDate)}</td>
                        <td className="fm-num">{formatVND(dp.grandTotal)}</td>
                        <td className="fm-num"><b>{formatVND(dp.remainingAmount)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} style={{ textAlign: 'right' }}><b>Tổng tạm ứng chưa áp:</b></td>
                      <td className="fm-num"><b>{formatVND(data.unappliedTotal ?? 0)}</b></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
