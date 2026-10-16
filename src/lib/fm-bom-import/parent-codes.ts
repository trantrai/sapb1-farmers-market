// ============================================================
// FARMERS MARKET — Import BOM: sinh mã cha (F4, Q1/ADR-003)
// Phase 1: user nhập mã cha ĐẦU TIÊN; các mã còn lại tự tăng dần theo
// phần số cuối (giữ zero-padding); không có phần số cuối → thêm "-001".
// Mỗi mã kiểm tra trùng (qua callback) — trùng → tăng tiếp, tối đa 10 lần.
// Idempotent: cùng firstCode + cùng số cha → cùng dãy mã.
// ============================================================

export interface GenerateCodesResult {
  codes: string[]
  /** Cảnh báo không chặn (vd bỏ qua kiểm tra trùng vì B1 chưa sẵn sàng) */
  warnings: string[]
  /** true nếu mọi mã đều đã qua kiểm tra trùng */
  dupChecked: boolean
}

/** Tách phần số cuối: "CB-202610-0007" → { prefix: "CB-202610-", num: 7, width: 4 } */
export function splitTrailingNumber(code: string): { prefix: string; num: number; width: number } | null {
  const m = code.match(/^(.*?)(\d+)$/)
  if (!m) return null
  return { prefix: m[1], num: parseInt(m[2], 10), width: m[2].length }
}

function pad(num: number, width: number): string {
  return String(num).padStart(width, '0')
}

export interface GenerateCodesOptions {
  /** Số mã cha cần sinh */
  count: number
  /**
   * Kiểm tra mã đã tồn tại — true = trùng (cần tăng tiếp).
   * Không truyền → bỏ qua kiểm tra, ghi warning (B1 test chưa có — Sprint 3).
   */
  exists?: (code: string) => boolean | Promise<boolean>
  /** Số lần tăng tối đa khi trùng (mặc định 10) */
  maxBump?: number
}

/** Tăng mã lên 1 đơn vị, giữ nguyên định dạng phần số */
function bumpCode(code: string): string {
  const t = splitTrailingNumber(code)
  if (t) return `${t.prefix}${pad(t.num + 1, t.width)}`
  const m = code.match(/^(.*?)-(\d+)$/)
  return m ? `${m[1]}-${pad(parseInt(m[2], 10) + 1, m[2].length)}` : `${code}-001`
}

/**
 * Sinh dãy mã cha từ mã đầu tiên do user nhập.
 * - Có phần số cuối: tăng dần giữ zero-padding ("CB-202610-0007" → "…-0008")
 * - Không có phần số cuối: mã đầu giữ nguyên, các mã sau thêm "-001", "-002"…
 */
export async function generateParentCodes(
  firstCode: string,
  opts: GenerateCodesOptions,
): Promise<GenerateCodesResult> {
  const warnings: string[] = []
  const first = firstCode.normalize('NFC').trim()
  if (!first) throw new Error('Mã cha đầu tiên trống')
  if (opts.count < 1) throw new Error('Số mã cha cần sinh phải ≥ 1')

  const maxBump = opts.maxBump ?? 10
  const exists = opts.exists
  const dupChecked = typeof exists === 'function'
  if (!dupChecked) {
    warnings.push(
      'Bỏ qua kiểm tra trùng mã trên SAP B1 (chưa có B1 test) — mã được sinh nhưng chưa xác thực tồn tại',
    )
  }

  const seed = splitTrailingNumber(first)
  const codes: string[] = []
  const used = new Set<string>()

  for (let k = 0; k < opts.count; k++) {
    let code: string
    if (k === 0) {
      code = first
    } else if (seed) {
      code = `${seed.prefix}${pad(seed.num + k, seed.width)}`
    } else {
      code = `${first}-${pad(k, 3)}`
    }
    let bumps = 0
    while (used.has(code) || (dupChecked && (await exists!(code)))) {
      bumps++
      if (bumps > maxBump) {
        throw new Error(
          `Không sinh được mã không trùng cho cha thứ ${k + 1} sau ${maxBump} lần tăng (seed "${first}")`,
        )
      }
      code = bumpCode(code)
    }
    used.add(code)
    codes.push(code)
  }

  return { codes, warnings, dupChecked }
}
