// Dump thông tin chiết khấu/VAT cấp đơn hàng TRƯỚC khi db push xóa cột
import { db as prisma } from '../src/lib/db'
import { writeFileSync } from 'fs'

async function main() {
  const orders = await prisma.SalesOrder.findMany({
    select: {
      id: true, discountPct: true, vatPct: true,
      totalBeforeDisc: true, discountAmt: true, grandTotal: true,
      lines: { select: { id: true, lineTotal: true, lineNum: true } },
    },
  })
  writeFileSync(__dirname + '/vat-dump.json', JSON.stringify(orders, null, 2))
  console.log(`Dumped ${orders.length} orders → scripts/vat-dump.json`)
}

main().finally(() => prisma.$disconnect())
