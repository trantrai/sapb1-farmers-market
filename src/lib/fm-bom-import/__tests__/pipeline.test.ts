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

describe('pipeline Sprint 2 (F19 + F5 + F4, in-memory)', () => {
  /** Workbook báo giá mini: set "Set 1" để gán tay cho cha 1 của MD_05 fixture */
  function buildQuoteFixture(): XLSX.WorkBook {
    const wb = XLSX.utils.book_new()
    const quote: unknown[][] = [
      [null, null, 'Set 1'],
      ['STT', 'BARCODE', 'ITEMCODE', 'TÊN SẢN PHẨM', 'Đơn vị tính', 'ĐƠN GIÁ\n(-vat)', 'VAT', 'CHIẾT KHẤU', 'ĐƠN GIÁ SAU CK\n(-VAT)', 'SỐ LƯỢNG', 'THÀNH TIỀN\n(-vat)'],
      [1, 'B1', 'I0000001', 'Táo test', 'Kg', 50000, 0.05, 0, 50000, 2, 100000],
      [null, null, null, 'GIÁ TRỊ SET QUÀ (chưa bao gồm VAT)', null, null, null, null, null, 1, 100000],
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(quote), 'BẢNG BÁO GIÁ')
    const costing: unknown[][] = [
      ['Stt', 'Mã hàng', 'Barcode', 'TÊN CÔNG THỨC', 'ĐVT GHI NHẬN', 'GIÁ VỐN CHƯA VAT', 'GIÁ BÁN FINAL (-VAT)', 'GIÁ BÁN FINAL (+VAT)', 'MARGIN'],
      [1, 'I0000001', 'B1', 'Táo test', 'Kg', 30000, 50000, 52500, 0.4],
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(costing), 'Final Cost')
    return wb
  }

  it('MD_05 + báo giá → canonical v1.1 có quotation/costing → W7/W9 + crossChecks + sinh mã', async () => {
    // Parse MD_05
    const mdBuf = XLSX.write(buildMd05Fixture(), { type: 'buffer', bookType: 'xlsx' })
    const { parents } = parseMd05FromBuffer(mdBuf)
    expect(parents).toHaveLength(2)

    // Parse báo giá (F19)
    const qBuf = XLSX.write(buildQuoteFixture(), { type: 'buffer', bookType: 'xlsx' })
    const { parseQuotationFromBuffer } = await import('../parser-quotation')
    const { generateParentCodes } = await import('../parent-codes')
    const { buildCrossChecks, linkParentToSet } = await import('../validator')
    const q = parseQuotationFromBuffer(qBuf)
    expect(q.sets).toHaveLength(1)
    expect(q.sets[0].name).toBe('Set 1')
    expect(q.sets[0].subtotalExVat).toBe(100000)
    expect(q.costing).toHaveLength(1)

    // Canonical v1.1 gắn quotation
    const doc = buildCanonicalDoc(parents, { sourceFile: 'md05.xlsx' })
    doc.quotation = {
      sets: q.sets,
      contractTotals: q.contractTotals,
      deliverySchedule: q.deliverySchedule,
    }
    doc.costing = q.costing

    // Link NQ4: tên không chứa nhau → null; gán tay ở preview (manualLinks)
    const rowNo1 = parents[0].rowNo
    expect(linkParentToSet(parents[0], q.sets).set).toBeNull()
    const manualLinks = { [rowNo1]: 'Set 1' }
    expect(linkParentToSet(parents[0], q.sets, manualLinks).set?.name).toBe('Set 1')

    // Validate bật W7/W8/W9 (Sprint 2) với link tay
    const issues = validateCanonical(doc, {
      quotationSets: q.sets,
      costing: q.costing,
      manualLinks,
      requireQuotationLink: false,
    })
    // cha 1 đã link tay → W9 phủ dòng (I0000001 khớp; các con khác thiếu ở báo giá)
    const w9 = warningsOf(issues).filter(
      (i) => i.code === 'W9' && i.field === 'components' && i.rowNo === rowNo1,
    )
    expect(w9.length).toBeGreaterThan(0)
    expect(w9[0].message).toContain('I0000002')

    // crossChecks cho panel đối chiếu (có link tay)
    const cc = buildCrossChecks(doc, { sets: q.sets, costing: q.costing }, { manualLinks })
    expect(cc.some((c) => c.check === 'W7' && c.rowNo === rowNo1)).toBe(true)
    expect(cc.some((c) => c.check === 'W9' && c.rowNo === rowNo1)).toBe(true)
    expect(cc.find((c) => c.check === 'W7' && c.rowNo === rowNo1)?.linkAuto).toBe(false)

    // Sinh mã Q1 (F4)
    const { codes } = await generateParentCodes('CB-202610-0007', {
      count: parents.length,
      exists: () => false,
    })
    expect(codes).toEqual(['CB-202610-0007', 'CB-202610-0008'])
  })
})
