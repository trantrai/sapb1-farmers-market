// ============================================================
// GIỎ HÀNG QUEN CỦA KHÁCH — gom lịch sử đơn hàng theo mặt hàng để form
// tạo đơn hiện lưới "nhập SL nhiều mặt hàng → thêm 1 lượt".
// Chỉ tính dòng cha/hàng thường (dòng con BOM bung lại theo công thức hiện hành).
// ============================================================

export interface BasketSourceOrder {
  docDate: Date | string
  lines: {
    itemCode: string
    itemName: string
    quantity: number
    unitPrice: number
    uom?: string | null
    taxCode?: string | null
    warehouseCode?: string | null
    isBomChild?: boolean | null
  }[]
}

export interface BasketAgg {
  itemCode: string
  itemName: string
  /** Số đơn có mặt hàng này */
  orderCount: number
  totalQty: number
  /** SL trung bình mỗi đơn có mặt hàng (làm tròn 3 số lẻ) */
  avgQty: number
  /** SL của đơn gần nhất có mặt hàng (cộng các dòng trùng trong đơn đó) */
  lastQty: number
  lastPrice: number
  lastDate: string
  uom?: string
  taxCode?: string
  warehouseCode?: string
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** orders phải sắp docDate GIẢM DẦN (đơn gần nhất trước) */
export function aggregateBasket(orders: BasketSourceOrder[], maxItems: number): BasketAgg[] {
  const map = new Map<string, BasketAgg>()
  for (const o of orders) {
    const date = new Date(o.docDate).toISOString()
    const qtyInOrder = new Map<string, number>()
    for (const l of o.lines) {
      if (l.isBomChild || !l.itemCode || !(l.quantity > 0)) continue
      let agg = map.get(l.itemCode)
      if (!agg) {
        agg = {
          itemCode: l.itemCode,
          itemName: l.itemName,
          orderCount: 0,
          totalQty: 0,
          avgQty: 0,
          lastQty: 0,
          lastPrice: l.unitPrice,
          lastDate: date,
          uom: l.uom ?? undefined,
          taxCode: l.taxCode ?? undefined,
          warehouseCode: l.warehouseCode ?? undefined,
        }
        map.set(l.itemCode, agg)
      }
      agg.totalQty += l.quantity
      qtyInOrder.set(l.itemCode, (qtyInOrder.get(l.itemCode) ?? 0) + l.quantity)
    }
    for (const [code, q] of qtyInOrder) {
      const agg = map.get(code)!
      agg.orderCount += 1
      // Lần gặp đầu tiên (orderCount = 1) là đơn gần nhất
      if (agg.orderCount === 1) agg.lastQty = round3(q)
    }
  }
  return [...map.values()]
    .map((a) => ({ ...a, totalQty: round3(a.totalQty), avgQty: round3(a.totalQty / a.orderCount) }))
    .sort((a, b) => b.orderCount - a.orderCount || b.totalQty - a.totalQty || a.itemCode.localeCompare(b.itemCode))
    .slice(0, maxItems)
}
