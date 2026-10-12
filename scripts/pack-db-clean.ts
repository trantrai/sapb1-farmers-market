// Làm sạch DB dành cho bản đóng gói zip:
// - XÓA toàn bộ dữ liệu nghiệp vụ: đơn hàng + dòng hàng, KH, mặt hàng, nhóm thuế, nhật ký SL Audit
// - GIỮ: users, roles, appSettings (để trống cấu hình SAP)
// Chạy: env -u DATABASE_URL DATABASE_URL="file:<db-tạm>" bun scripts/pack-db-clean.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const del: Record<string, number> = {}
  del.salesOrderLine = (await prisma.salesOrderLine.deleteMany()).count
  del.salesOrder = (await prisma.salesOrder.deleteMany()).count
  del.sapAuditLog = (await prisma.sapAuditLog.deleteMany()).count
  del.vatGroup = (await prisma.vatGroup.deleteMany()).count
  del.businessPartner = (await prisma.businessPartner.deleteMany()).count
  del.item = (await prisma.item.deleteMany()).count
  console.log('Đã xóa:', JSON.stringify(del))

  // Reset cấu hình SAP về rỗng (seed.ts tạo sẵn config demo farmersmarket.vn — không đưa vào zip)
  await prisma.appSettings.updateMany({
    data: {
      serviceLayerUrl: '',
      companyDb: '',
      sapUser: '',
      sapPassword: '',
      sslSkipVerify: false,
      connected: false,
      lastSyncAt: null,
    },
  })
  console.log('Đã reset AppSettings về rỗng')

  const [users, roles, settings] = await Promise.all([
    prisma.user.count(),
    prisma.role.count(),
    prisma.appSettings.count(),
  ])
  console.log(`Giữ nguyên: ${users} users, ${roles} roles, ${settings} settings`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
