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
 * Validate dòng hàng trước khi tính toán/lưu.
 * - Dòng thiếu itemCode hoặc quantity <= 0: LỌC LẶNG (dòng nháp — frontend
 *   cũng tự lọc; giữ nguyên hành vi cũ để tương thích ngược).
 * - unitPrice âm / NaN / Infinity, discPct/vatPct ngoài 0–100: TRẢ LỖI 400
 *   (ngăn đơn tiền âm và NaN lan qua toàn bộ tính toán).
 */
export function validateOrderLines<T extends Partial<OrderLineInput>>(
  lines: T[] | undefined | null,
): { lines: T[]; error?: string } {
  const arr = Array.isArray(lines) ? lines : []
  const kept = arr.filter((l) => l && typeof l.itemCode === 'string' && l.itemCode.trim() && Number(l.quantity) > 0)
  if (kept.length === 0) return { lines: [], error: 'Đơn hàng cần ít nhất 1 dòng hàng hóa hợp lệ' }
  for (const l of kept) {
    const code = String(l.itemCode)
    const price = Number(l.unitPrice)
    if (!Number.isFinite(price) || price < 0) {
      return { lines: [], error: `Đơn giá không hợp lệ cho mặt hàng ${code} (phải là số >= 0)` }
    }
    for (const [k, v] of [['Chiết khấu dòng', l.discPct], ['Thuế suất VAT', l.vatPct]] as const) {
      if (v === undefined || v === null) continue
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { lines: [], error: `${k} của mặt hàng ${code} phải từ 0–100%` }
      }
    }
  }
  return { lines: kept }
}

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
  // VND không có đơn vị nhỏ hơn đồng → làm tròn LineTotal ngay từ đầu để
  // mọi tổng phía sau đều là số nguyên, khớp cách SAP B1 làm tròn từng dòng.
  const base = lines.map((l) => {
    const quantity = Number(l.quantity)
    const unitPrice = Number(l.unitPrice)
    const lineTotal = Math.round(quantity * unitPrice)
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
