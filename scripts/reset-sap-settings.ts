// Reset AppSettings về trạng thái chưa kết nối SAP (dùng sau khi test)
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = await prisma.appSettings.update({
  where: { id: 'main' },
  data: { connected: false, serviceLayerUrl: '', companyDb: '', sapUser: '' },
})
console.log('Reset xong:', { url: s.serviceLayerUrl, db: s.companyDb, user: s.sapUser, connected: s.connected })
await prisma.$disconnect()
