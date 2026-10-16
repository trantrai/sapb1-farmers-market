// Helper dùng chung cho API Import BOM
import type { ImportRun } from '@prisma/client'
import type { SourceFileRef } from '@/lib/fm-bom-import/base-client'

function safeParseArray(json: string | null | undefined): unknown[] {
  try {
    const v = JSON.parse(json || '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function parseSourceFiles(run: ImportRun): SourceFileRef[] {
  return safeParseArray(run.sourceFiles) as SourceFileRef[]
}

/** Serialize run để trả về client (không lộ token — token không nằm ở đây) */
export function serializeRun(run: ImportRun) {
  return {
    id: run.id,
    jobId: run.jobId,
    jobName: run.jobName,
    sapDatabaseId: run.sapDatabaseId,
    status: run.status,
    sourceFiles: parseSourceFiles(run),
    canonicalRef: run.canonicalRef,
    decisions: safeParseArray(run.decisions),
    createdKeys: safeParseArray(run.createdKeys),
    crossChecksSummary: run.crossChecksSummary ? safeParse(run.crossChecksSummary) : null,
    startedBy: run.startedBy,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  }
}

function safeParse(json: string | null | undefined): unknown {
  try {
    return JSON.parse(json || 'null')
  } catch {
    return null
  }
}

/** Đầu ngày hôm nay (giờ server) — cho idempotency run:{jobId}:{startedBy}:{date} */
export function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}
