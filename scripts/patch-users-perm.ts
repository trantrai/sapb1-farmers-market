// Patch DB hiện có (không seed lại):
// 1. Thêm module "users" vào ma trận quyền của vai trò Admin (full quyền)
// 2. Thêm user demo "kiemke" nếu chưa có
import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'

const prisma = new PrismaClient()
const SALT = 'fm-salt-2024'
const hashPassword = (pw: string) => createHash('sha256').update(pw + SALT).digest('hex')

async function main() {
  const admin = await prisma.Role.findUnique({ where: { name: 'Admin' } })
  if (admin) {
    const perm = JSON.parse(admin.permissions || '{}')
    if (!perm.users) {
      perm.users = { view: true, create: true, edit: true, delete: true }
      await prisma.Role.update({ where: { id: admin.id }, data: { permissions: JSON.stringify(perm) } })
      console.log('✓ Admin role: added users permission')
    } else {
      console.log('• Admin role: users permission already present')
    }
  }

  const kiemke = await prisma.User.findUnique({ where: { username: 'kiemke' } })
  if (!kiemke) {
    await prisma.User.create({
      data: {
        username: 'kiemke',
        password: hashPassword('kiemke123'),
        fullName: 'Phạm Thị Kiểm',
        role: 'NhanVien',
      },
    })
    console.log('✓ Created demo user kiemke/kiemke123 (NhanVien)')
  } else {
    console.log('• kiemke already exists')
  }

  const users = await prisma.User.findMany({ select: { username: true, role: true, active: true } })
  console.log('Users now:', JSON.stringify(users))
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
