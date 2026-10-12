// Kiểm thử fix VAT=0 ở chi tiết đơn SAP (không cần DB thật ngoài audit log):
// 1. Tạo đơn trên MOCK Service Layer: 1 dòng, SL=1, đơn giá 21.296, CK đầu 10%, thuế S8 (8%)
//    → mock mô phỏng SL THẬT: DocumentLines KHÔNG có VatSum.
// 2. Đọc chi tiết bằng fetchSapOrderDetail của app.
// 3. Kỳ vọng: VAT dòng = round((21296 - 2130) * 8%) = 1.533; tổng = 20.699.
// Chạy: MOCK chạy ở port 9090 trước (bun scripts/mock-sap-server.ts),
//       rồi: bun scripts/verify-vat-fix.ts
import type { SapConfig } from '../src/lib/sap-service-layer'

async function main() {
  const { fetchSapOrderDetail } = await import('../src/lib/sap-orders')
  const { sapPost } = await import('../src/lib/sap-service-layer')
  const cfg: SapConfig = {
    serviceLayerUrl: 'http://localhost:9090/b1s/v1',
    companyDb: 'TEST',
    sapUser: 'manager',
    sapPassword: 'Sap@1234',
  }
  // Tạo đơn có CK đầu chứng từ 10% — đúng kịch bản đơn #37 của user
  const created = await sapPost<{ DocEntry?: number }>(cfg, '/Orders', {
    CardCode: 'C20001',
    DocDate: '2026-10-08',
    DocDueDate: '2026-10-13',
    DiscountPercent: 10,
    DocumentLines: [
      { ItemCode: 'FM-QUA-001', Quantity: 1, UnitPrice: 21296, DiscountPercent: 0, VatGroup: 'S8' },
    ],
  })
  if (!created.ok || !created.data?.DocEntry) {
    console.error('FAIL: không tạo được đơn trên mock:', created.error)
    process.exit(1)
  }
  const docEntry = created.data.DocEntry
  console.log(`Đã tạo đơn mock DocEntry=${docEntry}`)

  const det = await fetchSapOrderDetail(cfg, docEntry)
  if (!det.ok || !det.order) {
    console.error('FAIL: không đọc được chi tiết:', det.error)
    process.exit(1)
  }
  const o = det.order
  const line = o.lines[0]
  console.log('Dòng hàng:', JSON.stringify({ vatPct: line.vatPct, vatAmt: line.vatAmt, grandTotal: line.grandTotal, vatAmtFromSap: line.vatAmtFromSap }))
  console.log('Chứng từ:', JSON.stringify({ totalBeforeDisc: o.totalBeforeDisc, headerDiscPct: o.headerDiscPct, headerDiscAmt: o.headerDiscAmt, vatAmt: o.vatAmt, grandTotal: o.grandTotal }))

  const checks: [string, unknown, unknown][] = [
    ['VAT% dòng', line.vatPct, 8],
    ['Tiền VAT dòng', line.vatAmt, 1533],
    ['Tiền dòng (sau VAT)', line.grandTotal, 20699],
    ['Thuế VAT các dòng', o.vatAmt, 1533],
    ['TỔNG CỘNG', o.grandTotal, 20699],
    ['CK đầu chứng từ', o.headerDiscAmt, 2130],
  ]
  let fail = 0
  for (const [name, got, want] of checks) {
    const ok = got === want
    if (!ok) fail++
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} = ${got} (kỳ vọng ${want})`)
  }
  process.exit(fail ? 1 : 0)
}

main().finally(() => process.exit(0))
