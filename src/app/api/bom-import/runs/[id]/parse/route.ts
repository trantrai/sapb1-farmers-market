// ============================================================
// POST /api/bom-import/runs/[id]/parse — parse MD_05 → canonical v1.1
// + validate V1–V9/W1–W10 (F1, F2, F3)
// Yêu cầu gate #1: run phải ở trạng thái 'confirmed', ngược lại 409.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import {
  getBomImportDir,
  getJobDir,
  IngestChangedError,
  verifySourceFiles,
} from '@/lib/fm-bom-import/base-client'
import { parseMd05FromBuffer } from '@/lib/fm-bom-import/parser-md05'
import { parseQuotationFromBuffer } from '@/lib/fm-bom-import/parser-quotation'
import { buildCanonicalDoc } from '@/lib/fm-bom-import/canonical'
import {
  buildCrossChecks,
  errorsOf,
  validateCanonical,
  warningsOf,
} from '@/lib/fm-bom-import/validator'
import { parseSourceFiles, serializeRun } from '../../../_lib'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền chạy parse Import BOM' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })

  // Gate #1 — chưa xác nhận file thì parse bị chặn
  if (run.status !== 'confirmed') {
    return NextResponse.json(
      { error: `Run chưa qua gate 1 (trạng thái hiện tại: ${run.status}) — hãy xác nhận file trước khi parse` },
      { status: 409 },
    )
  }

  const sourceFiles = parseSourceFiles(run)
  const in1 = sourceFiles.find((s) => s.input === 'IN-1')
  if (!in1) {
    return NextResponse.json({ error: 'Run thiếu file IN-1 (File BOM)' }, { status: 500 })
  }

  try {
    // V8 — verify checksum trước khi parse (E_INGEST_CHANGED → abort run)
    await verifySourceFiles(sourceFiles)

    const absPath = path.join(getBomImportDir(), ...in1.relPath.split('/'))
    const buffer = await fs.readFile(absPath)

    // F1 — parse 2-pass (values + formulas)
    const { parents, sheetUsed } = parseMd05FromBuffer(buffer)

    // F19 (Sprint 2) — parse workbook báo giá IN-2 (3 sheet)
    const in2 = sourceFiles.find((s) => s.input === 'IN-2')
    let quotation: { sets: import('@/lib/fm-bom-import/parser-quotation').QuotationSet[]; contractTotals: import('@/lib/fm-bom-import/parser-quotation').ContractTotals | null; deliverySchedule: import('@/lib/fm-bom-import/parser-quotation').DeliveryScheduleRow[] } | undefined
    let costing: import('@/lib/fm-bom-import/parser-quotation').CostingRow[] | undefined
    const quotationWarnings: string[] = []
    if (in2) {
      const qPath = path.join(getBomImportDir(), ...in2.relPath.split('/'))
      const qBuffer = await fs.readFile(qPath)
      const parsed = parseQuotationFromBuffer(qBuffer)
      quotation = { sets: parsed.sets, contractTotals: parsed.contractTotals, deliverySchedule: parsed.deliverySchedule }
      costing = parsed.costing
      quotationWarnings.push(...parsed.warnings)
      if (parsed.skippedSheets.length > 0) {
        quotationWarnings.push(`Bỏ qua sheet không parse: ${parsed.skippedSheets.join(', ')}`)
      }
    }

    // F2 — canonical v1.1
    const canonical = buildCanonicalDoc(parents, {
      sourceFile: in1.filename,
      jobContext: {
        jobId: run.jobId,
        jobName: run.jobName,
        workflowId: null,
        sourceFiles: sourceFiles.map((s) => ({
          field: s.field,
          filename: s.filename,
          md5: s.md5,
          sha256: s.sha256,
          bytes: s.bytes,
          downloadedAt: s.downloadedAt,
        })),
      },
    })
    if (quotation) canonical.quotation = quotation
    if (costing) canonical.costing = costing

    // F3 — validation (V1–V9 fail-fast + W1–W10)
    // Sprint 2: đã có báo giá → bật V9/W7/W8/W9/W10.
    // Vẫn bỏ qua: V4/W3/W6 (cần master B1 — Sprint 3).
    const skippedRules = [
      'V4 — kiểm tra mã NVL tồn tại trên B1 (cần Service Layer, Sprint 3)',
      'W3 — ĐVT tồn kho trên B1 (cần Service Layer, Sprint 3)',
      'W6 — trùng barcode (cần master B1, Sprint 3)',
      ...(in2
        ? []
        : ['V9/W7/W8/W9/W10 — đối chiếu báo giá (thiếu file IN-2 workbook báo giá)']),
    ]
    const issues = validateCanonical(canonical, {
      jobId: run.jobId,
      sourceFiles: sourceFiles.map((s) => ({ field: s.field, md5: s.md5, sha256: s.sha256 })),
      quotationSets: quotation?.sets,
      costing,
      deliverySchedule: quotation?.deliverySchedule,
      // V9 fail-fast mặc định TẮT: không link được → warning W9 + user gán tay ở preview (NQ4)
      requireQuotationLink: false,
    })

    // F5 — crossChecks cho panel "Đối chiếu báo giá"
    const crossChecks = quotation
      ? buildCrossChecks(canonical, { sets: quotation.sets, costing: costing ?? [] })
      : []
    canonical.crossChecks = crossChecks

    // Lưu canonical + issues xuống đĩa (audit), canonicalRef trỏ tới file.
    // Sidecar còn giữ state Sprint 2: manualLinks, generatedCodes, approvedParents.
    const jobDir = getJobDir(run.jobId)
    await fs.mkdir(jobDir, { recursive: true })
    const relRef = `${run.jobId}/${id}.canonical.json`
    const absRef = path.join(getBomImportDir(), ...relRef.split('/'))
    await fs.writeFile(
      absRef,
      JSON.stringify(
        {
          savedAt: new Date().toISOString(),
          canonical,
          issues,
          validatedAt: new Date().toISOString(),
          manualLinks: {},
          generatedCodes: {},
          approvedParents: [],
          quotationWarnings,
        },
        null,
        2,
      ),
    )

    // Tóm tắt đối chiếu báo giá vào DB (Sprint 2)
    const crossChecksSummary = {
      sets: quotation?.sets.length ?? 0,
      costingRows: costing?.length ?? 0,
      deliveryRows: quotation?.deliverySchedule.length ?? 0,
      warnChecks: crossChecks.filter((c) => c.verdict === 'warn').length,
      warnings: quotationWarnings,
    }

    const updated = await prisma.importRun.update({
      where: { id },
      data: {
        status: 'validated',
        canonicalRef: relRef,
        crossChecksSummary: JSON.stringify(crossChecksSummary),
      },
    })

    const errors = errorsOf(issues)
    const warnings = warningsOf(issues)
    return NextResponse.json({
      run: serializeRun(updated),
      sheetUsed,
      parents: parents.map((p) => ({
        rowNo: p.rowNo,
        itemCode: p.itemCode,
        itemName: p.itemName,
        bomKind: p.bomKind,
        primaryBarcode: p.primaryBarcode,
        priceExVat: p.priceExVat,
        components: p.components.length,
        marginPct: p.mdChecks.marginPct,
      })),
      stats: {
        parents: parents.length,
        components: parents.reduce((n, p) => n + p.components.length, 0),
        errors: errors.length,
        warnings: warnings.length,
      },
      issues,
      skippedRules,
      blocked: errors.length > 0,
      quotation: quotation
        ? {
            sets: quotation.sets.map((s) => ({ name: s.name, lines: s.lines.length, subtotalExVat: s.subtotalExVat })),
            costingRows: costing?.length ?? 0,
            deliveryRows: quotation.deliverySchedule.length,
            contractTotalIncVat: quotation.contractTotals?.totalIncVat ?? null,
            warnings: quotationWarnings,
          }
        : null,
    })
  } catch (e) {
    if (e instanceof IngestChangedError) {
      await prisma.importRun.update({
        where: { id },
        data: { status: 'failed', finishedAt: new Date() },
      })
      return NextResponse.json({ error: e.message, code: 'E_INGEST_CHANGED' }, { status: 409 })
    }
    return NextResponse.json(
      { error: `Parse thất bại: ${(e as Error).message}` },
      { status: 500 },
    )
  }
}
