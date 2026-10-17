// Patch quyền cho DB đã seed từ trước (thiếu quotations/invoices/creditMemos/returns/downPayments/salesReport/arAgingReport)
// Chạy: node scripts/patch-permissions.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PATCH = {
  Admin: {
    quotations: { view: true, create: true, edit: true, delete: true },
    invoices: { view: true, create: true, edit: true, delete: true },
    creditMemos: { view: true, create: true, edit: true, delete: true },
    returns: { view: true, create: true, edit: true, delete: true },
    downPayments: { view: true, create: true, edit: true, delete: true },
    salesReport: { view: true, create: false, edit: false, delete: false },
    arAgingReport: { view: true, create: false, edit: false, delete: false },
  },
  KeToan: {
    quotations: { view: true, create: true, edit: true, delete: false },
    invoices: { view: true, create: true, edit: true, delete: false },
    creditMemos: { view: true, create: true, edit: true, delete: false },
    returns: { view: true, create: true, edit: true, delete: false },
    downPayments: { view: true, create: true, edit: true, delete: false },
    salesReport: { view: true, create: false, edit: false, delete: false },
    arAgingReport: { view: true, create: false, edit: false, delete: false },
  },
  NhanVien: {
    quotations: { view: true, create: true, edit: false, delete: false },
    invoices: { view: true, create: false, edit: false, delete: false },
    creditMemos: { view: true, create: false, edit: false, delete: false },
    returns: { view: true, create: false, edit: false, delete: false },
    downPayments: { view: true, create: false, edit: false, delete: false },
    salesReport: { view: true, create: false, edit: false, delete: false },
    arAgingReport: { view: true, create: false, edit: false, delete: false },
  },
};

async function main() {
  for (const [roleName, perms] of Object.entries(PATCH)) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) { console.log(`Skip ${roleName}: không tìm thấy`); continue; }
    const current = JSON.parse(role.permissions);
    let changed = false;
    for (const [mod, val] of Object.entries(perms)) {
      if (!current[mod]) { current[mod] = val; changed = true; }
    }
    if (changed) {
      await prisma.role.update({ where: { name: roleName }, data: { permissions: JSON.stringify(current) } });
      console.log(`Đã bổ sung quyền cho role ${roleName}`);
    } else {
      console.log(`Role ${roleName} đã đủ quyền`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
