// Migrate dữ liệu: cập nhật isDraft NULL → false cho chứng từ cũ (tạo trước Phase 2)
// Chạy: node scripts/migrate-isdraft.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const TABLES = [
  'SalesOrder',
  'Delivery',
  'Quotation',
  'ArInvoice',
  'ArCreditMemo',
  'SalesReturn',
  'ArDownPayment',
];

async function main() {
  for (const t of TABLES) {
    try {
      const r = await prisma.$executeRawUnsafe(`UPDATE "${t}" SET "isDraft" = 0 WHERE "isDraft" IS NULL`);
      console.log(`${t}: đã cập nhật ${r} dòng NULL → false`);
    } catch (e) {
      console.log(`${t}: bỏ qua (${e.message.substring(0, 60)})`);
    }
  }
  // Cũng fix sapDatabaseId NULL → giữ nguyên (code đã xử lý), chỉ log số lượng
  for (const t of TABLES) {
    try {
      const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as c FROM "${t}" WHERE "sapDatabaseId" IS NULL`);
      console.log(`${t}: ${rows[0].c} dòng có sapDatabaseId NULL (code đã xử lý, không cần migrate)`);
    } catch {}
  }
  await prisma.$disconnect();
  console.log('Xong.');
}

main().catch(e => { console.error(e); process.exit(1); });
