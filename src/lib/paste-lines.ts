// ============================================================
// DÁN DANH SÁCH DÒNG HÀNG (Excel / Zalo / email) → [{ key, quantity }]
// key = mã hàng / barcode / tên hàng (máy chủ tra theo thứ tự đó).
// Hỗ trợ:
//   FM-RAU-002   10            (cột Excel: tab hoặc nhiều khoảng trắng)
//   FM-RAU-002\tCà chua\t10    (lấy SỐ CUỐI làm SL, cột chữ đầu làm key)
//   8934563100021 x5 | 5 x 8934563100021 | x5 8934...
//   cà chua bi 10kg | cà chua bi: 2,5 kg | 2.5
//   - FM-RAU-002 ; 3   (gạch đầu dòng, dấu ; , |)
// Dòng không có số → SL mặc định 1. Bỏ dòng trống / dòng tiêu đề.
// ============================================================

export interface PastedLine {
  /** Dòng gốc (hiển thị lại cho người dùng đối chiếu) */
  raw: string
  /** Chuỗi tra mặt hàng: mã / barcode / tên */
  key: string
  quantity: number
  /** true = không tìm thấy số lượng trong dòng → mặc định 1 */
  qtyDefaulted: boolean
}

/** Tiêu đề cột hay gặp khi copy từ Excel — bỏ qua */
const HEADER_RE = /^(stt|no\.?|#)?\s*(mã\s*(hàng|sp|vt)?|item\s*code|itemcode|tên\s*hàng|sản\s*phẩm|mặt\s*hàng|barcode|mã\s*vạch)\b/i

/** Số dạng VN/EN: 10 | 2,5 | 2.5 | 1.000 (nghìn) — đơn vị dính kèm (kg, hộp…) được bỏ */
function parseQty(tok: string): number | null {
  const m = tok.trim().match(/^x?\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:x|[a-zà-ỹ()]{1,8})?\.?$/i)
  if (!m) return null
  let s = m[1]
  // 1.000 / 1,000 (nhóm nghìn đủ 3 chữ số) → 1000; 2,5 / 2.5 → 2.5
  if (/^\d{1,3}([.,]\d{3})+$/.test(s) && !/^\d+[.,]\d{1,2}$/.test(s)) s = s.replace(/[.,]/g, '')
  else s = s.replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Barcode/mã toàn số (≥ 6 chữ số) không phải số lượng */
const looksLikeCode = (tok: string) => /^\d{6,}$/.test(tok.trim())

export function parsePastedLines(text: string, maxLines = 200): PastedLine[] {
  const out: PastedLine[] = []
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    const raw = rawLine.trim()
    if (!raw) continue
    let line = raw.replace(/^[-*•+]\s*/, '').replace(/^\d{1,3}[.)]\s+/, '') // gạch đầu dòng / "1. "
    if (HEADER_RE.test(line) && !/\d{6,}/.test(line)) continue
    // Tách cột: tab, ; | hoặc ≥2 khoảng trắng; nếu chỉ 1 cột thì tách theo khoảng trắng
    let cols = line.split(/\t|;|\||\s{2,}/).map((c) => c.trim()).filter(Boolean)
    if (cols.length === 1) cols = line.split(/\s+/).filter(Boolean)
    // "Cà chua: 2,5 kg" → bỏ dấu ':' cuối token
    cols = cols.map((c) => c.replace(/:$/, ''))

    let quantity: number | null = null
    let qtyIdx = -1
    // Ưu tiên số ở CUỐI (cột SL Excel / "… 10kg"); không có → số ở ĐẦU ("5 x MÃ")
    for (let i = cols.length - 1; i >= 0; i--) {
      if (looksLikeCode(cols[i])) continue
      const q = parseQty(cols[i])
      if (q != null) { quantity = q; qtyIdx = i; break }
      if (i < cols.length - 1) break // chỉ xét token cuối (và token đơn vị "kg" ngay trước)
    }
    if (quantity == null && cols.length > 1 && !looksLikeCode(cols[0])) {
      const q = parseQty(cols[0])
      if (q != null) { quantity = q; qtyIdx = 0 }
    }
    let rest = cols.filter((_, i) => i !== qtyIdx)
    // Bỏ token "x" rời và đơn vị rời ngay sau số ("10 kg")
    rest = rest.filter((t) => !/^x$/i.test(t))
    if (qtyIdx > 0 && rest.length > 1 && /^[a-zà-ỹ()]{1,6}$/i.test(rest[rest.length - 1]) && qtyIdx === cols.length - 2) rest.pop()
    // Excel nhiều cột (mã \t tên \t SL): lấy cột đầu làm key nếu trông như mã
    const key = (rest.length > 1 && /^[A-Za-z0-9][\w.\-/]*\d[\w.\-/]*$/.test(rest[0]) ? rest[0] : rest.join(' ')).trim()
    if (!key) continue
    out.push({ raw, key, quantity: quantity ?? 1, qtyDefaulted: quantity == null })
    if (out.length >= maxLines) break
  }
  return out
}

/** Nội dung dán có phải danh sách nhiều dòng hàng không (để mở hộp thoại dán) */
export function looksLikeLineList(text: string): boolean {
  return text.replace(/\r/g, '').split('\n').filter((l) => l.trim()).length >= 2 || /\t/.test(text)
}
