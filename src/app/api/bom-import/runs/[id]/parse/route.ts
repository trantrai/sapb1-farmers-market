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
import { buildCanonicalDoc } from '@/lib/fm-bom-import/canonical'
import {
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

    // F3 — validation (V1–V9 fail-fast + W1–W10)
    // Sprint 1: chưa có master B1 → V4 (mã con tồn tại) và check ĐVT theo
    // master được bỏ qua; quotation (V9/W7–W10) parse ở Sprint 2 (F19).
    const skippedRules = [
      'V4 — kiểm tra mã NVL tồn tại trên B1 (cần Service Layer, Sprint 3)',
      'V9/W7/W8/W9/W10 — đối chiếu báo giá (cần parse workbook, Sprint 2)',
      'W3 — ĐVT tồn kho trên B1 (cần Service Layer, Sprint 3)',
      'W6 — trùng barcode (cần master B1, Sprint 3)',
    ]
    const issues = validateCanonical(canonical, {
      jobId: run.jobId,
      sourceFiles: sourceFiles.map((s) => ({ field: s.field, md5: s.md5, sha256: s.sha256 })),
    })

    // Lưu canonical + issues xuống đĩa (audit), canonicalRef trỏ tới file
    const jobDir = getJobDir(run.jobId)
    await fs.mkdir(jobDir, { recursive: true })
    const relRef = `${run.jobId}/${id}.canonical.json`
    const absRef = path.join(getBomImportDir(), ...relRef.split('/'))
    await fs.writeFile(
      absRef,
      JSON.stringify(
        { savedAt: new Date().toISOString(), canonical, issues, validatedAt: new Date().toISOString() },
        null,
        2,
      ),
    )

    const updated = await prisma.importRun.update({
      where: { id },
      data: { status: 'validated', canonicalRef: relRef },
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
