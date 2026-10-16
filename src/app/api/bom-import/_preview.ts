// ============================================================
// Helper dựng payload preview Sprint 2 (F5) từ sidecar của run.
// Dùng chung cho GET /preview và POST /links.
// ============================================================

import {
  buildCrossChecks,
  errorsOf,
  linkParentToSet,
  validateCanonical,
  warningsOf,
  type CrossCheck,
  type ManualLinks,
  type ValidationIssue,
} from '@/lib/fm-bom-import/validator'
import type { RunSidecar } from './_lib'

export interface PreviewParent {
  rowNo: number
  /** Mã đã sinh (Q1) hoặc null = chờ nhập */
  itemCode: string | null
  itemName: string
  bomKind: string | null
  primaryBarcode: string | null
  priceExVat: number | null
  marginPct: number | null
  /** Sprint 2.1 — trường cha bổ sung theo yêu cầu (ảnh header template) */
  categoryLevel7: string | null
  uomPurchase: string | null
  uomSales: string | null
  uomInventory: string | null
  warehouse: string | null
  taxIn: string | null
  taxOut: string | null
  components: {
    rowNo: number
    childCode: string
    childName: string | null
    uom: string | null
    qtyPerParent: number | null
  }[]
  linkedSet: string | null
  linkAuto: boolean
  crossChecks: CrossCheck[]
  approved: boolean
}

export interface PreviewPayload {
  parents: PreviewParent[]
  sets: { name: string; lines: number; subtotalExVat: number | null }[]
  issues: ValidationIssue[]
  errors: number
  warnings: number
  blocked: boolean
  approvedCount: number
  canApply: boolean
  applyNote: string | null
  manualLinks: ManualLinks
  generatedCodes: Record<number, string>
  approvedParents: number[]
  quotationWarnings: string[]
  summary: { sets: number; costingRows: number; deliveryRows: number }
}

/** Validate lại canonical với manualLinks hiện tại (dùng sau khi gán tay) */
export function revalidateWithLinks(sidecar: RunSidecar): {
  issues: ValidationIssue[]
  crossChecks: CrossCheck[]
} {
  const canonical = sidecar.canonical
  const sets = canonical.quotation?.sets ?? []
  const issues = validateCanonical(canonical, {
    // Giữ nguyên check toàn vẹn V7/V8 từ lúc parse (jobContext lưu trong canonical)
    jobId: canonical.jobContext?.jobId,
    sourceFiles: canonical.jobContext?.sourceFiles.map((s) => ({
      field: s.field,
      md5: s.md5,
      sha256: s.sha256,
    })),
    quotationSets: sets,
    costing: canonical.costing,
    deliverySchedule: canonical.quotation?.deliverySchedule,
    manualLinks: sidecar.manualLinks,
    requireQuotationLink: false,
  })
  const crossChecks = buildCrossChecks(
    canonical,
    { sets, costing: canonical.costing ?? [] },
    { manualLinks: sidecar.manualLinks },
  )
  return { issues, crossChecks }
}

export function buildPreviewPayload(sidecar: RunSidecar): PreviewPayload {
  const { canonical } = sidecar
  const sets = canonical.quotation?.sets ?? []
  const { issues, crossChecks } = revalidateWithLinks(sidecar)
  const errors = errorsOf(issues).length
  const warnings = warningsOf(issues).length
  const blocked = errors > 0

  const parents: PreviewParent[] = canonical.parents.map((p) => {
    const { set: linked, auto } = linkParentToSet(p, sets, sidecar.manualLinks)
    return {
      rowNo: p.rowNo,
      itemCode: sidecar.generatedCodes[p.rowNo] ?? p.itemCode ?? null,
      itemName: p.itemName,
      bomKind: p.bomKind,
      primaryBarcode: p.primaryBarcode,
      priceExVat: p.priceExVat,
      marginPct: p.mdChecks.marginPct,
      categoryLevel7: p.categoryLevel7,
      uomPurchase: p.uom.purchase,
      uomSales: p.uom.sales,
      uomInventory: p.uom.inventory,
      warehouse: p.warehouse,
      taxIn: p.taxIn,
      taxOut: p.taxOut,
      components: p.components.map((c) => ({
        rowNo: c.rowNo,
        childCode: c.childCode,
        childName: c.childName,
        uom: c.uom,
        qtyPerParent: c.qtyPerParent,
      })),
      linkedSet: linked?.name ?? null,
      linkAuto: auto,
      crossChecks: crossChecks.filter((c) => c.rowNo === p.rowNo),
      approved: sidecar.approvedParents.includes(p.rowNo),
    }
  })

  const approvedCount = parents.filter((p) => p.approved).length
  const canApply = !blocked && approvedCount > 0
  const applyNote = blocked
    ? `Còn ${errors} lỗi fail-fast — khắc phục trước khi apply`
    : approvedCount === 0
      ? 'Chưa duyệt mã cha nào ở gate 2 — tick checkbox để duyệt'
      : null

  return {
    parents,
    sets: sets.map((s) => ({ name: s.name, lines: s.lines.length, subtotalExVat: s.subtotalExVat })),
    issues,
    errors,
    warnings,
    blocked,
    approvedCount,
    canApply,
    applyNote,
    manualLinks: sidecar.manualLinks,
    generatedCodes: sidecar.generatedCodes,
    approvedParents: sidecar.approvedParents,
    quotationWarnings: sidecar.quotationWarnings,
    summary: {
      sets: sets.length,
      costingRows: canonical.costing?.length ?? 0,
      deliveryRows: canonical.quotation?.deliverySchedule.length ?? 0,
    },
  }
}
