'use client'

import { useEffect, useState } from 'react'
import { ClipboardList, FolderOpen, FolderCheck, AlarmClock, Wallet } from 'lucide-react'
import { formatVND, formatDateVN, isOverdue } from '@/lib/fm-shared'
import { api } from '@/lib/fm-client'

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

export default function DashboardView({ onGoOrders }: { onGoOrders: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    api('/api/stats')
      .then((r) => (r.ok ? r.json() : null))
      .then(setStats)
      .catch(() => setStats(null))
  }, [])

  return (
    <div>
      <div className="fm-stats">
        {!stats ? (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="fm-skeleton fm-skeleton--stat" />
          ))
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <h2 className="fm-card__title">Đơn hàng gần đây</h2>
            <p className="fm-card__desc">5 Sale Order mới nhất — bấm “Danh sách đơn hàng” để xem tất cả.</p>
          </div>
          <button className="fm-btn fm-btn--secondary fm-btn--sm" onClick={onGoOrders}>
            Xem tất cả
          </button>
        </div>

        {!stats ? (
          <div>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="fm-skeleton fm-skeleton--row" />
            ))}
          </div>
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
