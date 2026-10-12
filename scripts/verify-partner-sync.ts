// Test đồng bộ KH load thêm Address + Contact Person
// Chạy: bun scripts/mock-sap-server.ts (port 9090) trước, rồi: bun scripts/verify-partner-sync.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const APP = 'http://localhost:3107'

async function main() {
  await prisma.appSettings.upsert({
    where: { id: 'main' },
    update: { serviceLayerUrl: 'http://localhost:9090/b1s/v1', companyDb: 'TEST', sapUser: 'manager', sapPassword: 'Sap@1234', sslSkipVerify: false, connected: false },
    create: { id: 'main', serviceLayerUrl: 'http://localhost:9090/b1s/v1', companyDb: 'TEST', sapUser: 'manager', sapPassword: 'Sap@1234', sslSkipVerify: false, connected: false },
  })

  const login = await fetch(`${APP}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  if (!cookie) { console.error('FAIL: không đăng nhập được'); process.exit(1) }

  // Kích hoạt đồng bộ (chạy nền)
  const sync = await fetch(`${APP}/api/bpartners/sync`, { method: 'POST', headers: { cookie } })
  console.log('Sync trigger:', sync.status)
  // Đợi sync nền xong (poll tối đa 30s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const st = await fetch(`${APP}/api/bpartners/sync`, { headers: { cookie } }).then((r) => r.json())
    if (!st.status?.progress?.running && st.status?.count > 0) break
  }

  // Kiểm tra DB
  const rows = await prisma.businessPartner.findMany({ orderBy: { cardCode: 'asc' } })
  console.log(`\nĐã đồng bộ ${rows.length} KH:`)
  for (const r of rows) {
    console.log(`- ${r.cardCode}: ${r.cardName} | ĐC: ${r.address ?? '—'} | LH: ${r.contactPerson ?? '—'}${r.contactPhone ? ` (${r.contactPhone})` : ''}`)
  }

  const c1 = rows.find((r) => r.cardCode === 'C20001')
  const c3 = rows.find((r) => r.cardCode === 'C20003')
  const checks: [string, boolean][] = [
    ['C20001 có địa chỉ', !!c1?.address],
    ['C20001 có người liên hệ = Nguyễn Văn An', c1?.contactPerson === 'Nguyễn Văn An'],
    ['C20001 có SĐT người liên hệ', c1?.contactPhone === '0903111222'],
    ['C20003 không có người liên hệ (null)', c3?.contactPerson === null],
  ]
  let fail = 0
  for (const [name, ok] of checks) { console.log(ok ? 'PASS' : 'FAIL', '-', name); if (!ok) fail++ }

  // Test /api/partners trả contactPerson
  const p = await fetch(`${APP}/api/partners?q=C20001`, { headers: { cookie } }).then((r) => r.json())
  const hit = p.data?.[0]
  console.log('\n/api/partners?q=C20001:', JSON.stringify({ contactPerson: hit?.contactPerson, contactPhone: hit?.contactPhone, address: hit?.address }))
  const okApi = hit?.contactPerson === 'Nguyễn Văn An'
  console.log(okApi ? 'PASS' : 'FAIL', '- /api/partners trả contactPerson')
  if (!okApi) fail++

  // Dọn: xóa dữ liệu sync + reset settings
  await fetch(`${APP}/api/bpartners/sync`, { method: 'DELETE', headers: { cookie } })
  await prisma.appSettings.update({ where: { id: 'main' }, data: { serviceLayerUrl: '', companyDb: '', sapUser: '', sapPassword: '', connected: false } })
  console.log('\nĐã dọn dữ liệu test')
  await prisma.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
