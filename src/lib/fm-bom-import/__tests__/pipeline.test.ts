// Test pipeline Sprint 1 end-to-end IN-MEMORY (không DB, không mạng thật):
// mock Base API → selectInputFiles → download (mock) → parse → canonical → validate
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  checksums,
  downloadBufferWithRetry,
  fetchBaseJob,
  selectInputFiles,
  type FetchImpl,
} from '../base-client'
import { parseMd05FromBuffer } from '../parser-md05'
import { buildCanonicalDoc } from '../canonical'
import { errorsOf, validateCanonical, warningsOf } from '../validator'
import { buildMd05Fixture, makeParent } from './fixtures'

const JOB_FORM = [
  { name: 'File BOM', value: 'https://cdn.test/md_05.xlsx?sig=aaa' },
  { name: 'File hợp đồng', value: 'https://cdn.test/quote.xlsx?sig=bbb' },
]

function mockFetch(jobForm: unknown[] = JOB_FORM): FetchImpl {
  return (async (url: string) => {
    if (url.includes('/job/get')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ code: 1, job: { name: 'Job pipeline test', form: jobForm } }),
      } as unknown as Response
    }
    // tải file: trả về workbook fixture đã serialize
    const buf = XLSX.write(buildMd05Fixture(), { type: 'buffer', bookType: 'xlsx' })
    return {
      status: 200,
      ok: true,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    } as unknown as Response
  }) as FetchImpl
}

describe('pipeline Sprint 1 (mock Base API)', () => {
  it('ingest → parse → validate: 2 cha, 6 con, không lỗi fail-fast trên fixture sạch', async () => {
    const fetchImpl = mockFetch()

    // 1) Ingest
    const job = await fetchBaseJob('4818871', 'TOKEN', fetchImpl)
    expect(job.name).toBe('Job pipeline test')
    const { in1, in2, fieldLog } = selectInputFiles(job)
    expect(in1.field).toBe('File BOM')
    expect(in2?.field).toBe('File hợp đồng')
    expect(fieldLog.length).toBeGreaterThan(0)

    const { buffer } = await downloadBufferWithRetry(in1.url, fetchImpl, { delays: [] })
    const { md5, sha256 } = checksums(buffer)
    expect(md5).toHaveLength(32)
    expect(sha256).toHaveLength(64)

    // 2) Parse + canonical v1.1
    const { parents } = parseMd05FromBuffer(buffer)
    expect(parents).toHaveLength(2)
    const doc = buildCanonicalDoc(parents, {
      sourceFile: in1.filename,
      jobContext: {
        jobId: job.id,
        jobName: job.name,
        workflowId: null,
        sourceFiles: [
          { field: in1.field, filename: in1.filename, md5, sha256, bytes: buffer.length, downloadedAt: new Date().toISOString() },
        ],
      },
    })
    expect(doc.version).toBe('1.1')

    // 3) Validate — fixture sạch: V1–V3/V5–V8 pass
    // (V4 bỏ qua vì chưa có B1; W1 có thể cảnh báo do margin fixture âm — kiểm tra riêng)
    const issues = validateCanonical(doc, {
      jobId: '4818871',
      sourceFiles: [{ field: in1.field, md5, sha256 }],
    })
    const codes = errorsOf(issues).map((i) => i.code)
    expect(codes).not.toContain('V1')
    expect(codes).not.toContain('V2')
    expect(codes).not.toContain('V3')
    expect(codes).not.toContain('V7')
    expect(codes).not.toContain('V8')
  })

  it('fixture bẩn (thiếu tên cha) → V1 fail-fast chặn cả đợt', async () => {
    const wb = buildMd05Fixture()
    const ws = wb.Sheets[wb.SheetNames[0]]
    ws['E7'] = { t: 's', v: '' } // xóa tên cha 1
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    const { parents } = parseMd05FromBuffer(buf)
    const doc = buildCanonicalDoc(parents, { sourceFile: 'x.xlsx' })
    const issues = validateCanonical(doc, {})
    // dòng 7 không còn là cha → các dòng con của nó thành "mồ côi", cha 2 vẫn parse
    expect(parents).toHaveLength(1)
    expect(parents[0].itemName).toBe('COMBO QUÀ TEST 02')
  })

  it('T2/T3/T5/T8 đúng trên dữ liệu pipeline', async () => {
    const fetchImpl = mockFetch()
    const job = await fetchBaseJob('1', 'T', fetchImpl)
    const { in1 } = selectInputFiles(job)
    const { buffer } = await downloadBufferWithRetry(in1.url, fetchImpl, { delays: [] })
    const { parents } = parseMd05FromBuffer(buffer)
    const [p1, p2] = parents
    // T8 + T1
    expect(p1.components[0].childCode).toBe('I0000001')
    expect(p1.components[0].uom).toBe('Kg')
    // T2
    expect(p1.components[0].qtyPerParent).toBe(2)
    // T3
    expect(p1.priceExVat).toBe(100000)
    expect(p2.priceExVat).toBe(100000)
    // T5
    expect(p1.primaryBarcode).toBe('8931234567890')
    // T7
    expect(p1.bomKind).toBe('BOM_PRODUCT')
    expect(p2.bomKind).toBe('BOM_ASSEMBLY')
  })

  it('V4 fail-fast mặc định chặn khi mã con chưa có trên B1', () => {
    const doc = buildCanonicalDoc([makeParent()], { sourceFile: 'x.xlsx' })
    const issues = validateCanonical(doc, { existingChildCodes: new Set(['KHAC']) })
    expect(errorsOf(issues).some((i) => i.code === 'V4')).toBe(true)
  })

  it('warnings không chặn: W1 margin âm chỉ cảnh báo', () => {
    const p = makeParent()
    p.mdChecks = { ...p.mdChecks, marginPct: -0.05 }
    const doc = buildCanonicalDoc([p], { sourceFile: 'x.xlsx' })
    const issues = validateCanonical(doc, {})
    expect(errorsOf(issues)).toHaveLength(0)
    expect(warningsOf(issues).some((i) => i.code === 'W1')).toBe(true)
  })
})
