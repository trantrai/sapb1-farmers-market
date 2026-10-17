// ============================================================
// Smoke test Phase 2 Sales A/R (Worker A):
// - DocNumSequence 'downPayment'
// - ArDownPayment: docNum nullable (nháp), remainingAmount Decimal
// - DownPaymentDraw
// - buildSapDocPayload: DocType Service / ReserveInvoice / DownPaymentsToDraw
// - pushDocumentToSap: guard isDraft → 'none'
//
// Test thuần (payload/guard) luôn chạy. Test chạm DB chỉ chạy khi đặt
// FM_PHASE2_TEST_DB (tránh làm bẩn DB dev khi chạy `npx vitest` thường):
//   rm -f /tmp/fm-phase2-test.db
//   DATABASE_URL="file:/tmp/fm-phase2-test.db" npx prisma db push --accept-data-loss --skip-generate
//   FM_PHASE2_TEST_DB="file:/tmp/fm-phase2-test.db" npx vitest run src/lib/__tests__/sales-ar-phase2.test.ts
// ============================================================
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { db as prisma } from '@/lib/db'
import { nextDocNum } from '@/lib/doc-num'
import { buildSapDocPayload, pushDocumentToSap } from '@/lib/sap-push-document'
import { INVOICE_CFG, SalesDocError } from '@/lib/sales-ar'

// Chỉ chạy test DB khi có FM_PHASE2_TEST_DB trỏ tới DB tạm
const describeDb = process.env.FM_PHASE2_TEST_DB ? describe : describe.skip

const line = (over: Record<string, unknown> = {}) => ({
  itemCode: 'FM-RAU-001',
  itemName: 'Rau muống',
  quantity: 10,
  unitPrice: 20000,
  lineTotal: 200000,
  discPct: 0,
  discAmt: 0,
  vatPct: 8,
  vatAmt: 16000,
  grandTotal: 216000,
  ...over,
})

describeDb('DocNumSequence downPayment', () => {
  it('cấp số tăng dần từ 1', async () => {
    expect(await nextDocNum('downPayment')).toBe(1)
    expect(await nextDocNum('downPayment')).toBe(2)
  })
})

describeDb('ArDownPayment draft (docNum nullable)', () => {
  it('2 nháp cùng docNum=null không vi phạm unique', async () => {
    const base = {
      cardCode: 'C20001',
      cardName: 'Khách test',
      docDate: new Date(),
      docDueDate: new Date(),
      createdBy: 'test',
      isDraft: true,
      docNum: null,
      lines: { create: [{ lineNum: 1, ...line() }] },
    }
    const a = await prisma.arDownPayment.create({ data: base })
    const b = await prisma.arDownPayment.create({ data: { ...base } })
    expect(a.docNum).toBeNull()
    expect(b.docNum).toBeNull()
    expect(a.isDraft).toBe(true)
  })

  it('remainingAmount Decimal khởi tạo = grandTotal', async () => {
    const dp = await prisma.arDownPayment.create({
      data: {
        docNum: 9001,
        cardCode: 'C20001',
        cardName: 'Khách test',
        docDate: new Date(),
        docDueDate: new Date(),
        createdBy: 'test',
        grandTotal: 1100000,
        remainingAmount: new Prisma.Decimal(1100000),
        lines: { create: [{ lineNum: 1, ...line() }] },
      },
    })
    expect(Number(dp.remainingAmount)).toBe(1100000)
    // decrement nguyên tử
    const after = await prisma.arDownPayment.update({
      where: { id: dp.id },
      data: { remainingAmount: { decrement: new Prisma.Decimal(300000) } },
    })
    expect(Number(after.remainingAmount)).toBe(800000)
  })
})

describeDb('DownPaymentDraw', () => {
  it('ghi draw và liên kết 2 chiều', async () => {
    const dp = await prisma.arDownPayment.create({
      data: {
        docNum: 9002,
        cardCode: 'C20001',
        cardName: 'Khách test',
        docDate: new Date(),
        docDueDate: new Date(),
        createdBy: 'test',
        grandTotal: 550000,
        remainingAmount: new Prisma.Decimal(550000),
        lines: { create: [{ lineNum: 1, ...line() }] },
      },
    })
    const inv = await prisma.arInvoice.create({
      data: {
        docNum: 8001,
        cardCode: 'C20001',
        cardName: 'Khách test',
        docDate: new Date(),
        docDueDate: new Date(),
        createdBy: 'test',
        grandTotal: 2200000,
        lines: { create: [{ lineNum: 1, ...line() }] },
      },
    })
    const draw = await prisma.downPaymentDraw.create({
      data: { invoiceId: inv.id, downPaymentId: dp.id, drawAmount: new Prisma.Decimal(500000) },
    })
    expect(Number(draw.drawAmount)).toBe(500000)
    const withDraws = await prisma.arInvoice.findUnique({
      where: { id: inv.id },
      include: { draws: true },
    })
    expect(withDraws?.draws).toHaveLength(1)
  })

  it('validateDraws: chặn draw từ đặt cọc chưa synced lên SAP', async () => {
    const validate = INVOICE_CFG.hooks!.validateDraws!
    const dp = await prisma.arDownPayment.create({
      data: {
        docNum: 9101,
        cardCode: 'C20001',
        cardName: 'Khách test',
        docDate: new Date(),
        docDueDate: new Date(),
        createdBy: 'test',
        grandTotal: 1100000,
        remainingAmount: new Prisma.Decimal(1100000),
        lines: { create: [{ lineNum: 1, ...line() }] },
      },
    })
    // Chưa có sapDocEntry → phải lỗi 400
    await expect(
      validate(prisma as any, [{ downPaymentId: dp.id, drawAmount: 500000 }], 'C20001', 1100000),
    ).rejects.toThrowError(/chưa được đẩy lên SAP B1/)
    // Sau khi synced (có sapDocEntry) → validate qua
    await prisma.arDownPayment.update({ where: { id: dp.id }, data: { sapDocEntry: 555 } })
    const parsed = await validate(
      prisma as any,
      [{ downPaymentId: dp.id, drawAmount: 500000 }],
      'C20001',
      1100000,
    )
    expect(parsed).toHaveLength(1)
  })
})

describe('buildSapDocPayload (Phase 2)', () => {
  const baseInput = {
    cardCode: 'C20001',
    docDate: '2026-10-17',
    docDueDate: '2026-10-24',
    lines: [{ itemCode: 'FM-RAU-001', quantity: 10, unitPrice: 20000 }],
  }
  it('Item: không gửi DocType/ReserveInvoice', () => {
    const p = buildSapDocPayload({ ...baseInput, invoiceDocType: 'Item' }) as any
    expect(p.DocType).toBeUndefined()
    expect(p.ReserveInvoice).toBeUndefined()
  })
  it('Service: DocType=dDocument_Service', () => {
    const p = buildSapDocPayload({ ...baseInput, invoiceDocType: 'Service' }) as any
    expect(p.DocType).toBe('dDocument_Service')
  })
  it('Reserve: ReserveInvoice=tYES', () => {
    const p = buildSapDocPayload({ ...baseInput, invoiceDocType: 'Reserve' }) as any
    expect(p.ReserveInvoice).toBe('tYES')
  })
  it('draws → DownPaymentsToDraw (dptInvoice)', () => {
    const p = buildSapDocPayload({
      ...baseInput,
      draws: [{ downPaymentDocEntry: 42, drawAmount: 500000 }],
    }) as any
    expect(p.DownPaymentsToDraw).toEqual([
      { DocEntry: 42, AmountToDraw: 500000, DownPaymentType: 'dptInvoice' },
    ])
  })
})

describe('pushDocumentToSap guard isDraft', () => {
  it('isDraft=true → status none, không gọi SAP', async () => {
    const res = await pushDocumentToSap({
      entitySet: 'DownPayments',
      isDraft: true,
      cardCode: 'C20001',
      docDate: '2026-10-17',
      docDueDate: '2026-10-24',
      lines: [{ itemCode: 'FM-RAU-001', quantity: 1, unitPrice: 1000 }],
    })
    expect(res.status).toBe('none')
  })
})

describeDb('setup', () => {
  beforeAll(async () => {
    // dọn dữ liệu test cũ nếu chạy lại
    await prisma.downPaymentDraw.deleteMany({})
    await prisma.arDownPayment.deleteMany({ where: { cardCode: 'C20001', createdBy: 'test' } })
    await prisma.arInvoice.deleteMany({ where: { cardCode: 'C20001', createdBy: 'test' } })
    await prisma.docNumSequence.deleteMany({ where: { docType: 'downPayment' } })
  })
  it('placeholder', () => {
    expect(true).toBe(true)
  })
})

afterAll(async () => {
  await prisma.$disconnect()
})
