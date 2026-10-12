// ============================================================
// TÍNH TOÁN DÒNG HÀNG SALE ORDER (RDR1) — dùng chung cho
// POST /api/orders (tạo mới) và PUT /api/orders/[id] (sửa đơn)
// Công thức SAP B1: LineTotal → Discount% dòng → Chiết khấu ĐẦU
// CHỨNG TỪ (Documents.DiscountPercent, phân bổ về từng dòng) → Vat%
// ============================================================

export interface OrderLineInput {
  itemCode: string
  itemName: string
  uom: string
  quantity: number
  unitPrice: number
  discPct?: number
  vatPct?: number
  taxCode?: string
  warehouseCode?: string
}

export interface CalcLine extends OrderLineInput {
  quantity: number
  unitPrice: number
  lineTotal: number
  discPct: number
  discAmt: number
  /** Phần chiết khấu ĐẦU CHỨNG TỪ được phân bổ cho dòng này (₫) */
  headerDiscAmt: number
  vatPct: number
  vatAmt: number
  grandTotal: number
}

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * Tính toán totals từng dòng (SAP B1 RDR1):
 *   LineTotal → Discount% dòng → CK đầu chứng từ (phân bổ) → Vat%
 * CK đầu chứng từ (headerDiscPct — SAP: Documents.DiscountPercent) áp dụng
 * trên tổng tiền SAU chiết khấu dòng, TRƯỚC thuế; được phân bổ về từng dòng
 * theo tỷ lệ phần saukhối dòng (làm tròn xuống từng dòng, phần dư cộng cho
 * dòng có số tiền lớn nhất) để tổng tiền cấp đơn luôn khớp từng đồng, và
 * thuế VAT từng dòng được tính trên (sau CK dòng − phần CK đầu được phân bổ).
 * headerDiscPct = 0 → kết quả giống hệt công thức cũ (tương thích ngược).
 */
export function calcOrderLines(lines: OrderLineInput[], headerDiscPct = 0): CalcLine[] {
  const pct = clamp(Number(headerDiscPct) || 0, 0, 100)

  // Bước 1-2: LineTotal → CK dòng → số tiền sau CK dòng (chưa gồm CK đầu)
  const base = lines.map((l) => {
    const quantity = Number(l.quantity)
    const unitPrice = Number(l.unitPrice)
    const lineTotal = quantity * unitPrice
    const discPct = clamp(Number(l.discPct) || 0, 0, 100)
    const discAmt = Math.round((lineTotal * discPct) / 100)
    const afterDisc = lineTotal - discAmt
    return { ...l, quantity, unitPrice, lineTotal, discPct, discAmt, afterDisc, vatPct: clamp(Number(l.vatPct ?? 8) || 0, 0, 100) }
  })

  // Bước 3: CK đầu chứng từ — phân bổ theo tỷ lệ sau-KH-dòng
  const baseSum = base.reduce((s, l) => s + l.afterDisc, 0)
  const headerTotal = pct > 0 && baseSum > 0 ? Math.round((baseSum * pct) / 100) : 0
  let allocated = 0
  const withHeader = base.map((l) => {
    const share = headerTotal > 0 && baseSum > 0 ? Math.floor((l.afterDisc * headerTotal) / baseSum) : 0
    allocated += share
    return { ...l, headerDiscAmt: share }
  })
  if (headerTotal > 0 && withHeader.length > 0) {
    const residual = headerTotal - allocated // 0 ≤ residual < số dòng
    const maxIdx = withHeader.reduce((mi, l, i, arr) => (l.afterDisc > arr[mi].afterDisc ? i : mi), 0)
    withHeader[maxIdx].headerDiscAmt += residual
  }

  // Bước 4: thuế VAT trên (sau CK dòng − phần CK đầu phân bổ)
  return withHeader.map((l) => {
    const vatBase = l.afterDisc - l.headerDiscAmt
    const vatAmt = Math.round((vatBase * l.vatPct) / 100)
    const grandTotal = vatBase + vatAmt
    const { afterDisc: _after, ...rest } = l
    return { ...rest, vatAmt, grandTotal }
  })
}

/** Tổng cộng toàn đơn từ các dòng đã tính */
export function orderTotals(calcLines: CalcLine[]) {
  const totalBeforeDisc = calcLines.reduce((s, l) => s + l.lineTotal, 0)
  const discountAmt = calcLines.reduce((s, l) => s + l.discAmt, 0)
  const headerDiscAmt = calcLines.reduce((s, l) => s + l.headerDiscAmt, 0)
  return {
    totalBeforeDisc,
    discountAmt,
    headerDiscAmt,
    /** Sau chiết khấu (sau CK dòng − CK đầu chứng từ), trước thuế */
    afterDisc: totalBeforeDisc - discountAmt - headerDiscAmt,
    vatAmt: calcLines.reduce((s, l) => s + l.vatAmt, 0),
    grandTotal: calcLines.reduce((s, l) => s + l.grandTotal, 0),
  }
}
