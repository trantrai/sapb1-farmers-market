// Patch DB hiện có (không seed lại):
// Thêm module "bomImport" vào ma trận quyền của 3 vai trò builtin.
// Admin: full | KeToan: view+create | NhanVien: view
// Chạy: npx tsx scripts/patch-bomimport-perm.ts  (hoặc bun scripts/patch-bomimport-perm.ts)
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const WANT: Record<string, Record<string, boolean>> = {
  Admin: { view: true, create: true, edit: true, delete: true },
  KeToan: { view: true, create: true, edit: false, delete: false },
  NhanVien: { view: true, create: false, edit: false, delete: false },
}

async function main() {
  for (const [name, perm] of Object.entries(WANT)) {
    const role = await prisma.role.findUnique({ where: { name } })
    if (!role) {
      console.log(`• Role ${name}: không tồn tại, bỏ qua`)
      continue
    }
    const p = JSON.parse(role.permissions || '{}')
    if (p.bomImport) {
      console.log(`• Role ${name}: đã có quyền bomImport, bỏ qua`)
      continue
    }
    p.bomImport = perm
    await prisma.role.update({ where: { id: role.id }, data: { permissions: JSON.stringify(p) } })
    console.log(`✓ Role ${name}: đã thêm quyền bomImport`)
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
