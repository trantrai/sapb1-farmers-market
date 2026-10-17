'use client'

// ============================================================
// CÔNG NỢ PHẢI THU (Phase 3) — số liệu từ GET /api/reports/ar-aging
// Aging buckets theo docDueDate và số dư (grandTotal − paidAmount) của
// hóa đơn chưa thanh toán hết: Chưa đến hạn | 1–30 | 31–60 | 61–90 | >90.
// Bảng tổng hợp theo khách hàng + chi tiết hóa đơn.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Wallet } from 'lucide-react'
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
interface InvoiceRow {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  grandTotal: number
  paidAmount: number
  balance: number
  daysOverdue: number
  bucket: string
}

interface ReportData {
  generatedAt: string
  grandTotal: number
  invoiceCount: number
  buckets: Bucket[]
  customers: CustomerRow[]
  invoices: InvoiceRow[]
}

const BUCKET_COLORS: Record<string, string> = {
  notDue: 'var(--fm-green)',
  d1_30: 'var(--fm-yellow)',
  d31_60: 'var(--fm-coral)',
  d61_90: 'var(--fm-red)',
  over90: 'var(--fm-navy-deep)',
}

const BUCKET_LABEL: Record<string, string> = {
  notDue: 'Chưa đến hạn',
  d1_30: '1–30 ngày',
  d31_60: '31–60 ngày',
  d61_90: '61–90 ngày',
  over90: '> 90 ngày',
}

export default function ArAgingReportView() {
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [bucketFilter, setBucketFilter] = useState('')

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

  const filteredInvoices = data
    ? data.invoices.filter((i) => !bucketFilter || i.bucket === bucketFilter)
    : []

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Công nợ phải thu']}
        title="Công nợ phải thu"
        badge="Tuổi nợ theo hạn thanh toán"
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
              <div className="fm-stat__label">Tổng dư nợ</div>
              <div className="fm-stat__value" style={{ fontSize: 22 }}>{formatVND(data.grandTotal)}</div>
              <div className="fm-stat__meta">{data.invoiceCount} hóa đơn chưa thanh toán hết</div>
            </div>
            {data.buckets.map((b) => (
              <div key={b.key} className="fm-stat">
                <div className="fm-stat__label">{b.label}</div>
                <div className="fm-stat__value" style={{ fontSize: 20 }}>{formatVND(b.total)}</div>
                <div className="fm-stat__meta">{b.count} hóa đơn</div>
              </div>
            ))}
          </div>

          {/* Biểu đồ cột theo nhóm tuổi nợ */}
          <div className="fm-card" style={{ marginBottom: 16 }}>
            <h2 className="fm-card__title">Dư nợ theo nhóm tuổi nợ</h2>
            <div style={{ width: '100%', height: 260 }} role="img" aria-label="Biểu đồ cột dư nợ theo nhóm tuổi nợ">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.buckets} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fm-line)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} angle={-12} height={56} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v >= 1000000 ? `${Math.round(v / 1000000)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`)} />
                  <Tooltip formatter={(v) => [formatVND(Number(v)), 'Dư nợ']} />
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
            <h2 className="fm-card__title">Tổng hợp công nợ theo khách hàng</h2>
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
                      <th className="fm-num">Tổng dư nợ</th>
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

          {/* Chi tiết hóa đơn */}
          <div className="fm-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <h2 className="fm-card__title" style={{ margin: 0 }}>Chi tiết hóa đơn chưa thanh toán hết</h2>
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
            {filteredInvoices.length === 0 ? (
              <div className="fm-empty">Không có hóa đơn phù hợp</div>
            ) : (
              <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto', marginTop: 8 }}>
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Số hóa đơn</th>
                      <th>Khách hàng</th>
                      <th>Ngày hóa đơn</th>
                      <th>Hạn thanh toán</th>
                      <th>Tuổi nợ</th>
                      <th className="fm-num">Tổng hóa đơn</th>
                      <th className="fm-num">Đã thu</th>
                      <th className="fm-num">Dư nợ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInvoices.map((i) => (
                      <tr key={i.id}>
                        <th scope="row"><b>#{i.docNum}</b></th>
                        <td>{i.cardName}</td>
                        <td>{formatDateVN(i.docDate)}</td>
                        <td>{formatDateVN(i.docDueDate)}</td>
                        <td>
                          <span className={`fm-chip ${i.daysOverdue <= 0 ? 'fm-chip--open' : i.daysOverdue > 90 ? 'fm-chip--overdue' : 'fm-chip--warn'}`}>
                            {BUCKET_LABEL[i.bucket] ?? i.bucket}
                          </span>
                        </td>
                        <td className="fm-num">{formatVND(i.grandTotal)}</td>
                        <td className="fm-num">{formatVND(i.paidAmount)}</td>
                        <td className="fm-num"><b>{formatVND(i.balance)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
