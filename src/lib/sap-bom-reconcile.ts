// ============================================================
// BOM TEMPLATE → SAP B1: ĐẨY 2 BƯỚC
//
// Đã xác nhận trên SAP thật: nhận dòng cha BOM Template là SAP TỰ BUNG công
// thức (bỏ qua TreeType=iNotATree). Các dòng tự bung là dòng thường (TreeType
// N, U_BOMID trống), số lượng = định mức cho 1 cha (không nhân SL cha).
// Gửi kèm dòng con của người dùng → TRÙNG công thức cũ + mới.
//
// Cách làm:
//  1. POST/PATCH gửi CẢ dòng cha và dòng con người dùng (SL đã chỉnh, giá 0,
//     U_BOMID = mã cha). SAP vẫn chèn thêm khối định mức gốc ngay sau cha.
//  2. Đọc lại dòng chứng từ, xác định khối dòng SAP vừa bung ngay sau mỗi cha
//     (đối chiếu số dòng + mã với /ProductTrees trên SAP, U_BOMID trống).
//  3. PATCH (B1S-ReplaceCollectionsOnPatch) giữ mọi dòng đã gửi (chỉ LineNum —
//     KHÔNG gửi lại ItemCode/SL để SAP không bung lại và không tính lại SL theo
//     ĐVT kho — lỗi 1470000840); khối dòng bung bị bỏ khỏi danh sách = SAP xoá.
//     (Dòng con không gửi ở bước 1 — luồng cũ — vẫn hỗ trợ: dùng lại dòng bung
//     cùng mã hoặc thêm dòng mới.)
// ============================================================

import { sapGet, sapPatch, type SapConfig } from './sap-service-layer'

/** Dòng local tối thiểu cần cho đối chiếu (khớp SapPushLine) */
export interface ReconcileLine {
  itemCode: string
  quantity: number
  uom?: string | null
  taxCode?: string | null
  warehouseCode?: string | null
  isBomChild?: boolean | null
  bomGroupKey?: string | null
  bomEditable?: boolean | null
  /** LineNum SAP đã có (luồng sửa) */
  lineNum?: number | null
}

export interface SapDocLine {
  LineNum: number
  ItemCode?: string
  U_BOMID?: string | null
}

export const UDF_BOM = 'U_BOMID'

/** Nhóm BOM Template: bomGroupKey → mã cha (con sửa được, có ≥1 con) */
export function templateGroups(lines: ReconcileLine[]): Map<string, string> {
  const parents = new Map<string, string>()
  const kids = new Map<string, ReconcileLine[]>()
  for (const l of lines) {
    const gk = l.bomGroupKey || ''
    if (!gk) continue
    if (l.isBomChild) kids.set(gk, [...(kids.get(gk) ?? []), l])
    else parents.set(gk, l.itemCode)
  }
  const out = new Map<string, string>()
  for (const [gk, code] of parents) {
    const children = kids.get(gk) ?? []
    if (children.length > 0 && children.every((c) => c.bomEditable !== false)) out.set(gk, code)
  }
  return out
}

/**
 * Nhóm Template "mới" — dòng cha CHƯA có LineNum trên SAP (POST: mọi nhóm;
 * PATCH: nhóm vừa thêm). Chỉ các nhóm này bị SAP tự bung khi gửi lên.
 */
export function freshTemplateGroups(lines: ReconcileLine[]): Map<string, string> {
  const all = templateGroups(lines)
  const out = new Map<string, string>()
  for (const l of lines) {
    const gk = l.bomGroupKey || ''
    if (!l.isBomChild && all.has(gk) && typeof l.lineNum !== 'number') out.set(gk, all.get(gk)!)
  }
  return out
}

/** Dòng con của nhóm Template mới (mang U_BOMID, giá 0) */
export function isFreshTplChild(l: ReconcileLine, fresh: Map<string, string>): boolean {
  return !!l.isBomChild && fresh.has(l.bomGroupKey || '')
}

export type ReconcilePlan =
  | { kind: 'ok'; patchLines: Record<string, unknown>[]; keep: Map<number, number>; newIdx: number[] }
  | { kind: 'already' }
  | { kind: 'error'; error: string }

const multisetEq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0001') === [...b].sort().join('\u0001')

/**
 * Lập kế hoạch PATCH bước 2 (thuần — test được).
 * @param local    toàn bộ dòng local theo thứ tự hiển thị
 * @param sapLines dòng chứng từ trên SAP (sau bước 1)
 * @param posted   index các dòng local đã gửi ở bước 1, THEO THỨ TỰ LineNum SAP
 *                 (POST: thứ tự gửi; PATCH: dòng cũ theo LineNum rồi dòng mới theo thứ tự gửi)
 * @param trees    mã cha → mã các thành phần trong /ProductTrees SAP
 */
export function planReconcile(
  local: ReconcileLine[],
  sapLines: SapDocLine[],
  posted: number[],
  trees: Map<string, string[]>,
): ReconcilePlan {
  const fresh = freshTemplateGroups(local)
  const sap = [...sapLines].sort((a, b) => a.LineNum - b.LineNum)
  const expected = posted.length + [...fresh.values()].reduce((n, code) => n + (trees.get(code)?.length ?? 0), 0)

  // Bước 2: dò khối dòng SAP vừa bung ngay sau mỗi cha mới
  const keep = new Map<number, number>() // local idx → LineNum
  const exploded = new Map<string, SapDocLine[]>() // bomGroupKey → dòng SAP bung
  let i = 0
  let walkOk = sap.length === expected
  for (const idx of walkOk ? posted : []) {
    const s = sap[i]
    if (!s || s.ItemCode !== local[idx].itemCode) { walkOk = false; break }
    keep.set(idx, s.LineNum)
    i++
    const gk = local[idx].bomGroupKey || ''
    if (!local[idx].isBomChild && fresh.has(gk)) {
      const comps = trees.get(fresh.get(gk)!) ?? []
      const block = sap.slice(i, i + comps.length)
      if (block.length !== comps.length || block.some((b) => (b.U_BOMID ?? '') !== '')
        || !multisetEq(block.map((b) => b.ItemCode ?? ''), comps)) { walkOk = false; break }
      exploded.set(gk, block)
      i += comps.length
    }
  }
  if (!walkOk || i !== sap.length) {
    // Số dòng SAP đã bằng số dòng local → đã đối chiếu xong ở lần trước
    if (sap.length === local.length) return { kind: 'already' }
    return {
      kind: 'error',
      error: 'Không xác định được các dòng SAP tự bung từ BOM Template (định mức trên SAP khác dự kiến) — kiểm tra lại đơn trên SAP B1.',
    }
  }

  // Bước 3: danh sách dòng đầy đủ theo thứ tự local
  const patchLines: Record<string, unknown>[] = []
  const newIdx: number[] = []
  local.forEach((l, idx) => {
    const gk = l.bomGroupKey || ''
    if (isFreshTplChild(l, fresh) && !keep.has(idx)) {
      const common = {
        Quantity: l.quantity,
        UnitPrice: 0,
        DiscountPercent: 0,
        [UDF_BOM]: fresh.get(gk),
        ...(l.taxCode ? { VatGroup: l.taxCode } : {}),
        ...(l.warehouseCode?.trim() ? { WarehouseCode: l.warehouseCode.trim() } : {}),
      }
      const pool = exploded.get(gk) ?? []
      const reuse = pool.findIndex((b) => b.ItemCode === l.itemCode)
      if (reuse >= 0) {
        const [b] = pool.splice(reuse, 1)
        keep.set(idx, b.LineNum)
        patchLines.push({ LineNum: b.LineNum, ...common })
      } else {
        newIdx.push(idx)
        patchLines.push({ ItemCode: l.itemCode, ...(l.uom?.trim() ? { MeasureUnit: l.uom.trim() } : {}), ...common })
      }
      return
    }
    // Dòng thường / dòng cha / dòng nhóm cũ: giữ nguyên, chỉ gửi LineNum
    patchLines.push({ LineNum: keep.get(idx)! })
  })
  // Dòng bung còn lại trong pool không có trong patchLines → SAP xoá
  return { kind: 'ok', patchLines, keep, newIdx }
}

/** LineNum cho từng dòng local sau bước 3 (dòng mới = LineNum SAP chưa dùng, tăng dần) */
export function finalLineNums(localCount: number, keep: Map<number, number>, newIdx: number[], sapAfter: SapDocLine[]): number[] | undefined {
  const used = new Set(keep.values())
  const fresh = sapAfter.map((l) => l.LineNum).filter((n) => !used.has(n)).sort((a, b) => a - b)
  if (fresh.length !== newIdx.length || sapAfter.length !== localCount) return undefined
  const m = new Map(keep)
  newIdx.forEach((idx, k) => m.set(idx, fresh[k]))
  const out: number[] = []
  for (let idx = 0; idx < localCount; idx++) {
    const n = m.get(idx)
    if (typeof n !== 'number') return undefined
    out.push(n)
  }
  return out
}

/**
 * Ánh xạ dòng local ↔ dòng SAP của chứng từ ĐÃ đối chiếu (đẩy lại / nhận lại):
 * dòng con Template ↔ dòng SAP cùng U_BOMID + mã (theo LineNum); dòng còn lại
 * ↔ dòng SAP không có U_BOMID theo thứ tự. Không khớp → undefined.
 */
export function mapReconciledLines(local: ReconcileLine[], sapLines: SapDocLine[]): number[] | undefined {
  if (sapLines.length !== local.length) return undefined
  const groups = templateGroups(local)
  const sap = [...sapLines].sort((a, b) => a.LineNum - b.LineNum)
  const plain = sap.filter((l) => !(l.U_BOMID ?? ''))
  const kids = sap.filter((l) => !!(l.U_BOMID ?? ''))
  const out: number[] = []
  let p = 0
  for (const l of local) {
    const parent = l.isBomChild ? groups.get(l.bomGroupKey || '') : undefined
    if (parent) {
      const k = kids.findIndex((s) => s.U_BOMID === parent && s.ItemCode === l.itemCode)
      if (k < 0) return undefined
      out.push(kids.splice(k, 1)[0].LineNum)
    } else {
      const s = plain[p++]
      if (!s || s.ItemCode !== l.itemCode) return undefined
      out.push(s.LineNum)
    }
  }
  return out
}

// ---------------- Gọi Service Layer ----------------

const asArr = <T,>(v: unknown): T[] =>
  Array.isArray(v) ? (v as T[]) : v && Array.isArray((v as { results?: unknown }).results) ? ((v as { results: T[] }).results) : []

export async function readDocLines(s: SapConfig, entitySet: string, docEntry: number): Promise<SapDocLine[] | null> {
  const r = await sapGet<{ DocumentLines?: unknown }>(s, `/${entitySet}(${docEntry})`, { $select: 'DocEntry,DocumentLines' }, { audit: 'off' })
  if (!r.ok || !r.data) return null
  return asArr<SapDocLine>(r.data.DocumentLines).filter((l) => typeof l?.LineNum === 'number')
}

/** Mã thành phần BOM của từng cha theo /ProductTrees hiện hành trên SAP (chỉ đọc) */
export async function readTemplateTrees(s: SapConfig, parentCodes: string[]): Promise<Map<string, string[]> | { error: string }> {
  const out = new Map<string, string[]>()
  for (const code of [...new Set(parentCodes)]) {
    const r = await sapGet<{ ProductTreeLines?: unknown }>(s, `/ProductTrees('${code.replace(/'/g, "''")}')`, undefined, { audit: 'off' })
    if (!r.ok || !r.data) return { error: `Không đọc được định mức BOM ${code} trên SAP${r.error ? `: ${r.error}` : ''}` }
    out.set(code, asArr<{ ItemCode?: string }>(r.data.ProductTreeLines).map((l) => String(l.ItemCode ?? '').trim()).filter(Boolean))
  }
  return out
}

/**
 * Bước 2+3 trên SAP. Trả LineNum theo từng dòng local (undefined nếu không
 * xác định được) hoặc lỗi. Không ném exception.
 */
export async function reconcileTemplateBoms(
  s: SapConfig,
  entitySet: string,
  docEntry: number,
  local: ReconcileLine[],
  posted: number[],
  sapLinesAfterStep1?: SapDocLine[],
): Promise<{ ok: true; lineNums?: number[] } | { ok: false; error: string }> {
  const fresh = freshTemplateGroups(local)
  const trees = await readTemplateTrees(s, [...fresh.values()])
  if (!(trees instanceof Map)) return { ok: false, error: trees.error }
  const sapLines = sapLinesAfterStep1?.length ? sapLinesAfterStep1 : await readDocLines(s, entitySet, docEntry)
  if (!sapLines) return { ok: false, error: 'Không đọc lại được dòng chứng từ trên SAP để áp định mức BOM' }

  const plan = planReconcile(local, sapLines, posted, trees)
  if (plan.kind === 'already') return { ok: true, lineNums: mapReconciledLines(local, sapLines) }
  if (plan.kind === 'error') return { ok: false, error: plan.error }

  const res = await sapPatch(s, `/${entitySet}(${docEntry})`, { DocumentLines: plan.patchLines })
  if (!res.ok) return { ok: false, error: `Đã tạo chứng từ nhưng chưa áp được định mức BOM người dùng: ${res.error ?? `HTTP ${res.status}`}` }
  const after = await readDocLines(s, entitySet, docEntry)
  return { ok: true, lineNums: after ? finalLineNums(local.length, plan.keep, plan.newIdx, after) : undefined }
}
