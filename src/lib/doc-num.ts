// ============================================================
// DÃY ĐÁNH SỐ CHỨNG TỪ RIÊNG THEO LOẠI (Phase 1 Sales A/R)
// Mỗi loại chứng từ (báo giá / hóa đơn / phiếu ghi có / phiếu trả
// hàng / hóa đơn đặt cọc) có dãy số riêng — tương đương Numbering Series của SAP B1,
// không dùng chung dãy docNum với Đơn hàng/Phiếu giao hàng.
// Cấp số bằng upsert + increment trong 1 transaction → 2 request
// tạo chứng từ đồng thời không thể nhận cùng số.
// ============================================================
import { db as prisma } from '@/lib/db'

export type SalesDocType = 'quotation' | 'invoice' | 'creditMemo' | 'return' | 'downPayment'

export const DOC_TYPE_LABEL: Record<SalesDocType, string> = {
  quotation: 'báo giá bán hàng',
  invoice: 'hóa đơn bán hàng',
  creditMemo: 'phiếu ghi có phải thu',
  return: 'phiếu trả hàng bán',
  downPayment: 'hóa đơn đặt cọc phải thu',
}

/**
 * Cấp số chứng từ tiếp theo của dãy `docType`.
 * Dãy chưa tồn tại → tạo mới bắt đầu từ 1.
 */
export async function nextDocNum(docType: SalesDocType): Promise<number> {
  const seq = await prisma.$transaction(async (tx) => {
    return tx.docNumSequence.upsert({
      where: { docType },
      update: { lastNum: { increment: 1 } },
      create: { docType, lastNum: 1 },
    })
  })
  return seq.lastNum
}
