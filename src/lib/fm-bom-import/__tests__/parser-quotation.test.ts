// Test parse workbook báo giá 3 sheet (F19)
// Fixture TỔNG HỢP — không copy dữ liệu thật công ty.
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseQuotationWorkbook } from '../parser-quotation'

/** Dựng workbook báo giá mẫu: 2 set + bảng tổng hợp HĐ + Final Cost + lịch giao */
function buildQuotationFixture(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()

  const quote: unknown[][] = [
    ['Công Ty TNHH Thương Mại TEST'],
    ['BẢNG BÁO GIÁ'],
    [],
    [null, null, 'Set 1'],
    ['STT', 'BARCODE', 'ITEMCODE', 'TÊN SẢN PHẨM', 'Đơn vị tính', 'ĐƠN GIÁ\n(-vat)', 'VAT', 'CHIẾT KHẤU', 'ĐƠN GIÁ SAU CK\n(-VAT)', 'SỐ LƯỢNG', 'THÀNH TIỀN\n(-vat)'],
    [1, '8930000000001', 'T0000001', 'Hộp quà test', 'Cái', 100000, 0.08, 0, 100000, 1, 100000],
    [2, '8930000000002', 'T0000002', 'Táo test', 'Kg', 50000, 0.05, 0.1, 45000, 2, 90000],
    [null, null, null, 'GIÁ TRỊ SET QUÀ (chưa bao gồm VAT)', null, null, null, null, null, 1, 190000],
    [null, null, null, 'THUẾ VAT', null, null, 0.05, null, null, null, 4500],
    [null, null, null, 'THUẾ VAT', null, null, 0.08, null, null, null, 8000],
    [null, null, null, 'TỔNG GIÁ TRỊ PHẦN QUÀ (đã bao gồm VAT)', null, null, null, null, null, 1, 202500],
    [null, null, null, 'TỔNG GIÁ TRỊ ĐƠN HÀNG QUÀ (đã bao gồm VAT)', null, null, null, null, null, 3, 607500],
    [],
    [null, null, 'Set 2'],
    ['STT', 'BARCODE', 'ITEMCODE', 'TÊN SẢN PHẨM', 'Đơn vị tính', 'ĐƠN GIÁ\n(-vat)', 'VAT', 'CHIẾT KHẤU', 'ĐƠN GIÁ SAU CK\n(-VAT)', 'SỐ LƯỢNG', 'THÀNH TIỀN\n(-vat)'],
    [1, '8930000000003', 'T0000003', 'Nho test', 'Kg', 200000, 0.05, 0, 200000, 1, 200000],
    [null, null, null, 'GIÁ TRỊ SET QUÀ (chưa bao gồm VAT)', null, null, null, null, null, 1, 200000],
    [null, null, null, 'TỔNG GIÁ TRỊ PHẦN QUÀ (đã bao gồm VAT)', null, null, null, null, null, 1, 210000],
    [],
    [null, null, 'III. TỔNG GIÁ TRỊ HỢP ĐỒNG'],
    ['STT', null, 'MÃ HÀNG', 'TÊN SẢN PHẨM', 'Đơn vị tính', 'ĐƠN GIÁ\n(-vat)', null, 'VAT', null, 'Số lượng', 'THÀNH TIỀN\n(-vat)'],
    [1, null, 'SET 1', 'Set 1 nhóm thuế 5%', 'Phần', 180000, null, 0.05, null, 3, 540000],
    [2, null, 'SET 2', 'Set 2 nhóm thuế 8%', 'Phần', 200000, null, 0.08, null, 2, 400000],
    ['TỔNG GIÁ TRỊ HỢP ĐỒNG CHƯA VAT', null, null, null, null, null, null, null, null, 940000],
    ['THUẾ VAT', null, null, null, null, null, null, 0.05, null, 27000],
    ['TỔNG GIÁ TRỊ HỢP ĐỒNG CÓ VAT', null, null, null, null, null, null, null, null, 992000],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(quote), 'BẢNG BÁO GIÁ')

  const delivery: unknown[][] = [
    [],
    ['LỊCH GIAO HÀNG'],
    ['Phòng Ban', 'Ngày', 'Giỏ trái cây', 'Số lượng', 'Địa chỉ nhận', 'Người nhận', 'Thời gian nhận hàng'],
    ['PHÒNG TEST', '16/10/2026', 'SET 1', 2, '123 Đường Test', 'Người Test', '8h sáng'],
    ['PHÒNG TEST', '17/10/2026', 'SET 2', 3, '123 Đường Test', 'Người Test', '8h sáng'],
    [null, 'Tổng', null, 5],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(delivery), 'LỊCH GIAO HÀNG ') // có dấu cách cuối như file thật

  const costing: unknown[][] = [
    [],
    ['Stt', 'Mã hàng', 'Barcode', 'TÊN CÔNG THỨC', 'ĐVT GHI NHẬN', 'GIÁ VỐN CHƯA VAT', 'GIÁ BÁN FINAL (-VAT)', 'GIÁ BÁN FINAL (+VAT)', 'MARGIN'],
    [1, 'T0000001', '8930000000001', 'Hộp quà test', 'Cái', 60000, 100000, 108000, 0.4],
    [2, 'T0000002', '8930000000002', 'Táo test', 'Kg', 30000, 50000, 52500, 0.4],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(costing), 'Final Cost')

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['junk']]), 'Đề xuất tạo BOM')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['junk']]), 'chính sách chiết khấu')
  return wb
}

describe('F19 — parse BẢNG BÁO GIÁ', () => {
  it('parse đúng 2 set + dòng hàng + subtotal', () => {
    const q = parseQuotationWorkbook(buildQuotationFixture())
    expect(q.sets).toHaveLength(2)
    expect(q.sets[0].name).toBe('Set 1')
    expect(q.sets[0].lines).toHaveLength(2)
    expect(q.sets[0].lines[0].itemCode).toBe('T0000001')
    expect(q.sets[0].lines[1].discountPct).toBe(0.1)
    expect(q.sets[0].lines[1].priceAfterDiscountExVat).toBe(45000)
    expect(q.sets[0].subtotalExVat).toBe(190000)
    expect(q.sets[0].vatRows).toHaveLength(2)
    expect(q.sets[0].totalIncVat).toBe(202500)
    expect(q.sets[0].orderTotal).toBe(607500)
    expect(q.sets[1].name).toBe('Set 2')
    expect(q.sets[1].lines).toHaveLength(1)
  })
  it('bảng tổng hợp HĐ: summary lines + tổng chưa/có VAT', () => {
    const q = parseQuotationWorkbook(buildQuotationFixture())
    expect(q.contractTotals).not.toBeNull()
    expect(q.contractTotals!.summaryLines).toHaveLength(2)
    expect(q.contractTotals!.summaryLines[0].itemCode).toBe('SET 1')
    expect(q.contractTotals!.summaryLines[0].qty).toBe(3)
    expect(q.contractTotals!.totalExVat).toBe(940000)
    expect(q.contractTotals!.totalIncVat).toBe(992000)
    expect(q.contractTotals!.vatByRate).toHaveLength(1)
    expect(q.contractTotals!.vatByRate[0].rate).toBe(0.05)
  })
})

describe('F19 — parse Final Cost + LỊCH GIAO HÀNG', () => {
  it('costing: đúng số dòng + margin', () => {
    const q = parseQuotationWorkbook(buildQuotationFixture())
    expect(q.costing).toHaveLength(2)
    expect(q.costing[0].itemCode).toBe('T0000001')
    expect(q.costing[0].costExVat).toBe(60000)
    expect(q.costing[0].margin).toBe(0.4)
  })
  it('lịch giao: parse ngày VN + bỏ dòng Tổng (chịu được tên sheet có dấu cách cuối)', () => {
    const q = parseQuotationWorkbook(buildQuotationFixture())
    expect(q.deliverySchedule).toHaveLength(2)
    expect(q.deliverySchedule[0].date).toBe('2026-10-16')
    expect(q.deliverySchedule[0].setName).toBe('SET 1')
    expect(q.deliverySchedule[0].qty).toBe(2)
    expect(q.deliverySchedule[1].date).toBe('2026-10-17')
  })
  it('2 sheet không liên quan → skippedSheets', () => {
    const q = parseQuotationWorkbook(buildQuotationFixture())
    expect(q.skippedSheets).toContain('Đề xuất tạo BOM')
    expect(q.skippedSheets).toContain('chính sách chiết khấu')
  })
})
