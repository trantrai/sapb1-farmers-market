// ============================================================
// FARMERS MARKET — Import BOM: tầng Ingestion (F18)
// - POST workflow.base.vn/extapi/v1/job/get (param `id`, token
//   `access_token_v2` qua query param, body POST không rỗng — tránh 411)
// - Duyệt job.form[] lấy 2 file theo input contract (ADR-006, NQ6)
// - Tải signed URL ngay (hết hạn ~30 phút), retry 3 lần 1s→2s→4s
// - md5/sha256 + idempotency ingest:{jobId}:{field}:{md5} (ADR-007)
// ============================================================

import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { BASE_WORKFLOW_BASE_URL, BASE_JOB_GET_PATH } from '../fm-base'

export class BaseApiError extends Error {
  status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'BaseApiError'
    this.status = status
  }
}

/** HTTP 429 — hard-stop cho run hiện tại (không retry) */
export class BaseRateLimitedError extends BaseApiError {
  constructor(message = 'Base API giới hạn tần suất (429) — dừng ingestion') {
    super(message, 429)
    this.name = 'BaseRateLimitedError'
  }
}

/** File trên đĩa đã đổi so với lúc tải (V8 / E_INGEST_CHANGED) */
export class IngestChangedError extends Error {
  constructor(message = 'File đã thay đổi sau khi tải (E_INGEST_CHANGED) — hủy run, hãy tạo run mới') {
    super(message)
    this.name = 'IngestChangedError'
  }
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface BaseFormField {
  name?: string
  value?: unknown
  [k: string]: unknown
}

export interface BaseJob {
  id: string
  name: string
  workflowId?: string
  form: BaseFormField[]
  raw: unknown
}

export interface SelectedFile {
  /** IN-1 | IN-2 */
  input: 'IN-1' | 'IN-2'
  /** Tên field trên Base job đã dùng (theo NQ6) */
  field: string
  filename: string
  url: string
}

export interface SourceFileRef {
  /** IN-1 (File BOM, master) | IN-2 (workbook báo giá, reference) */
  input: 'IN-1' | 'IN-2'
  field: string
  filename: string
  /** Đường dẫn tương đối từ thư mục data/bom-import (vd "4818871/File BOM_md_05.xlsx") */
  relPath: string
  md5: string
  sha256: string
  bytes: number
  downloadedAt: string
}

// ---------- Thư mục lưu file ----------

/** Thư mục gốc chứa file BOM đã tải (Windows-safe). Tạo khi cần. */
export function getBomImportDir(): string {
  return path.join(process.cwd(), 'data', 'bom-import')
}

export function getJobDir(jobId: string): string {
  return path.join(getBomImportDir(), sanitizeFilename(jobId))
}

/** Tên file an toàn cho Windows (bỏ <>:"/\|?* và ký tự điều khiển) */
export function sanitizeFilename(name: string): string {
  return (name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file'
}

// ---------- Gọi Base API ----------

/**
 * POST /extapi/v1/job/get — đã verify 2026-10-16:
 * param `id` (không phải `job_id`), token qua query param `access_token_v2`,
 * body form-urlencoded không rỗng.
 */
export async function fetchBaseJob(
  jobId: string,
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<BaseJob> {
  if (!token) throw new BaseApiError('Chưa cấu hình Base Access Token v2 (vào Cài đặt để nhập)')
  const url =
    `${BASE_WORKFLOW_BASE_URL}${BASE_JOB_GET_PATH}` +
    `?access_token_v2=${encodeURIComponent(token)}`
  const body = new URLSearchParams({ id: String(jobId) }).toString()
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (e) {
    throw new BaseApiError(`Không kết nối được Base Workflow API: ${(e as Error).message}`)
  }
  if (res.status === 429) throw new BaseRateLimitedError()
  if (!res.ok) throw new BaseApiError(`Base API lỗi HTTP ${res.status}`, res.status)
  let json: any
  try {
    json = await res.json()
  } catch {
    throw new BaseApiError('Base API trả về không phải JSON')
  }
  if (json?.code !== 1 || !json?.job) {
    throw new BaseApiError(`Base API báo lỗi: ${json?.message || 'không rõ'} (code ${json?.code})`)
  }
  const job = json.job
  const form = Array.isArray(job.form) ? job.form : []
  return {
    id: String(jobId),
    name: String(job.name ?? job.title ?? ''),
    workflowId: job.workflow_id != null ? String(job.workflow_id) : undefined,
    form,
    raw: json,
  }
}

// ---------- Chọn 2 file theo input contract ----------

const IN1_MATCH = 'file bom'
/** Thứ tự ưu tiên IN-2 (NQ6) */
const IN2_PRIORITY = ['hợp đồng', 'duyệt giá', 'thiết kế', 'tạo customer']

function isFileValue(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim())
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop() || ''
    const clean = last.split('?')[0]
    return sanitizeFilename(decodeURIComponent(clean) || 'file.xlsx')
  } catch {
    return 'file.xlsx'
  }
}

/**
 * Duyệt job.form[] lấy 2 file (ADR-006):
 * - IN-1 "File BOM": bắt buộc, field đầu tiên có tên chứa "file bom" và value là URL.
 * - IN-2 workbook báo giá: tùy chọn, ưu tiên field "File hợp đồng" (NQ6),
 *   rồi "Duyệt Giá" → "Thiết kế" → "tạo Customer"; field khác trỏ file khác
 *   chỉ ghi log cảnh báo (không dùng).
 */
export function selectInputFiles(job: BaseJob): {
  in1: SelectedFile
  in2: SelectedFile | null
  fieldLog: string[]
} {
  const fieldLog: string[] = []
  const fileFields = (job.form || []).filter(
    (f): f is BaseFormField & { value: string } =>
      typeof f?.name === 'string' && isFileValue(f.value),
  )

  const norm = (s: string) => s.trim().toLowerCase()
  const in1Field = fileFields.find((f) => norm(String(f.name)).includes(IN1_MATCH))
  if (!in1Field) {
    throw new BaseApiError(
      `Job ${job.id} không có field "File BOM" (IN-1 bắt buộc) — kiểm tra lại job trên Base`,
    )
  }
  const in1: SelectedFile = {
    input: 'IN-1',
    field: String(in1Field.name),
    filename: filenameFromUrl(in1Field.value),
    url: in1Field.value.trim(),
  }
  fieldLog.push(`IN-1 dùng field "${in1.field}"`)

  let in2: SelectedFile | null = null
  for (const key of IN2_PRIORITY) {
    const f = fileFields.find((x) => norm(String(x.name)).includes(key))
    if (f) {
      in2 = {
        input: 'IN-2',
        field: String(f.name),
        filename: filenameFromUrl(f.value),
        url: f.value.trim(),
      }
      fieldLog.push(`IN-2 dùng field "${in2.field}" (ưu tiên NQ6)`)
      break
    }
  }
  // Các field file còn lại trỏ URL khác → chỉ cảnh báo (NQ6)
  const usedUrls = new Set([in1.url, ...(in2 ? [in2.url] : [])])
  for (const f of fileFields) {
    const u = (f.value as string).trim()
    if (!usedUrls.has(u)) {
      fieldLog.push(`Cảnh báo: field "${f.name}" trỏ file khác — bỏ qua (NQ6)`)
    }
  }
  return { in1, in2, fieldLog }
}

// ---------- Tải file + checksum ----------

export interface DownloadOptions {
  /** Khoảng nghỉ giữa các lần retry (ms). Mặc định [1000, 2000, 4000] */
  delays?: number[]
  timeoutMs?: number
}

export function checksums(buffer: Buffer): { md5: string; sha256: string } {
  return {
    md5: createHash('md5').update(buffer).digest('hex'),
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Tải signed URL về Buffer. Retry 3 lần giãn cách 1s→2s→4s;
 * 429 là hard-stop (không retry). Lỗi cuối → throw, caller đánh dấu run failed
 * và KHÔNG dùng file dở (file dở chỉ lưu với hậu tố .partial khi ghi đĩa).
 */
export async function downloadBufferWithRetry(
  url: string,
  fetchImpl: FetchImpl = fetch,
  opts: DownloadOptions = {},
): Promise<{ buffer: Buffer; bytes: number }> {
  const delays = opts.delays ?? [1000, 2000, 4000]
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000)
      let res: Response
      try {
        res = await fetchImpl(url, { signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
      if (res.status === 429) throw new BaseRateLimitedError()
      if (!res.ok) throw new BaseApiError(`Tải file lỗi HTTP ${res.status}`, res.status)
      const ab = await res.arrayBuffer()
      const buffer = Buffer.from(ab)
      if (buffer.length === 0) throw new BaseApiError('File tải về rỗng (0 byte)')
      return { buffer, bytes: buffer.length }
    } catch (e) {
      if (e instanceof BaseRateLimitedError) throw e
      lastErr = e
      if (attempt < delays.length) await sleep(delays[attempt])
    }
  }
  throw lastErr instanceof Error ? lastErr : new BaseApiError('Tải file thất bại sau 3 lần thử')
}

/** Ghi buffer xuống đĩa: <jobDir>/<field>_<filename> */
export async function saveDownloadedFile(
  jobDir: string,
  field: string,
  filename: string,
  buffer: Buffer,
): Promise<{ relPath: string; absPath: string }> {
  await fs.mkdir(jobDir, { recursive: true })
  const safeName = `${sanitizeFilename(field)}_${sanitizeFilename(filename)}`
  const absPath = path.join(jobDir, safeName)
  await fs.writeFile(absPath, buffer)
  const relPath = path.relative(getBomImportDir(), absPath).split(path.sep).join('/')
  return { relPath, absPath }
}

/** Ghi file tải dở (đánh dấu .partial — không bao giờ dùng để parse) */
export async function savePartialFile(jobDir: string, field: string, filename: string): Promise<void> {
  try {
    await fs.mkdir(jobDir, { recursive: true })
    const safeName = `${sanitizeFilename(field)}_${sanitizeFilename(filename)}.partial`
    await fs.writeFile(path.join(jobDir, safeName), '')
  } catch {
    /* best-effort */
  }
}

// ---------- Idempotency ----------

/** Key idempotency ingestion: ingest:{jobId}:{field}:{md5} */
export function buildIngestKey(jobId: string, field: string, md5: string): string {
  return `ingest:${jobId}:${field}:${md5}`
}

/**
 * Tìm file đã ingest trước đó (cùng job + field + md5) trong các run cũ
 * → bỏ qua tải lại, dùng file đã lưu (F18 acceptance).
 */
export function findIngestedFile(
  priorRuns: { sourceFiles: SourceFileRef[] }[],
  jobId: string,
  field: string,
  md5: string,
): SourceFileRef | null {
  void jobId
  for (const run of priorRuns) {
    const hit = (run.sourceFiles || []).find((s) => s.field === field && s.md5 === md5)
    if (hit) return hit
  }
  return null
}

/**
 * Verify lại checksum file trên đĩa trước mỗi bước tiếp theo (V8).
 * Lệch → throw IngestChangedError (E_INGEST_CHANGED), abort run.
 */
export async function verifySourceFiles(
  sourceFiles: SourceFileRef[],
  baseDir: string = getBomImportDir(),
): Promise<void> {
  const base = baseDir
  for (const sf of sourceFiles) {
    const abs = path.join(base, ...sf.relPath.split('/'))
    let buf: Buffer
    try {
      buf = await fs.readFile(abs)
    } catch {
      throw new IngestChangedError(`Không đọc được file đã tải: ${sf.relPath}`)
    }
    const { md5, sha256 } = checksums(buf)
    if (md5 !== sf.md5 || sha256 !== sf.sha256) {
      throw new IngestChangedError(`Checksum lệch cho file ${sf.relPath}`)
    }
  }
}
