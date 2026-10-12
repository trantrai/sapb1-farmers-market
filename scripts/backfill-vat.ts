// Backfill: chuyển chiết khấu/VAT cấp đơn hàng cũ sang từng dòng hàng
import { db as prisma } from '../src/lib/db'
import { readFileSync } from 'fs'

interface DumpLine { id: string; lineTotal: number; lineNum: number }
interface DumpOrder {
  id: string; discountPct: number; vatPct: number
  totalBeforeDisc: number; discountAmt: number; grandTotal: number
  lines: DumpLine[]
}

async function main() {
  const dump: DumpOrder[] = JSON.parse(readFileSync(__dirname + '/vat-dump.json', 'utf8'))
  for (const o of dump) {
    const discPct = o.discountPct || 0
    const vatPct = o.vatPct || 8
    let sumDisc = 0, sumVat = 0, sumGrand = 0
    for (const l of o.lines) {
      const discAmt = Math.round((l.lineTotal * discPct) / 100)
      const afterDisc = l.lineTotal - discAmt
      const vatAmt = Math.round((afterDisc * vatPct) / 100)
      const grand = afterDisc + vatAmt
      sumDisc += discAmt; sumVat += vatAmt; sumGrand += grand
      await prisma.salesOrderLine.update({
        where: { id: l.id },
        data: { discPct, discAmt, vatPct, vatAmt, grandTotal: grand },
      })
    }
    await prisma.salesOrder.update({
      where: { id: o.id },
      data: { discountAmt: sumDisc, vatAmt: sumVat, grandTotal: sumGrand },
    })
  }
  console.log(`Backfilled ${dump.length} orders theo dòng hàng (CK ${''}+ VAT per-line)`)
}

main().finally(() => prisma.$disconnect())
