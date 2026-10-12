// Patch DB hiện có (không seed lại):
// 1. Thêm module "users" vào ma trận quyền của vai trò Admin (full quyền)
// 2. Thêm user demo "kiemke" nếu chưa có
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/lib/fm-crypto'

const prisma = new PrismaClient()

async function main() {
  const admin = await prisma.role.findUnique({ where: { name: 'Admin' } })
  if (admin) {
    const perm = JSON.parse(admin.permissions || '{}')
    if (!perm.users) {
      perm.users = { view: true, create: true, edit: true, delete: true }
      await prisma.role.update({ where: { id: admin.id }, data: { permissions: JSON.stringify(perm) } })
      console.log('✓ Admin role: added users permission')
    } else {
      console.log('• Admin role: users permission already present')
    }
  }

  const kiemke = await prisma.user.findUnique({ where: { username: 'kiemke' } })
  if (!kiemke) {
    await prisma.user.create({
      data: {
        username: 'kiemke',
        password: await hashPassword('kiemke123'),
        fullName: 'Phạm Thị Kiểm',
        role: 'NhanVien',
      },
    })
    console.log('✓ Created demo user kiemke/kiemke123 (NhanVien)')
  } else {
    console.log('• kiemke already exists')
  }

  const users = await prisma.user.findMany({ select: { username: true, role: true, active: true } })
  console.log('Users now:', JSON.stringify(users))
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
