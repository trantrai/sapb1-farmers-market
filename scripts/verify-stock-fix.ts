// Test fix lỗi $expand=ItemWarehouseInfo (400) — dùng mock SAP server.
// Chạy: bun scripts/mock-sap-server.ts (port 9090) trước, rồi: bun scripts/verify-stock-fix.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APP = 'http://localhost:3106'

async function main() {
  // 1. Trỏ cấu hình SAP tới mock server
  await prisma.appSettings.upsert({
    where: { id: 'main' },
    update: { serviceLayerUrl: 'http://localhost:9090/b1s/v1', companyDb: 'TEST', sapUser: 'manager', sapPassword: 'Sap@1234', sslSkipVerify: false, connected: false },
    create: { id: 'main', serviceLayerUrl: 'http://localhost:9090/b1s/v1', companyDb: 'TEST', sapUser: 'manager', sapPassword: 'Sap@1234', sslSkipVerify: false, connected: false },
  })
  console.log('Đã trỏ SAP settings tới mock server')

  // 2. Đăng nhập lấy cookie
  const login = await fetch(`${APP}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  if (!cookie) { console.error('FAIL: không đăng nhập được'); process.exit(1) }

  // 3. Gọi API tồn kho — trước fix: SL trả 400 Cannot expand invalid navigation property
  const r = await fetch(`${APP}/api/items/stock?itemCode=FM-RAU-001`, { headers: { cookie } })
  const j = await r.json()
  console.log('HTTP:', r.status)
  console.log('Response:', JSON.stringify(j, null, 1).slice(0, 1200))

  const checks: [string, boolean][] = [
    ['HTTP 200', r.status === 200],
    ['ok=true', j.ok === true],
    ['source=sap', j.source === 'sap'],
    ['có warehouses', Array.isArray(j.warehouses) && j.warehouses.length > 0],
    ['ATP = InStock - Committed + Ordered', j.warehouses?.every((w: { inStock: number; committed: number; onOrder: number; available: number }) => w.available === w.inStock - w.committed + w.onOrder)],
  ]
  let fail = 0
  for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', '-', name)
    if (!ok) fail++
  }

  // 4. Reset settings về trạng thái chưa cấu hình
  await prisma.appSettings.update({ where: { id: 'main' }, data: { serviceLayerUrl: '', companyDb: '', sapUser: '', sapPassword: '', connected: false } })
  console.log('Đã reset SAP settings')
  await prisma.$disconnect()
  console.log('WAREHOUSES_CHECK_DONE'); process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
