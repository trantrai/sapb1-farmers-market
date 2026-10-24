'use client'

// ============================================================
// BÁO CÁO BÁN HÀNG (Phase 3) — số liệu từ GET /api/reports/sales
// Filter khoảng thời gian (từ/đến) + nhóm theo (ngày/tuần/tháng).
// Các khối: doanh số theo kỳ, top 10 mặt hàng, top 10 khách hàng,
// theo nhân viên (createdBy), đơn hàng mở quá hạn, hiệu suất giao hàng.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { BarChart3, RefreshCw, TrendingUp, Receipt } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { formatVND, formatDateVN } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

interface RevenuePoint { key: string; label: string; total: number; count: number }
interface TopItem { itemCode: string; itemName: string; quantity: number; total: number }
interface TopCustomer { cardCode: string; cardName: string; total: number; count: number }
interface TopStaff { createdBy: string; total: number; count: number }
interface OverdueOrder {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  grandTotal: number
  daysOverdue: number
}

interface ReportData {
  from: string
  to: string
  groupBy: string
  invoiceCount: number
  totalRevenue: number
  revenueByPeriod: RevenuePoint[]
  topItems: TopItem[]
  topCustomers: TopCustomer[]
  topStaff: TopStaff[]
  openOverdueOrders: OverdueOrder[]
  deliveryPerf: { total: number; onTime: number; late: number; onTimePct: number }
  /** SAP B1 không đọc được → số liệu chỉ từ ứng dụng */
  sapWarning?: string
}

// Palette biểu đồ map về token theme (globals.css, Swiss anchor): gold / navy / coral / navy-deep / coral-deep / gold-ink
const CHART_COLORS = ['var(--fm-gold)', 'var(--fm-navy)', 'var(--fm-coral)', 'var(--fm-navy-deep)', 'var(--fm-coral-deep)', 'var(--fm-gold-ink)']

const toISO = (d: Date) => d.toISOString().slice(0, 10)

export default function SalesReportView() {
  const [to, setTo] = useState(() => toISO(new Date()))
  const [from, setFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 29)
    return toISO(d)
  })
  const [groupBy, setGroupBy] = useState<'day' | 'week' | 'month'>('day')
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (f: string, t: string, g: string) => {
    setLoading(true)
    setError('')
    try {
      const r = await api(`/api/reports/sales?from=${f}&to=${t}&groupBy=${g}`)
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

  useEffect(() => { void load(from, to, groupBy) }, [load]) // lần đầu
  const applyFilter = () => { setRefreshing(true); void load(from, to, groupBy) }

  const deliveryData = data
    ? [
        { name: 'Đúng hạn', value: data.deliveryPerf.onTime },
        { name: 'Trễ hạn', value: data.deliveryPerf.late },
      ].filter((x) => x.value > 0)
    : []

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Báo cáo bán hàng']}
        title="Báo cáo bán hàng"
        actions={
          <button type="button" className="fm-btn fm-btn--secondary" onClick={applyFilter} disabled={refreshing || loading}>
            <RefreshCw size={16} className={refreshing ? 'fm-spin' : undefined} /> {refreshing ? 'Đang tải…' : 'Tải lại'}
          </button>
        }
      />

      {/* Bộ lọc */}
      <div className="fm-card" style={{ marginBottom: 16 }}>
        <div className="fm-filterbar">
          <div>
            <label className="fm-label" htmlFor="sr-from">Từ ngày</label>
            <input id="sr-from" type="date" className="fm-datepicker" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="fm-label" htmlFor="sr-to">Đến ngày</label>
            <input id="sr-to" type="date" className="fm-datepicker" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className="fm-label" htmlFor="sr-group">Nhóm theo</label>
            <select id="sr-group" className="fm-select" value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'day' | 'week' | 'month')}>
              <option value="day">Ngày</option>
              <option value="week">Tuần</option>
              <option value="month">Tháng</option>
            </select>
          </div>
          <button type="button" className="fm-btn fm-btn--primary fm-btn--sm fm-self-end" onClick={applyFilter} disabled={refreshing || loading}>
            Áp dụng
          </button>
        </div>
      </div>

      {data?.sapWarning && (
        <div className="fm-alert fm-alert--warning" role="status" style={{ marginBottom: 12 }}>
          {data.sapWarning}
        </div>
      )}

      {error && (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>
          <div><b>Không tải được báo cáo.</b> {error}</div>
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm fm-mt-2" onClick={applyFilter}>
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
          {/* Tổng quan */}
          <div className="fm-stats" style={{ marginBottom: 16 }}>
            <div className="fm-stat fm-stat--navy">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><TrendingUp size={18} /></div>
              <div className="fm-stat__label">Tổng doanh số</div>
              <div className="fm-stat__value" style={{ fontSize: 22 }}>{formatVND(data.totalRevenue)}</div>
              <div className="fm-stat__meta">Hóa đơn bán hàng (đã trừ hủy/nháp) · {formatDateVN(data.from)} – {formatDateVN(data.to)}</div>
            </div>
            <div className="fm-stat">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><Receipt size={18} /></div>
              <div className="fm-stat__label">Số hóa đơn</div>
              <div className="fm-stat__value">{data.invoiceCount}</div>
              <div className="fm-stat__meta">Hóa đơn trong kỳ</div>
            </div>
            <div className="fm-stat fm-stat--green">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><BarChart3 size={18} /></div>
              <div className="fm-stat__label">Giao hàng đúng hạn</div>
              <div className="fm-stat__value">{data.deliveryPerf.onTimePct}%</div>
              <div className="fm-stat__meta">{data.deliveryPerf.onTime}/{data.deliveryPerf.total} phiếu đúng hạn</div>
            </div>
          </div>

          {/* Doanh số theo kỳ */}
          <div className="fm-card" style={{ marginBottom: 16 }}>
            <h2 className="fm-card__title">
              Doanh số theo {groupBy === 'day' ? 'ngày' : groupBy === 'week' ? 'tuần' : 'tháng'}
            </h2>
            <div style={{ width: '100%', height: 280 }} role="img" aria-label={`Biểu đồ cột doanh số theo ${groupBy}`}>
              {data.revenueByPeriod.length === 0 ? (
                <div className="fm-empty">Chưa có doanh số trong kỳ</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.revenueByPeriod} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--fm-line)" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v >= 1000000 ? `${Math.round(v / 1000000)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`)} />
                    <Tooltip formatter={(v) => [formatVND(Number(v)), 'Doanh số']} />
                    <Bar dataKey="total" fill="var(--fm-gold)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
            {/* Top 10 mặt hàng */}
            <div className="fm-card">
              <h2 className="fm-card__title">Top 10 mặt hàng theo doanh số</h2>
              <div style={{ width: '100%', height: 320 }} role="img" aria-label="Biểu đồ cột top mặt hàng">
                {data.topItems.length === 0 ? (
                  <div className="fm-empty">Chưa có dữ liệu</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.topItems} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--fm-line)" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="itemCode" tick={{ fontSize: 11 }} width={90} />
                      <Tooltip formatter={(v) => [formatVND(Number(v)), 'Doanh số']} />
                      <Bar dataKey="total" fill="var(--fm-navy-deep)" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Top 10 khách hàng */}
            <div className="fm-card">
              <h2 className="fm-card__title">Top 10 khách hàng theo doanh số</h2>
              <div style={{ width: '100%', height: 320 }} role="img" aria-label="Biểu đồ tròn top khách hàng">
                {data.topCustomers.length === 0 ? (
                  <div className="fm-empty">Chưa có dữ liệu</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={data.topCustomers}
                        dataKey="total"
                        nameKey="cardName"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label={({ cardName, percent }) => `${cardName.slice(0, 16)}${cardName.length > 16 ? '…' : ''} ${(percent * 100).toFixed(0)}%`}
                        labelLine={false}
                        fontSize={11}
                      >
                        {data.topCustomers.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => [formatVND(Number(v)), 'Doanh số']} />
                      <Legend fontSize={11} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
            {/* Doanh số theo nhân viên */}
            <div className="fm-card">
              <h2 className="fm-card__title">Doanh số theo nhân viên (người tạo)</h2>
              {data.topStaff.length === 0 ? (
                <div className="fm-empty">Chưa có dữ liệu</div>
              ) : (
                <div className="fm-table-wrap" style={{ overflowX: 'auto' }}>
                  <table className="fm-table">
                    <thead>
                      <tr>
                        <th>Nhân viên</th>
                        <th className="fm-num">Số hóa đơn</th>
                        <th className="fm-num">Doanh số</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topStaff.map((s) => (
                        <tr key={s.createdBy}>
                          <td>{s.createdBy}</td>
                          <td className="fm-num">{s.count}</td>
                          <td className="fm-num"><b>{formatVND(s.total)}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Hiệu suất giao hàng */}
            <div className="fm-card">
              <h2 className="fm-card__title">Hiệu suất giao hàng đúng hạn / trễ</h2>
              <div style={{ width: '100%', height: 280 }} role="img" aria-label="Biểu đồ tròn hiệu suất giao hàng">
                {deliveryData.length === 0 ? (
                  <div className="fm-empty">Chưa có phiếu giao hàng gắn đơn nguồn trong kỳ</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={deliveryData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={95}
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        labelLine={false}
                        fontSize={12}
                      >
                        <Cell fill="var(--fm-navy)" />
                        <Cell fill="var(--fm-coral)" />
                      </Pie>
                      <Tooltip formatter={(v) => [`${v} phiếu`, '']} />
                      <Legend fontSize={11} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* Đơn hàng mở quá hạn */}
          <div className="fm-card">
            <h2 className="fm-card__title">Đơn hàng mở quá hạn giao</h2>
            {data.openOverdueOrders.length === 0 ? (
              <div className="fm-empty">Không có đơn hàng mở nào quá hạn</div>
            ) : (
              <div className="fm-table-wrap fm-scroll" style={{ overflowX: 'auto' }}>
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Số chứng từ</th>
                      <th>Khách hàng</th>
                      <th>Ngày chứng từ</th>
                      <th>Hạn giao</th>
                      <th>Quá hạn</th>
                      <th className="fm-num">Tổng chứng từ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.openOverdueOrders.map((o) => (
                      <tr key={o.id}>
                        <th scope="row"><b>#{o.docNum}</b></th>
                        <td>{o.cardName}</td>
                        <td>{formatDateVN(o.docDate)}</td>
                        <td>{formatDateVN(o.docDueDate)}</td>
                        <td><span className="fm-chip fm-chip--overdue">Quá hạn {o.daysOverdue} ngày</span></td>
                        <td className="fm-num">{formatVND(o.grandTotal)}</td>
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
