// ============================================================
// FARMERS MARKET — Import BOM: validation engine (F3)
// Fail-fast V1–V9 (dừng cả đợt, báo đúng dòng) + warning W1–W10.
// Mỗi rule trả { code, rowNo, field, message, severity }.
// Không gọi B1/API: mọi dữ liệu ngoài (VatGroups, UoM, mã đã tồn tại…)
// được truyền qua ValidationContext (Sprint 1: test bằng fixture;
// production: lấy từ SAP B1 ở tầng apply — Sprint 3).
// ============================================================

import type { CanonicalDoc, CanonicalParent } from './canonical'
import type {
  CostingRow,
  DeliveryScheduleRow,
  QuotationSet,
  QuotationSetLine,
} from './parser-quotation'

export type { CostingRow, DeliveryScheduleRow, QuotationSet, QuotationSetLine }

export type Severity = 'error' | 'warning'

export interface ValidationIssue {
  code: string
  rowNo: number | null
  field: string | null
  message: string
  severity: Severity
}

export interface SourceFileCheck {
  field: string
  md5: string
  sha256: string
}

/** Gán tay parent ↔ set ở preview (NQ4): rowNo → tên set */
export type ManualLinks = Record<number, string>

export interface ValidationContext {
  /** Mã VAT hợp lệ (vd P0..P4, S0..S4) — V2; mặc định đủ 10 mã */
  vatCodes?: string[]
  /** ĐVT hợp lệ — V3; không truyền → chỉ kiểm tra rỗng (chưa có master B1) */
  uoms?: string[]
  /** Mã NVL đã tồn tại trên B1 — V4 (thiếu → fail-fast theo ADR-005) */
  existingChildCodes?: Set<string>
  /** Mã cha đã tồn tại — V5 */
  existingParentCodes?: Set<string>
  /** barcode → itemCode (phát hiện trùng) — W6 */
  existingBarcodes?: Map<string, string>
  /** InventoryUOM hiện tại của mã con trên B1 — W3 */
  childUoms?: Map<string, string>
  /** Chính sách mã con thiếu: 'fail' (mặc định) | 'warn' */
  missingChildPolicy?: 'fail' | 'warn'
  /** Cho phép update khi mã cha đã tồn tại — V5 */
  allowUpdate?: boolean
  /** Ngưỡng lệch công thức giá T3 — W5 (mặc định 0.005 = 0.5%) */
  priceFormulaThreshold?: number
  /** Ngưỡng margin W1 (mặc định 0) */
  marginThreshold?: number
  /** Ngưỡng costDelta tương đối W2 (mặc định 0.05 = 5%) */
  costDeltaThreshold?: number
  /** Báo giá để đối chiếu — W7/W9/V9 (Sprint 2 parse đầy đủ) */
  quotationSets?: QuotationSet[]
  deliverySchedule?: DeliveryScheduleRow[]
  /** Final Cost — W8 */
  costing?: CostingRow[]
  /** Bắt buộc mỗi parent link được tới 1 set báo giá — V9 */
  requireQuotationLink?: boolean
  /** Gán tay parent ↔ set từ preview (NQ4) — ưu tiên hơn rule tự động */
  manualLinks?: ManualLinks
  /** Ngưỡng W7 (mặc định 0.01 = 1%, NQ3) */
  w7Threshold?: number
  /** Ngưỡng W8 theo điểm % (mặc định 3, NQ3) */
  w8ThresholdPp?: number
  /** jobId của run — V7 */
  jobId?: string
  /** sourceFiles đã ghi lúc ingest — V7/V8 */
  sourceFiles?: SourceFileCheck[]
}

/** Gán tay ở preview được ưu tiên; mặc định NQ4 — link theo tên chứa nhau */
export interface ParentSetLink {
  set: QuotationSet | null
  /** true = rule tự động NQ4; false = user gán tay */
  auto: boolean
}

/** NQ4 — link parent ↔ set theo tên chứa nhau (normalize, không dấu vẫn khớp) */
export function linkParentToSet(
  parent: CanonicalParent,
  sets: QuotationSet[],
  manualLinks?: ManualLinks,
): ParentSetLink {
  if (manualLinks?.[parent.rowNo]) {
    const found = sets.find((s) => s.name === manualLinks[parent.rowNo])
    if (found) return { set: found, auto: false }
  }
  const norm = (s: string) =>
    s.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')
  const pn = norm(parent.itemName)
  if (pn) {
    for (const set of sets) {
      const sn = norm(set.name)
      if (sn.includes(pn) || pn.includes(sn)) return { set, auto: true }
    }
  }
  return { set: null, auto: true }
}

const VAT_PATTERN = /^[PS][0-4]$/

export function validateCanonical(
  doc: CanonicalDoc,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (code: string, rowNo: number | null, field: string | null, message: string) =>
    issues.push({ code, rowNo, field, message, severity: 'error' as Severity })
  const warn = (code: string, rowNo: number | null, field: string | null, message: string) =>
    issues.push({ code, rowNo, field, message, severity: 'warning' as Severity })

  const vatSet = new Set(
    ctx.vatCodes ?? ['P0', 'P1', 'P2', 'P3', 'P4', 'S0', 'S1', 'S2', 'S3', 'S4'],
  )
  const uomSet = ctx.uoms ? new Set(ctx.uoms.map((u) => u.normalize('NFC').trim())) : null
  const missingPolicy = ctx.missingChildPolicy ?? 'fail'
  const priceThreshold = ctx.priceFormulaThreshold ?? 0.005
  const marginThreshold = ctx.marginThreshold ?? 0
  const costDeltaThreshold = ctx.costDeltaThreshold ?? 0.05
  const w7Threshold = ctx.w7Threshold ?? 0.01
  const w8ThresholdPp = ctx.w8ThresholdPp ?? 3

  // ---- V7/V8: ràng buộc job + toàn vẹn file (tầng ingestion) ----
  if (ctx.jobId && doc.jobContext && doc.jobContext.jobId !== ctx.jobId) {
    err('V7', null, 'jobContext.jobId', `jobId không khớp run (file: ${doc.jobContext.jobId}, run: ${ctx.jobId})`)
  }
  if (ctx.sourceFiles && doc.jobContext) {
    for (const sf of doc.jobContext.sourceFiles) {
      const rec = ctx.sourceFiles.find((r) => r.field === sf.field)
      if (!rec) {
        err('V7', null, 'sourceFiles', `Thiếu bản ghi ingest cho field "${sf.field}"`)
      } else if (rec.md5 !== sf.md5) {
        err('V7', null, 'sourceFiles', `md5 lệch cho field "${sf.field}" — file có thể đã bị tráo`)
      }
      if (!sf.sha256) {
        err('V8', null, 'sourceFiles', `Thiếu sha256 cho field "${sf.field}" — toàn vẹn tải file chưa xác thực`)
      }
    }
  }

  for (const p of doc.parents) {
    // ---- V1 ----
    if (!p.itemName) err('V1', p.rowNo, 'itemName', 'Tên mặt hàng (cột E) trống')
    if (!p.bomKind)
      err(
        'V1',
        p.rowNo,
        'bomKind',
        `Không nhận diện được loại BOM/COMBO (cột C) — giá trị ô: ${JSON.stringify(p.bomKindRaw)}`,
      )
    if (p.components.length === 0)
      err('V1', p.rowNo, 'components', 'Mã cha không có thành phần con nào')

    // ---- V2 ----
    for (const [code, label] of [[p.taxIn, 'VAT IN (O)'], [p.taxOut, 'VAT OUT (P)']] as const) {
      if (!code || !VAT_PATTERN.test(code)) {
        err('V2', p.rowNo, label, `Mã thuế "${code ?? ''}" sai định dạng (P0–P4/S0–S4)`)
      } else if (!vatSet.has(code)) {
        err('V2', p.rowNo, label, `Mã thuế "${code}" không tồn tại trong VatGroups`)
      }
    }

    // ---- V6: trùng mã con trong cùng cha ----
    const seenChild = new Set<string>()
    for (const c of p.components) {
      if (seenChild.has(c.childCode)) {
        err('V6', c.rowNo, 'childCode', `Trùng mã NVL "${c.childCode}" trong cùng mã cha`)
      }
      seenChild.add(c.childCode)
    }

    for (const c of p.components) {
      // ---- V3 ----
      if (!c.childCode) err('V3', c.rowNo, 'childCode', 'Mã NVL (cột U) trống')
      if (c.qtyPerParent == null || !(c.qtyPerParent > 0)) {
        err('V3', c.rowNo, 'qtyPerParent', `Định mức không hợp lệ (cột X): "${c.qtyRaw ?? ''}"`)
      }
      if (!c.uom) {
        err('V3', c.rowNo, 'uom', `ĐVT con (cột W) trống cho mã "${c.childCode}"`)
      } else if (uomSet && !uomSet.has(c.uom.normalize('NFC').trim())) {
        err('V3', c.rowNo, 'uom', `ĐVT "${c.uom}" không tồn tại trong UoM master`)
      }
      // ---- V4 ----
      if (c.childCode && ctx.existingChildCodes && !ctx.existingChildCodes.has(c.childCode)) {
        const msg = `Mã NVL "${c.childCode}" chưa tồn tại trên SAP B1`
        if (missingPolicy === 'fail') err('V4', c.rowNo, 'childCode', msg)
        else warn('V4', c.rowNo, 'childCode', `${msg} — bỏ qua dòng con (policy=warn)`)
      }
      // ---- W3: ĐVT con khác InventoryUOM trên B1 ----
      if (c.childCode && c.uom && ctx.childUoms?.has(c.childCode)) {
        const inv = ctx.childUoms.get(c.childCode)!
        if (inv.normalize('NFC').trim() !== c.uom.normalize('NFC').trim()) {
          warn('W3', c.rowNo, 'uom', `ĐVT file "${c.uom}" khác ĐVT tồn kho B1 "${inv}" (mã ${c.childCode})`)
        }
      }
    }

    // ---- V5: mã cha đã tồn tại ----
    if (p.itemCode && ctx.existingParentCodes?.has(p.itemCode)) {
      if (ctx.allowUpdate) {
        warn('V5', p.rowNo, 'itemCode', `Mã cha "${p.itemCode}" đã tồn tại — sẽ cập nhật (allowUpdate=true)`)
      } else {
        err('V5', p.rowNo, 'itemCode', `Mã cha "${p.itemCode}" đã tồn tại — từ chối ghi đè (bật allowUpdate để cập nhật)`)
      }
    }

    // ---- W1: margin âm/dưới ngưỡng ----
    const margin = p.mdChecks.marginPct
    if (margin != null && margin < marginThreshold) {
      warn('W1', p.rowNo, 'mdChecks.marginPct', `Margin tự tính ${(margin * 100).toFixed(1)}% dưới ngưỡng ${(marginThreshold * 100).toFixed(0)}%`)
    }

    // ---- W2: costDelta vượt ngưỡng ----
    const { costTotal, systemCost } = p.mdChecks
    if (costTotal != null && costTotal > 0 && systemCost != null) {
      const delta = Math.abs(systemCost - costTotal) / costTotal
      if (delta > costDeltaThreshold) {
        warn('W2', p.rowNo, 'mdChecks.costDelta', `CHÊNH LỆCH GIÁ VỐN: hệ thống ${systemCost} vs tính lại ${costTotal} (lệch ${(delta * 100).toFixed(1)}%) — CAO THÌ KIỂM TRA LẠI`)
      }
    }

    // ---- W4: CHECK TRÙNG TÊN ----
    if (p.mdChecks.duplicateNameHit) {
      warn('W4', p.rowNo, 'itemName', `Tên "${p.itemName}" có dấu hiệu trùng mặt hàng đã có (cột CHECK TRÙNG TÊN)`)
    }

    // ---- W5: lệch công thức giá ----
    if (p.priceExVat != null && p.priceExVat > 0) {
      for (const [val, col] of [[p.priceCheckQ, 'Q'], [p.priceCheckS, 'S']] as const) {
        if (val != null && val > 0) {
          const dev = Math.abs(p.priceExVat - val) / p.priceExVat
          if (dev > priceThreshold) {
            warn('W5', p.rowNo, `priceCheck${col}`, `Công thức giá không khớp VAT: tính lại ${p.priceExVat}, cột ${col} = ${val} (lệch ${(dev * 100).toFixed(2)}%)`)
          }
        }
      }
    }

    // ---- W6: barcode trùng mặt hàng khác ----
    if (p.primaryBarcode && ctx.existingBarcodes?.has(p.primaryBarcode)) {
      const other = ctx.existingBarcodes.get(p.primaryBarcode)!
      if (!p.itemCode || other !== p.itemCode) {
        warn('W6', p.rowNo, 'primaryBarcode', `Barcode "${p.primaryBarcode}" đã dùng bởi mặt hàng ${other}`)
      }
    }

    // ---- V9/W7/W9: đối chiếu báo giá ----
    const sets = ctx.quotationSets ?? []
    const { set: linked } =
      sets.length > 0 ? linkParentToSet(p, sets, ctx.manualLinks) : { set: null }
    if (ctx.requireQuotationLink && sets.length > 0 && !linked) {
      err('V9', p.rowNo, 'quotation', `Không link được mã cha "${p.itemName}" tới set báo giá nào (NQ4)`)
    }
    if (sets.length > 0 && !linked) {
      // NQ4: không khớp tự động → warning, user gán tay ở preview
      warn('W9', p.rowNo, 'quotation', `Chưa link được mã cha "${p.itemName}" tới set báo giá nào — hãy gán tay ở preview (NQ4)`)
    }
    if (linked) {
      // W7 — lệch giá
      if (p.priceExVat != null && linked.subtotalExVat != null && linked.subtotalExVat > 0) {
        const dev = Math.abs(p.priceExVat - linked.subtotalExVat) / linked.subtotalExVat
        if (dev > w7Threshold) {
          warn('W7', p.rowNo, 'priceExVat', `Lệch giá vs báo giá "${linked.name}": MD_05 ${p.priceExVat} vs set ${linked.subtotalExVat} (lệch ${(dev * 100).toFixed(2)}% > ${(w7Threshold * 100).toFixed(0)}%)`)
        }
      }
      // W9 — phủ dòng
      const setCodes = new Set(linked.lines.map((l) => l.itemCode))
      const mdCodes = new Set(p.components.map((c) => c.childCode))
      const missingInSet = [...mdCodes].filter((c) => !setCodes.has(c))
      const missingInMd = [...setCodes].filter((c) => !mdCodes.has(c))
      if (missingInSet.length > 0 || missingInMd.length > 0) {
        const parts: string[] = []
        if (missingInSet.length > 0) parts.push(`có trong MD_05 nhưng thiếu ở báo giá: ${missingInSet.join(', ')}`)
        if (missingInMd.length > 0) parts.push(`có trong báo giá nhưng thiếu ở MD_05: ${missingInMd.join(', ')}`)
        warn('W9', p.rowNo, 'components', `Phủ dòng báo giá "${linked.name}" lệch — ${parts.join('; ')}`)
      }
    }

    // ---- W8: lệch margin vs Final Cost ----
    if (ctx.costing && ctx.costing.length > 0 && margin != null) {
      const codes = new Set([p.itemCode, ...p.components.map((c) => c.childCode)].filter(Boolean) as string[])
      for (const row of ctx.costing) {
        if (row.margin != null && codes.has(row.itemCode)) {
          const ppDiff = Math.abs(margin - row.margin) * 100
          if (ppDiff > w8ThresholdPp) {
            warn('W8', p.rowNo, 'mdChecks.marginPct', `Lệch margin vs Final Cost (mã ${row.itemCode}): MD_05 ${(margin * 100).toFixed(1)}% vs ${(row.margin * 100).toFixed(1)}% (lệch ${ppDiff.toFixed(1)} điểm % > ${w8ThresholdPp})`)
          }
        }
      }
    }
  }

  // ---- W10: lịch giao quá khứ ----
  if (ctx.deliverySchedule && ctx.deliverySchedule.length > 0) {
    const today = new Date().toISOString().slice(0, 10)
    for (const d of ctx.deliverySchedule) {
      if (d.date && d.date < today) {
        warn('W10', null, 'deliverySchedule', `Lịch giao ${d.date} đã ở quá khứ (có thể giao bù)`)
      }
    }
  }

  return issues
}

/** Kết quả đối chiếu báo giá ↔ MD_05 (theo schema thiết kế §4) */
export interface CrossCheck {
  /** "rowNo|itemName" */
  parentRef: string
  rowNo: number
  check: 'W7' | 'W8' | 'W9'
  expected: number | null
  actual: number | null
  /** W7: % tương đối; W8: điểm % — xem `unit` */
  deviation: number | null
  unit: 'pct' | 'pp'
  verdict: 'pass' | 'warn'
  detail: string
  /** Tên set đã link (tự động hay gán tay) */
  setName: string | null
  linkAuto: boolean
}

export interface CrossCheckOptions {
  w7Threshold?: number
  w8ThresholdPp?: number
  manualLinks?: ManualLinks
}

/**
 * Dựng crossChecks[] cho panel "Đối chiếu báo giá" (F5).
 * Không phát sinh issue mới — chỉ tóm tắt số liệu từ cùng logic W7/W8/W9.
 */
export function buildCrossChecks(
  doc: CanonicalDoc,
  quotation: { sets: QuotationSet[]; costing: CostingRow[] },
  opts: CrossCheckOptions = {},
): CrossCheck[] {
  const w7Threshold = opts.w7Threshold ?? 0.01
  const w8ThresholdPp = opts.w8ThresholdPp ?? 3
  const out: CrossCheck[] = []
  for (const p of doc.parents) {
    const parentRef = `${p.rowNo}|${p.itemName}`
    const { set: linked, auto: linkAuto } = linkParentToSet(p, quotation.sets, opts.manualLinks)
    const setName = linked?.name ?? null

    if (linked) {
      // W7 — lệch giá
      if (p.priceExVat != null && linked.subtotalExVat != null && linked.subtotalExVat > 0) {
        const devPct = (Math.abs(p.priceExVat - linked.subtotalExVat) / linked.subtotalExVat) * 100
        out.push({
          parentRef,
          rowNo: p.rowNo,
          check: 'W7',
          expected: linked.subtotalExVat,
          actual: p.priceExVat,
          deviation: Math.round(devPct * 100) / 100,
          unit: 'pct',
          verdict: devPct / 100 > w7Threshold ? 'warn' : 'pass',
          detail: `Giá MD_05 ${p.priceExVat.toLocaleString('vi-VN')} vs subtotal "${linked.name}" ${linked.subtotalExVat.toLocaleString('vi-VN')} (lệch ${devPct.toFixed(2)}%)`,
          setName,
          linkAuto,
        })
      }
      // W9 — phủ dòng
      const setCodes = new Set(linked.lines.map((l) => l.itemCode))
      const mdCodes = new Set(p.components.map((c) => c.childCode))
      const missingInSet = [...mdCodes].filter((c) => !setCodes.has(c))
      const missingInMd = [...setCodes].filter((c) => !mdCodes.has(c))
      out.push({
        parentRef,
        rowNo: p.rowNo,
        check: 'W9',
        expected: setCodes.size,
        actual: mdCodes.size,
        deviation: null,
        unit: 'pct',
        verdict: missingInSet.length > 0 || missingInMd.length > 0 ? 'warn' : 'pass',
        detail:
          missingInSet.length > 0 || missingInMd.length > 0
            ? `Phủ dòng "${linked.name}" lệch — thiếu ở báo giá: ${missingInSet.join(', ') || '—'}; thiếu ở MD_05: ${missingInMd.join(', ') || '—'}`
            : `Phủ dòng "${linked.name}" khớp đủ ${mdCodes.size} mã NVL`,
        setName,
        linkAuto,
      })
    }

    // W8 — lệch margin vs Final Cost (theo mã cha/con trùng trong costing[])
    const margin = p.mdChecks.marginPct
    if (margin != null && quotation.costing.length > 0) {
      const codes = new Set(
        [p.itemCode, ...p.components.map((c) => c.childCode)].filter(Boolean) as string[],
      )
      for (const row of quotation.costing) {
        if (row.margin != null && codes.has(row.itemCode)) {
          const ppDiff = Math.abs(margin - row.margin) * 100
          out.push({
            parentRef,
            rowNo: p.rowNo,
            check: 'W8',
            expected: Math.round(row.margin * 10000) / 100,
            actual: Math.round(margin * 10000) / 100,
            deviation: Math.round(ppDiff * 100) / 100,
            unit: 'pp',
            verdict: ppDiff > w8ThresholdPp ? 'warn' : 'pass',
            detail: `Margin MD_05 ${(margin * 100).toFixed(1)}% vs Final Cost ${(row.margin * 100).toFixed(1)}% (mã ${row.itemCode}, lệch ${ppDiff.toFixed(1)} điểm %)`,
            setName,
            linkAuto,
          })
        }
      }
    }
  }
  return out
}

/** true nếu còn lỗi fail-fast (severity error) */
export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error')
}

export function errorsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error')
}

export function warningsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'warning')
}
