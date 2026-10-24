'use client'

// ============================================================
// GỢI Ý NGÀY GIAO + KHO theo thói quen giao hàng của khách (lịch sử đơn).
// Hiện dưới ô "Ngày giao hàng"; bấm "Áp dụng" để điền ngày giao gợi ý và
// đổi kho xuất (nếu kho quen có trong danh sách kho).
// ============================================================

import { useEffect, useState } from 'react'
import { CalendarCheck } from 'lucide-react'
import { api } from '@/lib/fm-client'
import { formatDateVN } from '@/lib/fm-shared'
import { WEEKDAY_VN, suggestDueDate, type DeliveryPattern } from '@/lib/delivery-pattern'

export default function DeliveryHint({ cardCode, docDate, docDueDate, headerWh, warehouseCodes, disabled, onApply }: {
  cardCode: string | null | undefined
  docDate: string
  docDueDate: string
  headerWh: string
  warehouseCodes: string[]
  disabled?: boolean
  onApply: (dueDate: string, warehouseCode: string | null) => void
}) {
  const code = cardCode?.trim() || ''
  const [loaded, setLoaded] = useState<{ code: string; p: DeliveryPattern | null } | null>(null)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    api(`/api/orders/delivery-pattern?cardCode=${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setLoaded({ code, p: j?.data ?? null }) })
      .catch(() => { if (!cancelled) setLoaded({ code, p: null }) })
    return () => { cancelled = true }
  }, [code])

  const p = loaded?.code === code ? loaded.p : null
  if (!code || !p || !docDate) return null

  const due = suggestDueDate(docDate, p)
  const wh = p.warehouseCode && warehouseCodes.includes(p.warehouseCode) ? p.warehouseCode : null
  const applied = docDueDate === due && (!wh || headerWh === wh)
  const days = p.weekdays.length ? `thường giao ${p.weekdays.map((d) => WEEKDAY_VN[d]).join(', ')}` : 'giao không cố định thứ'

  return (
    <div className="fm-delivery-hint" title={`Suy từ ${p.sample} đơn gần nhất của khách`}>
      <CalendarCheck size={13} aria-hidden />
      <span>
        KH {days} · sau {p.leadDays} ngày{wh ? ` · kho ${wh}` : ''} → <b>{formatDateVN(due)}</b>
      </span>
      {applied
        ? <span className="fm-delivery-hint__ok">đang áp dụng</span>
        : (
          <button type="button" className="fm-link" onClick={() => onApply(due, wh)} disabled={disabled}>
            Áp dụng
          </button>
        )}
    </div>
  )
}
