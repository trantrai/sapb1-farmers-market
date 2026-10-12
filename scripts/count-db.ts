// Kiểm đếm bảng theo DATABASE_URL từ env (bắt buộc chạy kèm env -u DATABASE_URL DATABASE_URL=file:...)
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const [users, roles, settings, partners, items, orders, lines, vats, audits] = await Promise.all([
    prisma.user.count(),
    prisma.role.count(),
    prisma.appSettings.count(),
    prisma.businessPartner.count(),
    prisma.item.count(),
    prisma.salesOrder.count(),
    prisma.salesOrderLine.count(),
    prisma.vatGroup.count(),
    prisma.sapAuditLog.count(),
  ])
  const s = await prisma.appSettings.findFirst()
  console.log(
    JSON.stringify(
      {
        users,
        roles,
        settings,
        partners,
        items,
        orders,
        lines,
        vatGroups: vats,
        sapAuditLogs: audits,
        appSettings: s
          ? { url: s.serviceLayerUrl, db: s.companyDb, user: s.sapUser, pass: s.sapPassword, connected: s.connected }
          : null,
      },
      null,
      2,
    ),
  )
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
