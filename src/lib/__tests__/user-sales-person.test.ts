// ============================================================
// Gắn người dùng ↔ NVKD theo DB SAP:
// - parseSlpAssignments: validate kiểu/trùng DB/mã
// - validateSlpAssignments: mã phải tồn tại + đang hoạt động trong đúng DB
//   (SalesPerson cũ chưa gán DB = thuộc DB mặc định)
// - mySalesPersonCode: NVKD ngừng hoạt động → null
// - withMySalesPerson / parseMySalesPerson: tự điền form chứng từ mới
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prisma = vi.hoisted(() => ({
  sapDatabase: { findUnique: vi.fn() },
  salesPerson: { findFirst: vi.fn() },
  userSalesPerson: { findUnique: vi.fn() },
}))
vi.mock('@/lib/db', () => ({ db: prisma }))
vi.mock('@/lib/sap-service-layer', () => ({ defaultDatabaseId: async () => 'db-default' }))

import { mySalesPersonCode, parseSlpAssignments, validateSlpAssignments } from '@/lib/user-sales-person'
import { parseMySalesPerson, withMySalesPerson } from '@/lib/sales-person-default'

describe('parseSlpAssignments', () => {
  it('không gửi → danh sách rỗng; code rỗng/null → bỏ gắn', () => {
    expect(parseSlpAssignments(undefined)).toEqual({ ok: true, data: [] })
    expect(parseSlpAssignments([{ databaseId: 'a', code: '' }, { databaseId: 'b', code: '7' }])).toEqual({
      ok: true,
      data: [{ databaseId: 'a', code: null }, { databaseId: 'b', code: 7 }],
    })
  })

  it('từ chối sai kiểu, thiếu DB, trùng DB, mã không phải số nguyên', () => {
    expect(parseSlpAssignments('x').ok).toBe(false)
    expect(parseSlpAssignments([{ code: 1 }]).ok).toBe(false)
    expect(parseSlpAssignments([{ databaseId: 'a', code: 1 }, { databaseId: 'a', code: 2 }]).ok).toBe(false)
    expect(parseSlpAssignments([{ databaseId: 'a', code: 1.5 }]).ok).toBe(false)
    expect(parseSlpAssignments([{ databaseId: 'a', code: 'abc' }]).ok).toBe(false)
  })
})

describe('validateSlpAssignments', () => {
  beforeEach(() => {
    prisma.sapDatabase.findUnique.mockReset()
    prisma.salesPerson.findFirst.mockReset()
  })

  it('DB không tồn tại → lỗi', async () => {
    prisma.sapDatabase.findUnique.mockResolvedValue(null)
    expect(await validateSlpAssignments([{ databaseId: 'x', code: 1 }])).toMatch(/không tồn tại/)
  })

  it('mã không thuộc DB / ngừng hoạt động → lỗi có tên DB', async () => {
    prisma.sapDatabase.findUnique.mockResolvedValue({ label: 'Kho HN' })
    prisma.salesPerson.findFirst.mockResolvedValue(null)
    expect(await validateSlpAssignments([{ databaseId: 'db-hn', code: 9 }])).toMatch(/mã 9 .*"Kho HN"/)
    expect(prisma.salesPerson.findFirst.mock.calls[0][0].where).toEqual({ code: 9, active: true, sapDatabaseId: 'db-hn' })
  })

  it('DB mặc định chấp nhận cả NVKD cũ chưa gán DB; bỏ gắn không tra NVKD', async () => {
    prisma.sapDatabase.findUnique.mockResolvedValue({ label: 'TESTDB' })
    prisma.salesPerson.findFirst.mockResolvedValue({ code: 3 })
    expect(await validateSlpAssignments([{ databaseId: 'db-default', code: 3 }, { databaseId: 'db-hn', code: null }])).toBeNull()
    expect(prisma.salesPerson.findFirst).toHaveBeenCalledTimes(1)
    expect(prisma.salesPerson.findFirst.mock.calls[0][0].where).toEqual({
      code: 3, active: true, OR: [{ sapDatabaseId: 'db-default' }, { sapDatabaseId: null }],
    })
  })
})

describe('mySalesPersonCode', () => {
  beforeEach(() => {
    prisma.userSalesPerson.findUnique.mockReset()
    prisma.salesPerson.findFirst.mockReset()
  })

  it('chưa gắn / không có DB → null', async () => {
    expect(await mySalesPersonCode('u1', null)).toBeNull()
    prisma.userSalesPerson.findUnique.mockResolvedValue(null)
    expect(await mySalesPersonCode('u1', 'db-hn')).toBeNull()
  })

  it('đã gắn + NVKD còn hoạt động → mã; ngừng hoạt động → null', async () => {
    prisma.userSalesPerson.findUnique.mockResolvedValue({ salesPersonCode: 5 })
    prisma.salesPerson.findFirst.mockResolvedValueOnce({ code: 5 }).mockResolvedValueOnce(null)
    expect(await mySalesPersonCode('u1', 'db-hn')).toBe(5)
    expect(await mySalesPersonCode('u1', 'db-hn')).toBeNull()
  })
})

describe('tự điền NVBH cho chứng từ mới', () => {
  it('parseMySalesPerson chỉ nhận số nguyên', () => {
    expect(parseMySalesPerson({ data: [], mine: 4 })).toBe(4)
    expect(parseMySalesPerson({ mine: null })).toBeNull()
    expect(parseMySalesPerson({ mine: '4' })).toBeNull()
    expect(parseMySalesPerson(null)).toBeNull()
  })

  it('withMySalesPerson chỉ điền khi ô đang trống', () => {
    expect(withMySalesPerson({ salesPersonCode: '' }, 4)).toEqual({ salesPersonCode: '4' })
    const chosen = { salesPersonCode: '7' }
    expect(withMySalesPerson(chosen, 4)).toBe(chosen)
    const empty = { salesPersonCode: '' }
    expect(withMySalesPerson(empty, null)).toBe(empty)
  })
})
