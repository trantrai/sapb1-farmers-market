// Test tầng Ingestion: chọn file, idempotency, retry, checksum (F18)
import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import {
  BaseApiError,
  BaseRateLimitedError,
  buildIngestKey,
  checksums,
  downloadBufferWithRetry,
  fetchBaseJob,
  findIngestedFile,
  IngestChangedError,
  sanitizeFilename,
  selectInputFiles,
  verifySourceFiles,
  type BaseJob,
  type FetchImpl,
} from '../base-client'

function jobWith(form: unknown[]): BaseJob {
  return { id: '4818871', name: 'Job test', form: form as never, raw: {} }
}

/** Mock Response tối giản */
function mockRes(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(String(body ?? '')).buffer as ArrayBuffer,
  } as unknown as Response
}

describe('selectInputFiles (ADR-006, NQ6)', () => {
  const form = [
    { name: 'File BOM', value: 'https://cdn.test/bom.xlsx?sig=1' },
    { name: 'File hợp đồng', value: 'https://cdn.test/quote.xlsx?sig=2' },
    { name: 'File xin Duyệt Giá', value: 'https://cdn.test/quote.xlsx?sig=2' },
    { name: 'Ghi chú', value: 'không phải file' },
  ]
  it('chọn đúng IN-1 (File BOM) và IN-2 (ưu tiên "File hợp đồng")', () => {
    const { in1, in2, fieldLog } = selectInputFiles(jobWith(form))
    expect(in1.input).toBe('IN-1')
    expect(in1.field).toBe('File BOM')
    expect(in2?.input).toBe('IN-2')
    expect(in2?.field).toBe('File hợp đồng')
    expect(fieldLog.length).toBeGreaterThan(0)
  })
  it('thiếu IN-1 → throw (bắt buộc)', () => {
    expect(() => selectInputFiles(jobWith([{ name: 'File hợp đồng', value: 'https://x/y.xlsx' }]))).toThrow(/File BOM/)
  })
  it('không có workbook báo giá → in2 = null', () => {
    const { in2 } = selectInputFiles(jobWith([{ name: 'File BOM', value: 'https://x/bom.xlsx' }]))
    expect(in2).toBeNull()
  })
  it('field file khác trỏ URL khác → cảnh báo trong fieldLog (NQ6)', () => {
    const { in2, fieldLog } = selectInputFiles(jobWith([
      { name: 'File BOM', value: 'https://x/bom.xlsx' },
      { name: 'File hợp đồng', value: 'https://x/quote.xlsx' },
      { name: 'File thiết kế', value: 'https://x/khac.xlsx' },
    ]))
    // "File hợp đồng" được ưu tiên làm IN-2; "File thiết kế" trỏ file khác → cảnh báo
    expect(in2?.field).toBe('File hợp đồng')
    expect(fieldLog.some((l) => l.includes('File thiết kế') && l.includes('bỏ qua'))).toBe(true)
  })
})

describe('idempotency', () => {
  it('buildIngestKey đúng format ingest:{jobId}:{field}:{md5}', () => {
    expect(buildIngestKey('4818871', 'File BOM', 'abc')).toBe('ingest:4818871:File BOM:abc')
  })
  it('findIngestedFile: trùng field+md5 → trả về ref; khác → null', () => {
    const ref = { input: 'IN-1' as const, field: 'File BOM', filename: 'a.xlsx', relPath: 'r/a.xlsx', md5: 'm1', sha256: 's1', bytes: 1, downloadedAt: '' }
    expect(findIngestedFile([{ sourceFiles: [ref] }], '4818871', 'File BOM', 'm1')).toEqual(ref)
    expect(findIngestedFile([{ sourceFiles: [ref] }], '4818871', 'File BOM', 'm2')).toBeNull()
    expect(findIngestedFile([{ sourceFiles: [ref] }], '4818871', 'File khác', 'm1')).toBeNull()
  })
})

describe('checksums', () => {
  it('md5/sha256 đúng cho buffer "abc"', () => {
    const { md5, sha256 } = checksums(Buffer.from('abc'))
    expect(md5).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('downloadBufferWithRetry', () => {
  it('thất bại 2 lần rồi thành công (retry 1s→2s→4s, test dùng delays ngắn)', async () => {
    let calls = 0
    const fetchImpl: FetchImpl = async () => {
      calls++
      if (calls < 3) throw new Error('network down')
      return mockRes(200, 'ok-content')
    }
    const { buffer, bytes } = await downloadBufferWithRetry('https://x/f.xlsx', fetchImpl, { delays: [1, 1, 1] })
    expect(calls).toBe(3)
    expect(bytes).toBeGreaterThan(0)
    expect(buffer.toString()).toBe('ok-content')
  })
  it('429 → BaseRateLimitedError ngay, không retry (hard-stop)', async () => {
    let calls = 0
    const fetchImpl: FetchImpl = async () => {
      calls++
      return mockRes(429)
    }
    await expect(downloadBufferWithRetry('https://x/f.xlsx', fetchImpl, { delays: [1, 1, 1] }))
      .rejects.toBeInstanceOf(BaseRateLimitedError)
    expect(calls).toBe(1)
  })
  it('thất bại cả 3 lần → throw lỗi cuối', async () => {
    const fetchImpl: FetchImpl = async () => { throw new Error('down') }
    await expect(downloadBufferWithRetry('https://x/f.xlsx', fetchImpl, { delays: [1, 1] }))
      .rejects.toThrow('down')
  })
})

describe('fetchBaseJob', () => {
  it('gọi đúng URL + body (token qua query param, param id, body không rỗng)', async () => {
    let gotUrl = ''
    let gotInit: RequestInit | undefined
    const fetchImpl: FetchImpl = async (url, init) => {
      gotUrl = url
      gotInit = init
      return mockRes(200, { code: 1, job: { name: 'Job ABC', form: [] } })
    }
    const job = await fetchBaseJob('4818871', 'TOKEN123', fetchImpl)
    expect(gotUrl).toContain('workflow.base.vn/extapi/v1/job/get')
    expect(gotUrl).toContain('access_token_v2=TOKEN123')
    expect(gotInit?.method).toBe('POST')
    expect(String(gotInit?.body)).toContain('id=4818871')
    expect(job.id).toBe('4818871')
    expect(job.name).toBe('Job ABC')
  })
  it('thiếu token → lỗi cấu hình', async () => {
    const fetchImpl: FetchImpl = async () => mockRes(200, {})
    await expect(fetchBaseJob('1', '', fetchImpl)).rejects.toThrow(/Access Token/)
  })
  it('code != 1 → BaseApiError kèm message', async () => {
    const fetchImpl: FetchImpl = async () => mockRes(200, { code: 0, message: 'Workflow is invalid' })
    await expect(fetchBaseJob('1', 'T', fetchImpl)).rejects.toThrow(/Workflow is invalid/)
  })
  it('429 → BaseRateLimitedError', async () => {
    const fetchImpl: FetchImpl = async () => mockRes(429)
    await expect(fetchBaseJob('1', 'T', fetchImpl)).rejects.toBeInstanceOf(BaseRateLimitedError)
  })
  it('HTTP 500 → BaseApiError', async () => {
    const fetchImpl: FetchImpl = async () => mockRes(500)
    const err = await fetchBaseJob('1', 'T', fetchImpl).catch((e) => e)
    expect(err).toBeInstanceOf(BaseApiError)
    expect((err as BaseApiError).status).toBe(500)
  })
})

describe('verifySourceFiles (V8 / E_INGEST_CHANGED)', () => {
  async function setupFile(content: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bomtest-'))
    const relPath = '4818871/test_file.xlsx'
    await fs.mkdir(path.join(dir, '4818871'), { recursive: true })
    await fs.writeFile(path.join(dir, relPath), Buffer.from(content))
    const { md5, sha256 } = checksums(Buffer.from(content))
    const ref = {
      input: 'IN-1' as const, field: 'File BOM', filename: 'test_file.xlsx',
      relPath, md5, sha256, bytes: content.length, downloadedAt: '',
    }
    return { dir, ref }
  }
  it('file khớp checksum → pass', async () => {
    const { dir, ref } = await setupFile('fake-xlsx-bytes')
    await expect(verifySourceFiles([ref], dir)).resolves.toBeUndefined()
    await fs.rm(dir, { recursive: true, force: true })
  })
  it('file bị sửa sau khi tải → IngestChangedError (E_INGEST_CHANGED)', async () => {
    const { dir, ref } = await setupFile('fake-xlsx-bytes')
    await fs.writeFile(path.join(dir, ref.relPath), Buffer.from('TAMPERED'))
    await expect(verifySourceFiles([ref], dir)).rejects.toBeInstanceOf(IngestChangedError)
    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('sanitizeFilename', () => {
  it('bỏ ký tự cấm Windows', () => {
    expect(sanitizeFilename('a<b>:"/\\|?*c')).toBe('a_b________c')
    expect(sanitizeFilename('  File BOM  ')).toBe('File BOM')
  })
})

describe('mock fetch call count (spy)', () => {
  it('fetchBaseJob chỉ gọi đúng 1 lần khi thành công', async () => {
    const spy = vi.fn(async () => mockRes(200, { code: 1, job: { name: 'J', form: [] } }))
    await fetchBaseJob('1', 'T', spy)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
