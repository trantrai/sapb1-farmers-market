// Xem nhanh cấu hình SAP đang lưu trong DB: bun scripts/inspect-settings.ts
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const s = await p.AppSettings.findUnique({ where: { id: 'main' } })
console.log('DB:', JSON.stringify({ user: s?.sapUser, pass: s?.sapPassword, skip: s?.sslSkipVerify, connected: s?.connected }))
await p.$disconnect()
