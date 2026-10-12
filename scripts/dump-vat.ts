// Dump thông tin đơn hàng ra JSON (script tiện ích một lần — đã dùng xong
// trong đợt migration VAT theo dòng; giữ lại để tham khảo).
import { db as prisma } from '../src/lib/db'
import { writeFileSync } from 'fs'

async function main() {
  const orders = await prisma.salesOrder.findMany({
    select: {
      id: true,
      docNum: true,
      totalBeforeDisc: true,
      discountAmt: true,
      headerDiscAmt: true,
      vatAmt: true,
      grandTotal: true,
      lines: { select: { id: true, lineTotal: true, lineNum: true } },
    },
  })
  writeFileSync(__dirname + '/vat-dump.json', JSON.stringify(orders, null, 2))
  console.log(`Dumped ${orders.length} orders → scripts/vat-dump.json`)
}

main().finally(() => prisma.$disconnect())
