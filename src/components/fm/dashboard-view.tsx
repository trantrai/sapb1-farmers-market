'use client'

import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, FolderOpen, FolderCheck, AlarmClock, Wallet, RefreshCw, PlusCircle, BarChart3 } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { formatVND, formatDateVN, isOverdue } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

interface RecentOrder {
  id: string
  docNum: number
  cardName: string
  docDate: string
  status: string
  grandTotal: number
  docDueDate: string
}

interface Stats {
  totalOrders: number
  openOrders: number
  closedOrders: number
  overdueOrders: number
  revenueClosed: number
  recent: RecentOrder[]
}

interface ChartStats {
  range: number
  revenueByDay: { day: string; total: number }[]
  topCustomers: { cardCode: string; cardName: string; total: number; orderCount: number }[]
  topItems: { itemCode: string; itemName: string; quantity: number; total: number }[]
}

const CHART_COLORS = ['#fea619', '#0e1c2f', '#2e7d32', '#c62828', '#1565c0', '#6a1b9a']

export default function DashboardView({ onGoOrders, onGoCreate }: { onGoOrders: () => void; onGoCreate: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [chartRange, setChartRange] = useState<7 | 30>(7)
  const [charts, setCharts] = useState<ChartStats | null>(null)

  // setState chỉ nằm trong callback .then/.catch (bất đồng bộ) để qua rule react-hooks/set-state-in-effect
  const load = useCallback(() => {
    api('/api/stats')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j: Stats) => {
        setStats(j)
        setLoadError(false)
      })
      .catch(() => {
        setStats(null)
        setLoadError(true)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Biểu đồ: tải lại khi đổi khoảng thời gian
  useEffect(() => {
    let cancelled = false
    api(`/api/dashboard/stats?range=${chartRange}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: ChartStats | null) => {
        if (!cancelled && j) setCharts(j)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [chartRange])

  const loadFailed = loadError && !stats

  const retry = () => {
    setLoadError(false) // hiện skeleton lại trong lúc tải
    load()
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Bảng điều khiển', 'Tổng quan hệ thống']}
        title="Tổng Quan Hệ Thống"
        badge="Cập nhật tức thời"
        actions={
          <>
            <button type="button" className="fm-btn fm-btn--secondary" onClick={load}>
              <RefreshCw size={15} /> Đồng bộ SAP B1
            </button>
            <button type="button" className="fm-btn fm-btn--primary" onClick={onGoCreate}>
              <PlusCircle size={16} /> Tạo Sale Order mới
            </button>
          </>
        }
      />
      {loadFailed && (
        <div className="fm-alert fm-alert--error" role="alert" style={{ marginBottom: 12 }}>
          <div><b>Không tải được số liệu tổng quan.</b> Kiểm tra kết nối mạng rồi thử lại.</div>
          <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" style={{ marginTop: 8 }} onClick={retry}>
            Thử lại
          </button>
        </div>
      )}
      <div className="fm-stats" aria-busy={!stats && !loadError}>
        {!stats ? (
          loadFailed ? null : (
            Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="fm-skeleton fm-skeleton--stat" />
            ))
          )
        ) : (
          <>
            <div className="fm-stat">
              <div className="fm-stat__icon"><ClipboardList size={17} /></div>
              <div className="fm-stat__label">Tổng đơn hàng</div>
              <div className="fm-stat__value">{stats.totalOrders}</div>
              <div className="fm-stat__meta">Tất cả Sale Order trong hệ thống</div>
            </div>
            <div className="fm-stat fm-stat--navy">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-navy-soft)' }}><FolderOpen size={17} /></div>
              <div className="fm-stat__label">Đang mở (Open)</div>
              <div className="fm-stat__value">{stats.openOrders}</div>
              <div className="fm-stat__meta">Chưa hoàn tất / chờ giao</div>
            </div>
            <div className="fm-stat fm-stat--green">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-green-soft)', color: 'var(--fm-green)' }}><FolderCheck size={17} /></div>
              <div className="fm-stat__label">Đã đóng (Closed)</div>
              <div className="fm-stat__value">{stats.closedOrders}</div>
              <div className="fm-stat__meta">Hoàn tất chứng từ</div>
            </div>
            <div className="fm-stat fm-stat--red">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-red-soft)', color: 'var(--fm-red)' }}><AlarmClock size={17} /></div>
              <div className="fm-stat__label">Quá hạn giao</div>
              <div className="fm-stat__value">{stats.overdueOrders}</div>
              <div className="fm-stat__meta">Open nhưng đã quá DocDueDate</div>
            </div>
            <div className="fm-stat fm-stat--navy">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-yellow-soft)' }}><Wallet size={17} /></div>
              <div className="fm-stat__label">Doanh thu đơn đã đóng</div>
              <div className="fm-stat__value" style={{ fontSize: 22 }}>{formatVND(stats.revenueClosed)}</div>
              <div className="fm-stat__meta">Tổng giá trị đơn Closed (đã VAT)</div>
            </div>
          </>
        )}
      </div>

      <div className="fm-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h2 className="fm-card__title" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <BarChart3 size={18} /> Doanh số theo ngày
          </h2>
          <div style={{ display: 'flex', gap: 6 }}>
            {([7, 30] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={`fm-btn fm-btn--sm ${chartRange === r ? 'fm-btn--primary' : 'fm-btn--secondary'}`}
                onClick={() => setChartRange(r)}
              >
                {r} ngày
              </button>
            ))}
          </div>
        </div>
        <div style={{ width: '100%', height: 280, marginTop: 12 }}>
          {!charts ? (
            <div className="fm-skeleton" style={{ height: 280 }} />
          ) : charts.revenueByDay.every((d) => d.total === 0) ? (
            <div className="fm-empty">Chưa có doanh số trong {chartRange} ngày qua</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={charts.revenueByDay} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} interval={chartRange === 30 ? 2 : 0} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v >= 1000000 ? `${Math.round(v / 1000000)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`)} />
                <Tooltip formatter={(v) => [formatVND(Number(v)), 'Doanh số']} labelFormatter={(l) => `Ngày ${l}`} />
                <Bar dataKey="total" fill="#fea619" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="fm-card">
          <h2 className="fm-card__title">Top 5 khách hàng theo doanh số</h2>
          <div style={{ width: '100%', height: 280 }}>
            {!charts ? (
              <div className="fm-skeleton" style={{ height: 280 }} />
            ) : charts.topCustomers.length === 0 ? (
              <div className="fm-empty">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={charts.topCustomers}
                    dataKey="total"
                    nameKey="cardName"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    label={({ cardName, percent }) => `${cardName.slice(0, 18)}${cardName.length > 18 ? '…' : ''} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                    fontSize={11}
                  >
                    {charts.topCustomers.map((_, i) => (
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

        <div className="fm-card">
          <h2 className="fm-card__title">Top 5 mặt hàng bán chạy</h2>
          <div style={{ width: '100%', height: 280 }}>
            {!charts ? (
              <div className="fm-skeleton" style={{ height: 280 }} />
            ) : charts.topItems.length === 0 ? (
              <div className="fm-empty">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.topItems} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="itemCode" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip formatter={(v, name) => (name === 'quantity' ? [`${v}`, 'Số lượng'] : [formatVND(Number(v)), 'Doanh số'])} />
                  <Bar dataKey="quantity" fill="#0e1c2f" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="fm-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h2 className="fm-card__title">Đơn hàng gần đây</h2>
          </div>
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={onGoOrders}>
            Xem tất cả
          </button>
        </div>

        {!stats ? (
          loadFailed ? null : (
            <div>
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="fm-skeleton fm-skeleton--row" />
              ))}
            </div>
          )
        ) : stats.recent.length === 0 ? (
          <div className="fm-empty">Chưa có đơn hàng nào</div>
        ) : (
          <>
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
            <table className="fm-table">
              <thead>
                <tr>
                  <th>Số CT</th>
                  <th>Khách hàng</th>
                  <th>Ngày chứng từ</th>
                  <th>Hạn giao</th>
                  <th>Trạng thái</th>
                  <th className="fm-num">Tổng tiền</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((o) => (
                  <tr key={o.id}>
                    <td><b>#{o.docNum}</b></td>
                    <td>{o.cardName}</td>
                    <td>{formatDateVN(o.docDate)}</td>
                    <td>{formatDateVN(o.docDueDate)}</td>
                    <td>
                      {isOverdue(o.docDueDate, o.status) ? (
                        <span className="fm-chip fm-chip--overdue">Quá hạn</span>
                      ) : o.status === 'Open' ? (
                        <span className="fm-chip fm-chip--open">Open</span>
                      ) : (
                        <span className="fm-chip fm-chip--closed">Closed</span>
                      )}
                    </td>
                    <td className="fm-num">{formatVND(o.grandTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

            {/* Card (mobile) */}
            <div className="fm-only-mobile">
            {stats.recent.map((o) => (
              <div key={o.id} className="fm-ocard" style={{ cursor: 'default' }}>
                <div className="fm-ocard__top">
                  <span className="fm-ocard__num">#{o.docNum}</span>
                  {isOverdue(o.docDueDate, o.status) ? (
                    <span className="fm-chip fm-chip--overdue">Quá hạn</span>
                  ) : o.status === 'Open' ? (
                    <span className="fm-chip fm-chip--open">Open</span>
                  ) : (
                    <span className="fm-chip fm-chip--closed">Closed</span>
                  )}
                </div>
                <div className="fm-ocard__name">{o.cardName}</div>
                <div className="fm-ocard__meta">Ngày CT {formatDateVN(o.docDate)} · Hạn giao {formatDateVN(o.docDueDate)}</div>
                <div className="fm-ocard__bottom">
                  <span className="fm-ocard__total">{formatVND(o.grandTotal)}</span>
                </div>
              </div>
            ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
