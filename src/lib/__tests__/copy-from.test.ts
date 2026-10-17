// ============================================================
// Test ma trận "Sao chép từ" (copy-from) chuẩn SAP B1 và mapping
// endpoint prefill (?prefill=1) — xem @/lib/copy-from.
// Test thuần (không chạm DB), luôn chạy trong `npx vitest run`.
// ============================================================
import { describe, expect, it } from 'vitest'
import {
  COPY_FROM_SOURCES,
  copyFromPrefillRequest,
  type CopyFromTarget,
} from '@/lib/copy-from'

describe('COPY_FROM_SOURCES — ma trận copy-from chuẩn SAP B1', () => {
  it('đơn hàng bán ← báo giá bán hàng', () => {
    expect(COPY_FROM_SOURCES.order.map((s) => s.key)).toEqual(['quotation'])
  })
  it('phiếu giao hàng ← báo giá bán hàng, đơn hàng bán', () => {
    expect(COPY_FROM_SOURCES.delivery.map((s) => s.key)).toEqual(['quotation', 'order'])
  })
  it('hóa đơn bán hàng ← báo giá, đơn hàng bán, phiếu giao hàng', () => {
    expect(COPY_FROM_SOURCES.invoice.map((s) => s.key)).toEqual(['quotation', 'order', 'delivery'])
  })
  it('phiếu trả hàng bán ← phiếu giao hàng, hóa đơn bán hàng', () => {
    expect(COPY_FROM_SOURCES.return.map((s) => s.key)).toEqual(['delivery', 'invoice'])
  })
  it('phiếu ghi có phải thu ← hóa đơn bán hàng, phiếu trả hàng bán', () => {
    expect(COPY_FROM_SOURCES.creditMemo.map((s) => s.key)).toEqual(['invoice', 'return'])
  })
  it('hóa đơn đặt cọc phải thu ← báo giá bán hàng, đơn hàng bán', () => {
    expect(COPY_FROM_SOURCES.downPayment.map((s) => s.key)).toEqual(['quotation', 'order'])
  })
  it('mọi nguồn đều có listApi hợp lệ', () => {
    const targets: CopyFromTarget[] = ['order', 'delivery', 'invoice', 'creditMemo', 'return', 'downPayment']
    for (const t of targets) {
      for (const s of COPY_FROM_SOURCES[t]) {
        expect(s.listApi).toMatch(/^\/api\/(quotations|orders|deliveries|invoices|returns)$/)
      }
    }
  })
})

describe('copyFromPrefillRequest — endpoint ?prefill=1', () => {
  it('order ← quotation → /api/orders/from-quotation?prefill=1 { quotationId }', () => {
    const r = copyFromPrefillRequest('order', 'quotation', 'q-1')
    expect(r.url).toBe('/api/orders/from-quotation?prefill=1')
    expect(r.body).toEqual({ quotationId: 'q-1' })
  })
  it('delivery ← order → /api/deliveries/from-order?prefill=1 { orderId }', () => {
    const r = copyFromPrefillRequest('delivery', 'order', 'o-1')
    expect(r.url).toBe('/api/deliveries/from-order?prefill=1')
    expect(r.body).toEqual({ orderId: 'o-1' })
  })
  it('invoice/creditMemo/return/downPayment → /api/{base}/from-source?prefill=1 { sourceType, sourceId }', () => {
    expect(copyFromPrefillRequest('invoice', 'delivery', 'd-1')).toEqual({
      url: '/api/invoices/from-source?prefill=1',
      body: { sourceType: 'delivery', sourceId: 'd-1' },
    })
    expect(copyFromPrefillRequest('creditMemo', 'invoice', 'i-1')).toEqual({
      url: '/api/credit-memos/from-source?prefill=1',
      body: { sourceType: 'invoice', sourceId: 'i-1' },
    })
    expect(copyFromPrefillRequest('return', 'invoice', 'i-2')).toEqual({
      url: '/api/returns/from-source?prefill=1',
      body: { sourceType: 'invoice', sourceId: 'i-2' },
    })
    expect(copyFromPrefillRequest('downPayment', 'order', 'o-2')).toEqual({
      url: '/api/down-payments/from-source?prefill=1',
      body: { sourceType: 'order', sourceId: 'o-2' },
    })
  })
})
