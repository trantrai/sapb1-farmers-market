// ============================================================
// XÓA DỮ LIỆU DEMO — giữ lại Users, Roles, AppSettings
// Dữ liệu khách hàng & mặt hàng sẽ lấy trực tiếp từ SAP B1
// Service Layer; đơn hàng lưu local khi tạo mới.
// Chạy: bun scripts/clear-demo-data.ts
// ============================================================
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🧹 Xóa dữ liệu demo (đơn hàng, khách hàng, mặt hàng)...')
  const [lines, orders, partners, items] = await Promise.all([
    prisma.SalesOrderLine.deleteMany(),
    prisma.SalesOrder.deleteMany(),
    prisma.BusinessPartner.deleteMany(),
    prisma.Item.deleteMany(),
  ])
  console.log(`   ↳ Đã xóa: ${lines.count} dòng hàng, ${orders.count} đơn hàng, ${partners.count} khách hàng, ${items.count} mặt hàng`)

  const [users, roles, settings] = await Promise.all([
    prisma.User.count(),
    prisma.Role.count(),
    prisma.AppSettings.count(),
  ])
  console.log(`✅ Giữ nguyên: ${users} users, ${roles} roles, ${settings} settings`)
  console.log('👉 Vào trang Cài đặt để cấu hình SAP B1 Service Layer và bấm "Kiểm tra kết nối".')
}

main()
  .catch((e) => {
    console.error('❌ Lỗi khi xóa dữ liệu demo:', e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
