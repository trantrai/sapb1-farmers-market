// ============================================================
// Tra 1 chuỗi (mã / barcode / tên) ra mặt hàng — dùng cho "Dán danh sách
// dòng hàng" (/api/items/resolve). Thứ tự: mã CHÍNH XÁC → barcode CHÍNH XÁC
// → tên (đủ mọi từ, không phân biệt hoa thường/dấu).
// ============================================================
import { norm } from './fm-items'

export interface ResolvedItem {
  itemCode: string
  itemName: string
  uom: string
  price: number
  taxCode: string
  vatRate?: number
  barcode: string
}

export type ResolveResult =
  | { key: string; status: 'matched'; matchedBy: 'code' | 'barcode' | 'name'; item: ResolvedItem }
  | { key: string; status: 'ambiguous'; candidates: ResolvedItem[] }
  | { key: string; status: 'notfound' }

/** Tra 1 key trên danh mục đã nạp (thuần — dùng cho cả mirror và SAP) */
export function resolveKey(key: string, items: ResolvedItem[]): ResolveResult {
  const k = key.trim()
  const kl = k.toLowerCase()
  const byCode = items.find((it) => it.itemCode.toLowerCase() === kl)
  if (byCode) return { key, status: 'matched', matchedBy: 'code', item: byCode }
  const byBarcode = items.find((it) => it.barcode && it.barcode.toLowerCase() === kl)
  if (byBarcode) return { key, status: 'matched', matchedBy: 'barcode', item: byBarcode }
  const nk = norm(k)
  const words = nk.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { key, status: 'notfound' }
  const exactName = items.filter((it) => norm(it.itemName) === nk)
  if (exactName.length === 1) return { key, status: 'matched', matchedBy: 'name', item: exactName[0] }
  // Chấm điểm từng từ: trùng nguyên từ 3 > đầu từ 2 > nằm giữa 1 (vd "cà" ưu tiên
  // "Cà chua" hơn "Cam sành"); phải khớp ĐỦ mọi từ mới tính.
  const scored: { it: ResolvedItem; score: number }[] = []
  for (const it of items) {
    const tokens = norm(`${it.itemName} ${it.itemCode}`).split(/[\s\-_/.,()]+/).filter(Boolean)
    let score = 0
    for (const w of words) {
      const best = tokens.reduce((b, t) => Math.max(b, t === w ? 3 : t.startsWith(w) ? 2 : t.includes(w) ? 1 : 0), 0)
      if (best === 0) { score = 0; break }
      score += best
    }
    if (score > 0) scored.push({ it, score })
  }
  scored.sort((a, b) => b.score - a.score || a.it.itemName.length - b.it.itemName.length)
  if (scored.length === 1) return { key, status: 'matched', matchedBy: 'name', item: scored[0].it }
  if (scored.length > 1) return { key, status: 'ambiguous', candidates: scored.slice(0, 5).map((x) => x.it) }
  return { key, status: 'notfound' }
}
