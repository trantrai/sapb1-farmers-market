'use client'

import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, FolderOpen, FolderCheck, AlarmClock, Wallet, RefreshCw, PlusCircle, Plus, BarChart3 } from 'lucide-react'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { formatVND, formatDateVN, isOverdue, isDueSoon, daysOverdue, daysUntilDue } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'
import PageHeader from './page-header'

interface RecentOrder {
  id: string
  docNum: number
  cardName: string
  docDate: string
  status: string
  grandTotal: number
  docDueDate: string | null
}

interface AttentionOrder {
  id: string
  docNum: number
  cardCode: string
  cardName: string
  docDate: string
  docDueDate: string
  status: string
  grandTotal: number
}

interface Stats {
  totalOrders: number
  openOrders: number
  closedOrders: number
  overdueOrders: number
  revenueClosed: number
  recent: RecentOrder[]
  attention: AttentionOrder[]
  sources: { sap: boolean }
  warning?: string
}

interface ChartStats {
  range: number
  revenueByDay: { day: string; total: number }[]
  topCustomers: { cardCode: string; cardName: string; total: number; orderCount: number }[]
  topItems: { itemCode: string; itemName: string; quantity: number; total: number }[]
  sources: { sap: boolean }
  warning?: string
}

// Palette biểu đồ map về token theme (globals.css): gold / navy / green / red / coral / navy-deep
const CHART_COLORS = ['var(--fm-yellow)', 'var(--fm-navy)', 'var(--fm-green)', 'var(--fm-red)', 'var(--fm-coral)', 'var(--fm-navy-deep)']

export default function DashboardView({ onGoOrders, onGoCreate, onGoOrderDetail }: { onGoOrders: () => void; onGoCreate: () => void; onGoOrderDetail: (id: string) => void }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [chartRange, setChartRange] = useState<7 | 30>(7)
  const [charts, setCharts] = useState<ChartStats | null>(null)
  const [chartError, setChartError] = useState(false)

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

  // Biểu đồ: tải lại khi đổi khoảng thời gian (lỗi hiện rõ thay vì treo skeleton)
  const loadCharts = useCallback((range: 7 | 30) => {
    let cancelled = false
    api(`/api/dashboard/stats?range=${range}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((j: ChartStats) => {
        if (!cancelled) {
          setCharts(j)
          setChartError(false)
        }
      })
      .catch(() => {
        if (!cancelled) setChartError(true)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => loadCharts(chartRange), [loadCharts, chartRange])

  const retryCharts = () => {
    setCharts(null)
    setChartError(false)
    loadCharts(chartRange)
  }

  const chartFailed = chartError && !charts
  const chartLoadBox = chartFailed ? (
    <div className="fm-empty">
      Không tải được biểu đồ.
      <div>
        <button type="button" className="fm-btn fm-btn--secondary fm-btn--sm" style={{ marginTop: 8 }} onClick={retryCharts}>
          Thử lại
        </button>
      </div>
    </div>
  ) : (
    <div className="fm-skeleton" style={{ height: 280 }} />
  )

  const loadFailed = loadError && !stats

  const retry = () => {
    setLoadError(false) // hiện skeleton lại trong lúc tải
    load()
  }

  return (
    <div>
      <PageHeader
        breadcrumb={['Chức năng chính', 'Tổng quan hệ thống']}
        title="Tổng quan hệ thống"
        badge="Dữ liệu cache 45s"
        badgeHint="Số liệu từ SAP B1 được cache tối đa 45 giây — bấm “Tải lại số liệu” để lấy mới nhất"
        actions={
          <>
            <button type="button" className="fm-btn fm-btn--secondary" onClick={load}>
              <RefreshCw size={16} /> Tải lại số liệu
            </button>
            <button type="button" className="fm-btn fm-btn--primary" onClick={onGoCreate}>
              <PlusCircle size={16} /> Tạo đơn hàng bán mới
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
      {(stats?.warning || (!stats && charts?.warning)) && (
        <div className="fm-alert fm-alert--warning" role="alert" style={{ marginBottom: 12 }}>
          {stats?.warning ?? charts?.warning}
        </div>
      )}
      {stats?.sources.sap && (
        <div style={{ marginBottom: 12 }}>
          <span className="fm-chip fm-chip--open">Gồm đơn SAP B1 trực tiếp</span>
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
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><ClipboardList size={18} /></div>
              <div className="fm-stat__label">Tổng đơn hàng</div>
              <div className="fm-stat__value">{stats.totalOrders}</div>
              <div className="fm-stat__meta">Tất cả đơn hàng bán trong hệ thống</div>
            </div>
            <div className="fm-stat fm-stat--navy">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><FolderOpen size={18} /></div>
              <div className="fm-stat__label">Đang mở</div>
              <div className="fm-stat__value">{stats.openOrders}</div>
              <div className="fm-stat__meta">Chưa hoàn tất / chờ giao</div>
            </div>
            <div className="fm-stat fm-stat--green">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><FolderCheck size={18} /></div>
              <div className="fm-stat__label">Đã đóng</div>
              <div className="fm-stat__value">{stats.closedOrders}</div>
              <div className="fm-stat__meta">Hoàn tất chứng từ</div>
            </div>
            <div className="fm-stat fm-stat--red">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-coral-soft)', color: 'var(--fm-coral-deep)' }}><AlarmClock size={18} /></div>
              <div className="fm-stat__label">Quá hạn giao</div>
              <div className="fm-stat__value">{stats.overdueOrders}</div>
              <div className="fm-stat__meta">Open nhưng đã quá DocDueDate</div>
            </div>
            <div className="fm-stat fm-stat--navy">
              <div className="fm-stat__icon" style={{ background: 'var(--fm-line)', color: 'var(--fm-text-2)' }}><Wallet size={18} /></div>
              <div className="fm-stat__label">Doanh thu đơn đã đóng</div>
              <div className="fm-stat__value" style={{ fontSize: 22 }}>{formatVND(stats.revenueClosed)}</div>
              <div className="fm-stat__meta">Tổng giá trị đơn đã đóng (đã VAT)</div>
            </div>
          </>
        )}
      </div>

      {/* Đơn cần chú ý: quá hạn / sắp đến hạn */}
      <div className="fm-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <h2 className="fm-card__title fm-row" style={{ alignItems: 'center', margin: 0 }}>
            <AlarmClock size={18} /> Đơn cần chú ý
          </h2>
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={onGoOrders}>
            Xem tất cả
          </button>
        </div>

        {!stats ? (
          loadFailed ? null : (
            <div>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="fm-skeleton fm-skeleton--row" />
              ))}
            </div>
          )
        ) : stats.attention.length === 0 ? (
          <div className="fm-empty">Không có đơn quá hạn hay sắp đến hạn</div>
        ) : (
          <>
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Số chứng từ</th>
                    <th>Khách hàng</th>
                    <th>Hạn giao</th>
                    <th>Trạng thái</th>
                    <th className="fm-num">Tổng chứng từ</th>
                    <th><span className="fm-sr-only">Thao tác</span></th>
                  </tr>
                </thead>
                <tbody>
                  {stats.attention.map((o) => (
                    <tr key={o.id}>
                      <th scope="row"><b>#{o.docNum}</b></th>
                      <td>{o.cardName}</td>
                      <td>{formatDateVN(o.docDueDate)}</td>
                      <td>
                        {isOverdue(o.docDueDate, o.status) ? (
                          <span className="fm-chip fm-chip--overdue">Quá hạn {daysOverdue(o.docDueDate)} ngày</span>
                        ) : (
                          <span className="fm-chip fm-chip--warn">Còn {daysUntilDue(o.docDueDate)} ngày</span>
                        )}
                      </td>
                      <td className="fm-num">{formatVND(o.grandTotal)}</td>
                      <td>
                        <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => onGoOrderDetail(o.id)}>
                          Xem
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Card (mobile) */}
            <div className="fm-only-mobile">
              {stats.attention.map((o) => (
                <div key={o.id} className="fm-ocard">
                  <div className="fm-ocard__top">
                    <span className="fm-ocard__num">#{o.docNum}</span>
                    {isOverdue(o.docDueDate, o.status) ? (
                      <span className="fm-chip fm-chip--overdue">Quá hạn {daysOverdue(o.docDueDate)} ngày</span>
                    ) : (
                      <span className="fm-chip fm-chip--warn">Còn {daysUntilDue(o.docDueDate)} ngày</span>
                    )}
                  </div>
                  <div className="fm-ocard__name">{o.cardName}</div>
                  <div className="fm-ocard__meta">Hạn giao {formatDateVN(o.docDueDate)}</div>
                  <div className="fm-ocard__bottom">
                    <span className="fm-ocard__total">{formatVND(o.grandTotal)}</span>
                    <button className="fm-btn fm-btn--ghost fm-btn--sm" onClick={() => onGoOrderDetail(o.id)}>
                      Xem
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="fm-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h2 className="fm-card__title fm-row" style={{ alignItems: 'center', margin: 0 }}>
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
        <div
          style={{ width: '100%', height: 280, marginTop: 12 }}
          role="img"
          aria-label={charts ? `Biểu đồ cột doanh số ${chartRange} ngày qua. ` + charts.revenueByDay.filter((d) => d.total > 0).map((d) => `${d.day}: ${formatVND(d.total)}`).join('; ') : 'Đang tải biểu đồ doanh số'}
        >
          {!charts ? chartLoadBox : charts.revenueByDay.every((d) => d.total === 0) ? (
            <div className="fm-empty">Chưa có doanh số trong {chartRange} ngày qua</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={charts.revenueByDay} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--fm-line)" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} interval={chartRange === 30 ? 2 : 0} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => (v >= 1000000 ? `${Math.round(v / 1000000)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : `${v}`)} />
                <Tooltip formatter={(v) => [formatVND(Number(v)), 'Doanh số']} labelFormatter={(l) => `Ngày ${l}`} />
                <Bar dataKey="total" fill="var(--fm-gold)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="fm-card">
          <h2 className="fm-card__title">Top 5 khách hàng theo doanh số</h2>
          <div
            style={{ width: '100%', height: 280 }}
            role="img"
            aria-label={charts ? 'Biểu đồ tròn top khách hàng. ' + charts.topCustomers.map((c) => `${c.cardName}: ${formatVND(c.total)}`).join('; ') : 'Đang tải biểu đồ'}
          >
            {!charts ? chartLoadBox : charts.topCustomers.length === 0 ? (
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
          <div
            style={{ width: '100%', height: 280 }}
            role="img"
            aria-label={charts ? 'Biểu đồ cột top mặt hàng bán chạy. ' + charts.topItems.map((it) => `${it.itemName}: ${it.quantity} — ${formatVND(it.total)}`).join('; ') : 'Đang tải biểu đồ'}
          >
            {!charts ? chartLoadBox : charts.topItems.length === 0 ? (
              <div className="fm-empty">Chưa có dữ liệu</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.topItems} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--fm-line)" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="itemCode" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip formatter={(v, name) => (name === 'quantity' ? [`${v}`, 'Số lượng'] : [formatVND(Number(v)), 'Doanh số'])} />
                  <Bar dataKey="quantity" fill="var(--fm-navy-deep)" radius={[0, 4, 4, 0]} />
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
          <div className="fm-empty">
            Chưa có đơn hàng nào
            <button type="button" className="fm-btn fm-btn--primary" style={{ marginTop: 10 }} onClick={onGoCreate}>
              <Plus size={16} /> Tạo đơn hàng bán
            </button>
          </div>
        ) : (
          <>
            <div className="fm-table-wrap fm-scroll fm-only-desktop" style={{ overflowX: 'auto' }}>
            <table className="fm-table">
              <thead>
                <tr>
                  <th>Số chứng từ</th>
                  <th>Khách hàng</th>
                  <th>Ngày chứng từ</th>
                  <th>Hạn giao</th>
                  <th>Trạng thái</th>
                  <th className="fm-num">Tổng chứng từ</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((o) => (
                  <tr
                    key={o.id}
                    style={{ cursor: 'pointer' }}
                    tabIndex={0}
                    title="Xem chi tiết đơn"
                    aria-label={`Xem chi tiết đơn #${o.docNum} — ${o.cardName}`}
                    onClick={() => onGoOrderDetail(o.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onGoOrderDetail(o.id)
                      }
                    }}
                  >
                    <th scope="row"><b>#{o.docNum}</b></th>
                    <td>{o.cardName}</td>
                    <td>{formatDateVN(o.docDate)}</td>
                    <td>{o.docDueDate ? formatDateVN(o.docDueDate) : <span style={{ color: 'var(--fm-text-2)' }}>—</span>}</td>
                    <td>
                      {o.docDueDate && isOverdue(o.docDueDate, o.status) ? (
                        <span className="fm-chip fm-chip--overdue">Quá hạn {daysOverdue(o.docDueDate)} ngày</span>
                      ) : o.docDueDate && isDueSoon(o.docDueDate, o.status) ? (
                        <span className="fm-chip fm-chip--warn">Còn {daysUntilDue(o.docDueDate)} ngày</span>
                      ) : o.status === 'Open' ? (
                        <span className="fm-chip fm-chip--open">Open</span>
                      ) : (
                        <span className="fm-chip fm-chip--closed">Đã đóng</span>
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
              <div
                key={o.id}
                className="fm-ocard"
                style={{ cursor: 'pointer' }}
                tabIndex={0}
                role="button"
                title="Xem chi tiết đơn"
                aria-label={`Xem chi tiết đơn #${o.docNum} — ${o.cardName}`}
                onClick={() => onGoOrderDetail(o.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onGoOrderDetail(o.id)
                  }
                }}
              >
                <div className="fm-ocard__top">
                  <span className="fm-ocard__num">#{o.docNum}</span>
                  {o.docDueDate && isOverdue(o.docDueDate, o.status) ? (
                    <span className="fm-chip fm-chip--overdue">Quá hạn {daysOverdue(o.docDueDate)} ngày</span>
                  ) : o.docDueDate && isDueSoon(o.docDueDate, o.status) ? (
                    <span className="fm-chip fm-chip--warn">Còn {daysUntilDue(o.docDueDate)} ngày</span>
                  ) : o.status === 'Open' ? (
                    <span className="fm-chip fm-chip--open">Open</span>
                  ) : (
                    <span className="fm-chip fm-chip--closed">Đã đóng</span>
                  )}
                </div>
                <div className="fm-ocard__name">{o.cardName}</div>
                <div className="fm-ocard__meta">Ngày CT {formatDateVN(o.docDate)} · Hạn giao {o.docDueDate ? formatDateVN(o.docDueDate) : '—'}</div>
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
