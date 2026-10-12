// Xem nhanh cấu hình SAP đang lưu trong DB: bun scripts/inspect-settings.ts
// (Mật khẩu luôn được che khi in ra console.)
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const s = await p.appSettings.findUnique({ where: { id: 'main' } })
console.log(
  'DB:',
  JSON.stringify({
    url: s?.serviceLayerUrl,
    companyDb: s?.companyDb,
    user: s?.sapUser,
    pass: s?.sapPassword ? '••••••••' : '',
    skip: s?.sslSkipVerify,
    connected: s?.connected,
  }),
)
await p.$disconnect()
