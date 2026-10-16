// ============================================================
// POST /api/bom-import/runs — tạo run + ingest 2 file từ Base job (F18)
// GET  /api/bom-import/runs — danh sách runs
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { getBaseToken } from '@/lib/fm-base'
import { snapshotDecisions } from '@/lib/fm-bom-import/decisions'
import {
  BaseApiError,
  BaseRateLimitedError,
  checksums,
  downloadBufferWithRetry,
  fetchBaseJob,
  findIngestedFile,
  getJobDir,
  saveDownloadedFile,
  savePartialFile,
  selectInputFiles,
  type SelectedFile,
  type SourceFileRef,
} from '@/lib/fm-bom-import/base-client'
import { parseSourceFiles, serializeRun, startOfToday } from '../_lib'

// GET /api/bom-import/runs — danh sách (mới nhất trước)
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem Import BOM' }, { status: 403 })
  }
  const sp = req.nextUrl.searchParams
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(50, Math.max(5, parseInt(sp.get('pageSize') ?? '10', 10) || 10))
  const [total, runs] = await Promise.all([
    prisma.importRun.count(),
    prisma.importRun.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return NextResponse.json({
    runs: runs.map(serializeRun),
    total,
    page,
    pageSize,
  })
}

// POST /api/bom-import/runs — { jobId, force? } → ingest ngay
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền tạo lượt import BOM' }, { status: 403 })
  }

  let body: { jobId?: string; force?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body không phải JSON' }, { status: 400 })
  }
  const jobId = String(body.jobId ?? '').trim()
  if (!jobId) {
    return NextResponse.json({ error: 'Thiếu jobId Base Workflow' }, { status: 400 })
  }

  const token = await getBaseToken()
  if (!token) {
    return NextResponse.json(
      { error: 'Chưa cấu hình Base Access Token v2 — vào Cài đặt để nhập token' },
      { status: 400 },
    )
  }

  // Idempotency run:{jobId}:{startedBy}:{date} — cảnh báo run trùng trong ngày
  if (!body.force) {
    const existing = await prisma.importRun.findFirst({
      where: {
        jobId,
        startedBy: user.username,
        createdAt: { gte: startOfToday() },
        status: { not: 'cancelled' },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      return NextResponse.json(
        {
          error: `Đã có run hôm nay cho job ${jobId} (${existing.id}, trạng thái ${existing.status}) — gửi kèm force=true để tạo run mới có chủ đích`,
          existingRunId: existing.id,
        },
        { status: 409 },
      )
    }
  }

  const run = await prisma.importRun.create({
    data: {
      jobId,
      sapDatabaseId: user.databaseId ?? null,
      status: 'ingesting',
      decisions: snapshotDecisions(),
      startedBy: user.username,
    },
  })

  const fieldLog: string[] = []
  try {
    const job = await fetchBaseJob(jobId, token)
    const { in1, in2, fieldLog: selLog } = selectInputFiles(job)
    fieldLog.push(...selLog)
    await prisma.importRun.update({
      where: { id: run.id },
      data: { jobName: job.name || null },
    })

    // Các run trước của cùng job (để tái dùng file đã ingest)
    const priorRuns = await prisma.importRun.findMany({
      where: { jobId, id: { not: run.id } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { sourceFiles: true },
    })
    const prior = priorRuns.map((r) => ({ sourceFiles: parseSourceFiles(r as never) }))

    const jobDir = getJobDir(jobId)
    const downloaded = new Map<string, SourceFileRef>() // url → SourceFileRef (dedupe)
    const sourceFiles: SourceFileRef[] = []

    const ingestOne = async (sel: SelectedFile): Promise<SourceFileRef> => {
      if (downloaded.has(sel.url)) {
        const reused = downloaded.get(sel.url)!
        fieldLog.push(`${sel.input}: trùng URL với "${reused.field}" — dùng chung file đã tải`)
        return { ...reused, input: sel.input, field: sel.field }
      }
      let buffer: Buffer
      try {
        ;({ buffer } = await downloadBufferWithRetry(sel.url))
      } catch (e) {
        await savePartialFile(jobDir, sel.field, sel.filename)
        throw e
      }
      const { md5, sha256 } = checksums(buffer)
      const key = `ingest:${jobId}:${sel.field}:${md5}`
      const hit = findIngestedFile(prior, jobId, sel.field, md5)
      let ref: SourceFileRef
      if (hit) {
        fieldLog.push(`${sel.input}: dùng file đã lưu (${hit.relPath}) — key ${key}`)
        ref = {
          ...hit,
          input: sel.input,
          field: sel.field,
          filename: sel.filename,
          downloadedAt: new Date().toISOString(),
        }
      } else {
        const { relPath } = await saveDownloadedFile(jobDir, sel.field, sel.filename, buffer)
        fieldLog.push(`${sel.input}: đã tải ${sel.filename} (${buffer.length} byte, md5 ${md5.slice(0, 8)}…)`)
        ref = {
          input: sel.input,
          field: sel.field,
          filename: sel.filename,
          relPath,
          md5,
          sha256,
          bytes: buffer.length,
          downloadedAt: new Date().toISOString(),
        }
      }
      downloaded.set(sel.url, ref)
      return ref
    }

    sourceFiles.push(await ingestOne(in1))
    if (in2) sourceFiles.push(await ingestOne(in2))
    else fieldLog.push('IN-2: job không có workbook báo giá — bỏ qua đối chiếu')

    const updated = await prisma.importRun.update({
      where: { id: run.id },
      data: { status: 'ingested', sourceFiles: JSON.stringify(sourceFiles) },
    })
    return NextResponse.json({ run: serializeRun(updated), fieldLog }, { status: 201 })
  } catch (e) {
    await prisma.importRun.update({
      where: { id: run.id },
      data: { status: 'failed', finishedAt: new Date() },
    })
    if (e instanceof BaseRateLimitedError) {
      return NextResponse.json({ error: e.message, runId: run.id }, { status: 429 })
    }
    const msg = e instanceof BaseApiError ? e.message : `Ingest thất bại: ${(e as Error).message}`
    const status = e instanceof BaseApiError && e.status ? e.status : 502
    return NextResponse.json({ error: msg, runId: run.id, fieldLog }, { status })
  }
}
