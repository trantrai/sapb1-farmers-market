import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/lib/fm-crypto'
import { generateStrongPassword } from '../src/lib/password-policy'

const prisma = new PrismaClient()

function d(daysAgo: number) {
  const dt = new Date()
  dt.setDate(dt.getDate() - daysAgo)
  return dt
}
function dPlus(daysAgo: number, plus: number) {
  const dt = d(daysAgo)
  dt.setDate(dt.getDate() + plus)
  return dt
}

async function main() {
  console.log('🌱 Seeding Farmers Market — SAP B1 SO System...')
  console.warn('⚠️  Seed sẽ XÓA TOÀN BỘ dữ liệu hiện có (đơn hàng, KH, mặt hàng, user, settings) — chỉ chạy ở môi trường dev/demo!')

  await prisma.salesOrderLine.deleteMany()
  await prisma.salesOrder.deleteMany()
  // Phase 1 Sales A/R: xóa chứng từ mới (dòng trước, header sau) + dãy số
  await prisma.quotationLine.deleteMany()
  await prisma.quotation.deleteMany()
  await prisma.arInvoiceLine.deleteMany()
  await prisma.arInvoice.deleteMany()
  await prisma.arCreditMemoLine.deleteMany()
  await prisma.arCreditMemo.deleteMany()
  await prisma.salesReturnLine.deleteMany()
  await prisma.salesReturn.deleteMany()
  await prisma.docNumSequence.deleteMany()
  await prisma.businessPartner.deleteMany()
  await prisma.item.deleteMany()
  await prisma.user.deleteMany()
  await prisma.role.deleteMany()
  await prisma.appSettings.deleteMany()

  // ---------- Users ----------
  // Mật khẩu NGẪU NHIÊN MẠNH, sinh mới mỗi lần seed — in ra console 1 lần
  // (không ghi vào file/log nào khác). Lần đăng nhập đầu bắt buộc đổi mật khẩu.
  const seedPasswords = ['admin', 'ketoan', 'nhanvien', 'kiemke'].map(() => generateStrongPassword())
  const [pwAdmin, pwKeToan, pwNhanVien, pwKiemKe] = await Promise.all(
    seedPasswords.map(hashPassword),
  )
  await prisma.user.createMany({
    data: [
      { username: 'admin', password: pwAdmin, fullName: 'Nguyễn Văn Quản', role: 'Admin', mustChangePassword: true },
      { username: 'ketoan', password: pwKeToan, fullName: 'Trần Thị Kế', role: 'KeToan', mustChangePassword: true },
      { username: 'nhanvien', password: pwNhanVien, fullName: 'Lê Văn Bán', role: 'NhanVien', mustChangePassword: true },
      { username: 'kiemke', password: pwKiemKe, fullName: 'Phạm Thị Kiểm', role: 'NhanVien', mustChangePassword: true },
    ],
  })
  console.log('=== SEED CREDENTIALS ===')
  console.log('admin    / ' + seedPasswords[0])
  console.log('ketoan   / ' + seedPasswords[1])
  console.log('nhanvien / ' + seedPasswords[2])
  console.log('kiemke   / ' + seedPasswords[3])
  console.log('=== (lưu lại ngay — lần đăng nhập đầu bắt buộc đổi mật khẩu) ===')

  // ---------- Roles (RBAC) ----------
  const fullPerm = JSON.stringify({
    orders: { view: true, create: true, edit: true, delete: true },
    ordersNew: { view: true, create: true, edit: true, delete: true },
    deliveries: { view: true, create: true, edit: true, delete: true },
    quotations: { view: true, create: true, edit: true, delete: true },
    invoices: { view: true, create: true, edit: true, delete: true },
    creditMemos: { view: true, create: true, edit: true, delete: true },
    returns: { view: true, create: true, edit: true, delete: true },
    downPayments: { view: true, create: true, edit: true, delete: true },
    salesReport: { view: true, create: false, edit: false, delete: false },
    arAgingReport: { view: true, create: false, edit: false, delete: false },
    users: { view: true, create: true, edit: true, delete: true },
    settings: { view: true, create: true, edit: true, delete: true },
    roles: { view: true, create: true, edit: true, delete: true },
    excelTemplates: { view: true, create: true, edit: true, delete: true },
    orderTemplates: { view: true, create: true, edit: true, delete: true },
    bomImport: { view: true, create: true, edit: true, delete: true },
    // Hoán đổi thành phần BOM Template (đưa mặt hàng ngoài công thức vào với giá 0)
    bomSwap: { view: true, create: false, edit: true, delete: false },
  })
  const accPerm = JSON.stringify({
    orders: { view: true, create: true, edit: true, delete: false },
    ordersNew: { view: true, create: true, edit: true, delete: false },
    deliveries: { view: true, create: true, edit: true, delete: false },
    quotations: { view: true, create: true, edit: true, delete: false },
    invoices: { view: true, create: true, edit: true, delete: false },
    creditMemos: { view: true, create: true, edit: true, delete: false },
    returns: { view: true, create: true, edit: true, delete: false },
    downPayments: { view: true, create: true, edit: true, delete: false },
    salesReport: { view: true, create: false, edit: false, delete: false },
    arAgingReport: { view: true, create: false, edit: false, delete: false },
    users: { view: false, create: false, edit: false, delete: false },
    settings: { view: true, create: false, edit: false, delete: false },
    roles: { view: false, create: false, edit: false, delete: false },
    excelTemplates: { view: true, create: true, edit: true, delete: false },
    orderTemplates: { view: true, create: true, edit: false, delete: false },
    bomImport: { view: true, create: true, edit: false, delete: false },
    // Hoán đổi thành phần BOM Template (đưa mặt hàng ngoài công thức vào với giá 0)
    bomSwap: { view: false, create: false, edit: false, delete: false },
  })
  const staffPerm = JSON.stringify({
    orders: { view: true, create: true, edit: false, delete: false },
    ordersNew: { view: true, create: true, edit: false, delete: false },
    deliveries: { view: true, create: false, edit: false, delete: false },
    quotations: { view: true, create: true, edit: false, delete: false },
    invoices: { view: true, create: false, edit: false, delete: false },
    creditMemos: { view: true, create: false, edit: false, delete: false },
    returns: { view: true, create: false, edit: false, delete: false },
    downPayments: { view: true, create: false, edit: false, delete: false },
    salesReport: { view: true, create: false, edit: false, delete: false },
    arAgingReport: { view: true, create: false, edit: false, delete: false },
    users: { view: false, create: false, edit: false, delete: false },
    settings: { view: false, create: false, edit: false, delete: false },
    roles: { view: false, create: false, edit: false, delete: false },
    excelTemplates: { view: true, create: false, edit: false, delete: false },
    orderTemplates: { view: true, create: false, edit: false, delete: false },
    bomImport: { view: true, create: false, edit: false, delete: false },
    // Hoán đổi thành phần BOM Template (đưa mặt hàng ngoài công thức vào với giá 0)
    bomSwap: { view: false, create: false, edit: false, delete: false },
  })
  await prisma.role.createMany({
    data: [
      { name: 'Admin', label: 'Quản trị viên', permissions: fullPerm, builtin: true },
      { name: 'KeToan', label: 'Kế toán', permissions: accPerm, builtin: true },
      { name: 'NhanVien', label: 'Nhân viên bán hàng', permissions: staffPerm, builtin: true },
    ],
  })

  // ---------- Business Partners ----------
  await prisma.businessPartner.createMany({
    data: [
      { cardCode: 'C20001', cardName: 'Cửa hàng Rau Sạch Đà Lạt', address: '12 Nguyễn Trãi, Q.1, TP.HCM', phone: '0903123456' },
      { cardCode: 'C20002', cardName: 'HTX Nông Sản Cửu Long', address: '45 Hòa Bình, Q.7, TP.HCM', phone: '0913888777' },
      { cardCode: 'C20003', cardName: 'Nhà hàng Cánh Đồng Xanh', address: '78 Láng Hạ, Hà Nội', phone: '0243999111' },
      { cardCode: 'C20004', cardName: 'Siêu thị Organic Mart', address: '230 Võ Văn Tần, Q.3, TP.HCM', phone: '02838452233' },
      { cardCode: 'C20005', cardName: 'Cơ sở Trứng Gà Ta Hùng', address: '9 Xuân Thủy, Q.2, TP.HCM', phone: '0909777666' },
      { cardCode: 'C20006', cardName: 'Quầy Gạo ST25 Ông Ba', address: 'Chợ Bình Tây, Q.6, TP.HCM', phone: '0918234567' },
      { cardCode: 'C20007', cardName: 'Café Mật Ong Highland', address: '56 Trần Phú, Đà Lạt', phone: '02633822448' },
      { cardCode: 'C20008', cardName: 'Bếp Ăn Lành StrongFit', address: '189 Cách Mạng Tháng 8, Q.10, TP.HCM', phone: '0934555221' },
      { cardCode: 'C20009', cardName: 'Trường Mầm non Hạt Mầm', address: '34 Đường số 7, Bình Thạnh, TP.HCM', phone: '02835123456' },
      { cardCode: 'C20010', cardName: 'Khách sạn Farm Village', address: '88 Thảo Điền, TP. Thủ Đức', phone: '0906888999' },
    ],
  })

  // ---------- Items ----------
  await prisma.item.createMany({
    data: [
      { itemCode: 'FM-RAU-001', itemName: 'Rau cải ngọt hữu cơ', uom: 'kg', price: 28000, stock: 320, category: 'Rau củ' },
      { itemCode: 'FM-RAU-002', itemName: 'Cà chua bi Đà Lạt', uom: 'kg', price: 45000, stock: 180, category: 'Rau củ' },
      { itemCode: 'FM-RAU-003', itemName: 'Cà rốt vàng organic', uom: 'kg', price: 32000, stock: 210, category: 'Rau củ' },
      { itemCode: 'FM-RAU-004', itemName: 'Xà lách dầu xoai', uom: 'kg', price: 25000, stock: 150, category: 'Rau củ' },
      { itemCode: 'FM-TRA-001', itemName: 'Trứng gà ta lò', uom: 'hộp (10)', price: 58000, stock: 420, category: 'Trứng & Sữa' },
      { itemCode: 'FM-TRA-002', itemName: 'Sữa tươi nguyên kem', uom: 'lít', price: 39000, stock: 260, category: 'Trứng & Sữa' },
      { itemCode: 'FM-GAO-001', itemName: 'Gạo ST25 Ruộng Vàng', uom: 'bao 5kg', price: 185000, stock: 95, category: 'Ngũ cốc' },
      { itemCode: 'FM-GAO-002', itemName: 'Gạo lứt đỏ hạt ngắn', uom: 'bao 5kg', price: 145000, stock: 60, category: 'Ngũ cốc' },
      { itemCode: 'FM-MAT-001', itemName: 'Mật ong rừng nguyên chất', uom: 'hũ 500g', price: 220000, stock: 88, category: 'Đặc sản' },
      { itemCode: 'FM-MAT-002', itemName: 'Mứt dâu tằm Đà Lạt', uom: 'hũ 300g', price: 95000, stock: 130, category: 'Đặc sản' },
      { itemCode: 'FM-QUA-001', itemName: 'Dâu tây Đà Lạt type 1', uom: 'kg', price: 120000, stock: 74, category: 'Trái cây' },
      { itemCode: 'FM-QUA-002', itemName: 'Cam sành Vinh loại A', uom: 'kg', price: 35000, stock: 400, category: 'Trái cây' },
    ],
  })

  // ---------- Sale Orders ----------
  type SeedLine = { item: string; qty: number; price: number; disc?: number; vat?: number }
  const orders: Array<{
    cardCode: string; cardName: string; daysAgo: number; due: number
    status: 'Open' | 'Closed'; remarks?: string; disc?: number; vat?: number; lines: SeedLine[]
  }> = [
    { cardCode: 'C20001', cardName: 'Cửa hàng Rau Sạch Đà Lạt', daysAgo: 1, due: 4, status: 'Open', remarks: 'Giao buổi sáng trước 7h', disc: 0, vat: 8, lines: [{ item: 'FM-RAU-001', qty: 25, price: 28000 }, { item: 'FM-RAU-002', qty: 12, price: 45000 }, { item: 'FM-RAU-004', qty: 10, price: 25000 }] },
    { cardCode: 'C20004', cardName: 'Siêu thị Organic Mart', daysAgo: 2, due: 5, status: 'Open', disc: 3, vat: 8, lines: [{ item: 'FM-QUA-001', qty: 18, price: 120000 }, { item: 'FM-MAT-002', qty: 20, price: 95000 }, { item: 'FM-TRA-001', qty: 30, price: 58000 }] },
    { cardCode: 'C20008', cardName: 'Bếp Ăn Lành StrongFit', daysAgo: 3, due: 6, status: 'Open', remarks: 'Hóa đơn VAT công ty', disc: 0, vat: 8, lines: [{ item: 'FM-GAO-001', qty: 8, price: 185000 }, { item: 'FM-TRA-002', qty: 24, price: 39000 }] },
    { cardCode: 'C20003', cardName: 'Nhà hàng Cánh Đồng Xanh', daysAgo: 4, due: 2, status: 'Open', remarks: 'Khách yêu cầu giao lại sau Tết', disc: 5, vat: 8, lines: [{ item: 'FM-RAU-003', qty: 40, price: 32000 }, { item: 'FM-QUA-002', qty: 60, price: 35000 }, { item: 'FM-RAU-001', qty: 30, price: 28000 }, { item: 'FM-GAO-002', qty: 10, price: 145000 }] },
    { cardCode: 'C20010', cardName: 'Khách sạn Farm Village', daysAgo: 5, due: 8, status: 'Closed', disc: 0, vat: 8, lines: [{ item: 'FM-MAT-001', qty: 15, price: 220000 }, { item: 'FM-TRA-001', qty: 25, price: 58000 }] },
    { cardCode: 'C20002', cardName: 'HTX Nông Sản Cửu Long', daysAgo: 6, due: 2, status: 'Open', remarks: 'Chưa xác nhận lịch giao', disc: 2, vat: 8, lines: [{ item: 'FM-QUA-002', qty: 120, price: 35000 }, { item: 'FM-GAO-001', qty: 20, price: 185000 }] },
    { cardCode: 'C20007', cardName: 'Café Mật Ong Highland', daysAgo: 8, due: 7, status: 'Closed', remarks: 'Đã thanh toán chuyển khoản', disc: 0, vat: 8, lines: [{ item: 'FM-MAT-001', qty: 10, price: 220000 }, { item: 'FM-MAT-002', qty: 15, price: 95000 }] },
    { cardCode: 'C20005', cardName: 'Cơ sở Trứng Gà Ta Hùng', daysAgo: 9, due: 6, status: 'Closed', disc: 0, vat: 8, lines: [{ item: 'FM-TRA-001', qty: 50, price: 58000 }] },
    { cardCode: 'C20009', cardName: 'Trường Mầm non Hạt Mầm', daysAgo: 10, due: 5, status: 'Closed', remarks: 'Suất ăn trưa bán trú', disc: 4, vat: 8, lines: [{ item: 'FM-TRA-002', qty: 40, price: 39000 }, { item: 'FM-QUA-002', qty: 45, price: 35000 }, { item: 'FM-RAU-001', qty: 20, price: 28000 }] },
    { cardCode: 'C20006', cardName: 'Quầy Gạo ST25 Ông Ba', daysAgo: 12, due: 3, status: 'Closed', disc: 0, vat: 8, lines: [{ item: 'FM-GAO-001', qty: 30, price: 185000 }, { item: 'FM-GAO-002', qty: 15, price: 145000 }] },
    { cardCode: 'C20001', cardName: 'Cửa hàng Rau Sạch Đà Lạt', daysAgo: 14, due: 4, status: 'Closed', disc: 0, vat: 8, lines: [{ item: 'FM-RAU-002', qty: 22, price: 45000 }, { item: 'FM-RAU-003', qty: 15, price: 32000 }] },
    { cardCode: 'C20008', cardName: 'Bếp Ăn Lành StrongFit', daysAgo: 16, due: 2, status: 'Closed', disc: 0, vat: 8, lines: [{ item: 'FM-RAU-004', qty: 18, price: 25000 }, { item: 'FM-TRA-002', qty: 20, price: 39000 }] },
    { cardCode: 'C20004', cardName: 'Siêu thị Organic Mart', daysAgo: 18, due: 1, status: 'Closed', disc: 3, vat: 8, lines: [{ item: 'FM-QUA-001', qty: 25, price: 120000 }, { item: 'FM-RAU-001', qty: 35, price: 28000 }] },
    { cardCode: 'C20010', cardName: 'Khách sạn Farm Village', daysAgo: 20, due: 0, status: 'Closed', disc: 5, vat: 8, lines: [{ item: 'FM-MAT-001', qty: 20, price: 220000 }, { item: 'FM-QUA-001', qty: 10, price: 120000 }, { item: 'FM-GAO-002', qty: 12, price: 145000 }] },
  ]

  const items = await prisma.item.findMany()
  const itemMap = new Map(items.map((i) => [i.itemCode, i]))

  let docNum = 1001
  for (const o of orders) {
    const lineData = o.lines.map((l, idx) => {
      const it = itemMap.get(l.item)!
      const lineTotal = l.qty * l.price
      const discPct = l.disc ?? o.disc ?? 0
      const vatPct = l.vat ?? o.vat ?? 8
      const discAmt = Math.round((lineTotal * discPct) / 100)
      const afterDisc = lineTotal - discAmt
      const vatAmt = Math.round((afterDisc * vatPct) / 100)
      return {
        lineNum: idx + 1,
        itemCode: it.itemCode,
        itemName: it.itemName,
        uom: it.uom,
        quantity: l.qty,
        unitPrice: l.price,
        lineTotal,
        discPct,
        discAmt,
        vatPct,
        vatAmt,
        grandTotal: afterDisc + vatAmt,
      }
    })
    const totalBeforeDisc = lineData.reduce((s, l) => s + l.lineTotal, 0)
    const discountAmt = lineData.reduce((s, l) => s + l.discAmt, 0)
    const vatAmt = lineData.reduce((s, l) => s + l.vatAmt, 0)
    const grandTotal = lineData.reduce((s, l) => s + l.grandTotal, 0)

    const created = await prisma.salesOrder.create({
      data: {
        docNum: docNum++,
        cardCode: o.cardCode,
        cardName: o.cardName,
        docDate: d(o.daysAgo),
        docDueDate: dPlus(o.daysAgo, o.due),
        status: o.status,
        remarks: o.remarks,
        totalBeforeDisc,
        discountAmt,
        vatAmt,
        grandTotal,
        createdBy: 'admin',
        lines: { create: lineData },
      },
    })
    console.log(`   ✓ SO #${created.docNum} — ${created.cardName}`)
  }

  // ---------- Phase 1 Sales A/R: Báo giá / Hóa đơn / Ghi có / Trả hàng ----------
  // Dãy đánh số RIÊNG theo loại (chuẩn SAP B1): QT 3001…, IV 4001…, CM 5001…, RT 6001…
  type ArSeedDoc = {
    cardCode: string; cardName: string; daysAgo: number; due: number
    status: 'Open' | 'Closed'; remarks?: string; lines: SeedLine[]
  }
  const seedArDocs = async (
    delegate: 'quotation' | 'arInvoice' | 'arCreditMemo' | 'salesReturn',
    lineDelegate: 'quotationLine' | 'arInvoiceLine' | 'arCreditMemoLine' | 'salesReturnLine',
    fk: 'quotationId' | 'invoiceId' | 'creditMemoId' | 'returnId',
    startNum: number,
    docs: (ArSeedDoc & { source?: Record<string, string> })[],
  ): Promise<{ num: number; ids: string[] }> => {
    const ids: string[] = []
    let num = startNum
    for (const o of docs) {
      const lineData = o.lines.map((l, idx) => {
        const it = itemMap.get(l.item)!
        const lineTotal = l.qty * l.price
        const discPct = l.disc ?? 0
        const vatPct = l.vat ?? 8
        const discAmt = Math.round((lineTotal * discPct) / 100)
        const afterDisc = lineTotal - discAmt
        const vatAmt = Math.round((afterDisc * vatPct) / 100)
        return {
          [fk]: '', // gắn sau khi có id header — ghi đè bên dưới
          lineNum: idx + 1,
          itemCode: it.itemCode,
          itemName: it.itemName,
          uom: it.uom,
          quantity: l.qty,
          unitPrice: l.price,
          lineTotal,
          discPct,
          discAmt,
          vatPct,
          vatAmt,
          grandTotal: afterDisc + vatAmt,
        }
      })
      const totalBeforeDisc = lineData.reduce((s, l) => s + l.lineTotal, 0)
      const discountAmt = lineData.reduce((s, l) => s + l.discAmt, 0)
      const vatAmt = lineData.reduce((s, l) => s + l.vatAmt, 0)
      const grandTotal = lineData.reduce((s, l) => s + l.grandTotal, 0)
      // Tạo header trước rồi gắn FK cho lines (tránh phụ thuộc thứ tự)
      const header: any = await (prisma as any)[delegate].create({
        data: {
          docNum: num++,
          cardCode: o.cardCode,
          cardName: o.cardName,
          docDate: d(o.daysAgo),
          docDueDate: dPlus(o.daysAgo, o.due),
          status: o.status,
          remarks: o.remarks,
          totalBeforeDisc,
          discountAmt,
          headerDiscPct: 0,
          headerDiscAmt: 0,
          vatAmt,
          grandTotal,
          createdBy: 'admin',
          ...(o.source ?? {}),
        },
      })
      await (prisma as any)[lineDelegate].createMany({
        data: lineData.map((l) => ({ ...l, [fk]: header.id })),
      })
      ids.push(header.id)
      console.log(`   ✓ ${delegate} #${header.docNum} — ${header.cardName}`)
    }
    return { num: num - 1, ids }
  }

  const qt = await seedArDocs('quotation', 'quotationLine', 'quotationId', 3001, [
    { cardCode: 'C20004', cardName: 'Siêu thị Organic Mart', daysAgo: 1, due: 15, status: 'Open', remarks: 'Báo giá combo rau củ Q4', lines: [{ item: 'FM-RAU-001', qty: 50, price: 28000 }, { item: 'FM-RAU-002', qty: 30, price: 45000, disc: 3 }] },
    { cardCode: 'C20001', cardName: 'Cửa hàng Rau Sạch Đà Lạt', daysAgo: 3, due: 15, status: 'Open', lines: [{ item: 'FM-QUA-001', qty: 20, price: 120000 }, { item: 'FM-MAT-002', qty: 25, price: 95000 }] },
    { cardCode: 'C20010', cardName: 'Khách sạn Farm Village', daysAgo: 20, due: 15, status: 'Closed', remarks: 'Đã chuyển thành đơn hàng', lines: [{ item: 'FM-MAT-001', qty: 12, price: 220000 }] },
  ])
  const iv = await seedArDocs('arInvoice', 'arInvoiceLine', 'invoiceId', 4001, [
    { cardCode: 'C20004', cardName: 'Siêu thị Organic Mart', daysAgo: 1, due: 30, status: 'Open', remarks: 'Hóa đơn VAT điện tử', source: { sourceQuotationId: qt.ids[0] }, lines: [{ item: 'FM-RAU-001', qty: 50, price: 28000 }, { item: 'FM-RAU-002', qty: 30, price: 45000, disc: 3 }] },
    { cardCode: 'C20008', cardName: 'Bếp Ăn Lành StrongFit', daysAgo: 4, due: 30, status: 'Open', lines: [{ item: 'FM-GAO-001', qty: 10, price: 185000 }, { item: 'FM-TRA-002', qty: 30, price: 39000 }] },
    { cardCode: 'C20003', cardName: 'Nhà hàng Cánh Đồng Xanh', daysAgo: 25, due: 30, status: 'Closed', lines: [{ item: 'FM-QUA-002', qty: 80, price: 35000 }] },
  ])
  const cm = await seedArDocs('arCreditMemo', 'arCreditMemoLine', 'creditMemoId', 5001, [
    { cardCode: 'C20004', cardName: 'Siêu thị Organic Mart', daysAgo: 2, due: 30, status: 'Open', remarks: 'Giảm giá hàng lỗi nhẹ', source: { sourceInvoiceId: iv.ids[0] }, lines: [{ item: 'FM-RAU-002', qty: 5, price: 45000, disc: 3 }] },
    { cardCode: 'C20001', cardName: 'Cửa hàng Rau Sạch Đà Lạt', daysAgo: 9, due: 30, status: 'Closed', remarks: 'Chiết khấu thanh toán sớm', lines: [{ item: 'FM-RAU-001', qty: 10, price: 28000 }] },
  ])
  const rt = await seedArDocs('salesReturn', 'salesReturnLine', 'returnId', 6001, [
    { cardCode: 'C20001', cardName: 'Cửa hàng Rau Sạch Đà Lạt', daysAgo: 2, due: 0, status: 'Open', remarks: 'Trả hàng dập nát', lines: [{ item: 'FM-RAU-004', qty: 8, price: 25000 }] },
    { cardCode: 'C20004', cardName: 'Siêu thị Organic Mart', daysAgo: 12, due: 0, status: 'Closed', remarks: 'Trả hàng cận date', lines: [{ item: 'FM-TRA-001', qty: 10, price: 58000 }] },
  ])
  // Đồng bộ dãy DocNumSequence để nextDocNum() cấp số tiếp theo sau seed
  await prisma.docNumSequence.createMany({
    data: [
      { docType: 'quotation', lastNum: qt.num },
      { docType: 'invoice', lastNum: iv.num },
      { docType: 'creditMemo', lastNum: cm.num },
      { docType: 'return', lastNum: rt.num },
    ],
  })

  // ---------- Settings ----------
  // Cấu hình Service Layer MẪU — điền thông tin thật ở trang Cài đặt của app
  // (không commit thông tin kết nối/mật khẩu SAP thật vào repo).
  await prisma.appSettings.create({
    data: {
      id: 'main',
      serviceLayerUrl: 'https://sap-b1-host:50000/b1s/v1',
      companyDb: 'TESTDB',
      sapUser: 'manager',
      sapPassword: await hashPassword('doi-mat-khau-sap-o-day'),
      connected: false,
      lastSyncAt: null,
    },
  })

  const counts = {
    users: await prisma.user.count(),
    roles: await prisma.role.count(),
    partners: await prisma.businessPartner.count(),
    items: await prisma.item.count(),
    orders: await prisma.salesOrder.count(),
    quotations: await prisma.quotation.count(),
    invoices: await prisma.arInvoice.count(),
    creditMemos: await prisma.arCreditMemo.count(),
    returns: await prisma.salesReturn.count(),
  }
  console.log('✅ Seed done:', JSON.stringify(counts))
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
