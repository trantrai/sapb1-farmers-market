// Helper dùng chung cho API Import BOM
import type { ImportRun } from '@prisma/client'
import { promises as fs } from 'fs'
import path from 'path'
import type { SourceFileRef } from '@/lib/fm-bom-import/base-client'
import { getBomImportDir } from '@/lib/fm-bom-import/base-client'
import type { CanonicalDoc } from '@/lib/fm-bom-import/canonical'
import type { ManualLinks } from '@/lib/fm-bom-import/validator'
import type { ValidationIssue } from '@/lib/fm-bom-import/validator'

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

// ---------- Sidecar Sprint 2 ----------
// File <jobId>/<runId>.canonical.json giữ thêm state preview:
// manualLinks (gán tay parent↔set, NQ4), generatedCodes (mã cha Q1),
// approvedParents (gate 2), quotationWarnings.

export interface RunSidecar {
  savedAt: string
  canonical: CanonicalDoc
  issues: ValidationIssue[]
  validatedAt: string
  manualLinks: ManualLinks
  generatedCodes: Record<number, string>
  approvedParents: number[]
  quotationWarnings: string[]
}

export function sidecarPath(run: ImportRun): string {
  const rel = run.canonicalRef ?? `${run.jobId}/${run.id}.canonical.json`
  return path.join(getBomImportDir(), ...rel.split('/'))
}

export async function readSidecar(run: ImportRun): Promise<RunSidecar | null> {
  try {
    const raw = await fs.readFile(sidecarPath(run), 'utf-8')
    const data = JSON.parse(raw)
    return {
      savedAt: data.savedAt ?? '',
      canonical: data.canonical,
      issues: Array.isArray(data.issues) ? data.issues : [],
      validatedAt: data.validatedAt ?? '',
      manualLinks: data.manualLinks ?? {},
      generatedCodes: data.generatedCodes ?? {},
      approvedParents: Array.isArray(data.approvedParents) ? data.approvedParents : [],
      quotationWarnings: Array.isArray(data.quotationWarnings) ? data.quotationWarnings : [],
    }
  } catch {
    return null
  }
}

export async function writeSidecar(run: ImportRun, patch: Partial<RunSidecar>): Promise<RunSidecar | null> {
  const cur = await readSidecar(run)
  if (!cur) return null
  const next: RunSidecar = { ...cur, ...patch }
  await fs.writeFile(sidecarPath(run), JSON.stringify(next, null, 2))
  return next
}
