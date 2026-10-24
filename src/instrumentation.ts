// Next.js instrumentation: chạy 1 lần khi server khởi động.
// Khởi động job nền tự thử lại đơn chưa đẩy được sang SAP B1 (chỉ runtime Node).
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startSapRetryWorker } = await import('./lib/order-sap-retry-worker')
  startSapRetryWorker()
}
