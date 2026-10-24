// ============================================================
// Kiểm tra bắt buộc ở server khi lưu đơn: ngày + mặt hàng trong danh mục
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const prisma = vi.hoisted(() => ({ item: { findMany: vi.fn(), count: vi.fn() } }))
vi.mock('@/lib/db', () => ({ db: prisma }))

import { checkOrderDates, checkOrderItems } from '@/lib/order-server-check'

describe('checkOrderDates', () => {
  it('hợp lệ / ngày giao trước ngày chứng từ / ngày sai định dạng', () => {
    expect(checkOrderDates('2026-10-23', '2026-10-23')).toBeNull()
    expect(checkOrderDates('2026-10-23T00:00:00Z', '2026-10-25')).toBeNull()
    expect(checkOrderDates('2026-10-23', '2026-10-20')).toMatch(/20\/10\/2026 trước ngày chứng từ 23\/10\/2026/)
    expect(checkOrderDates('abc', '2026-10-20')).toMatch(/Ngày chứng từ không hợp lệ/)
    expect(checkOrderDates('2026-10-23', '')).toMatch(/Ngày giao hàng không hợp lệ/)
  })
})

describe('checkOrderItems', () => {
  beforeEach(() => {
    prisma.item.findMany.mockReset()
    prisma.item.count.mockReset()
  })

  it('đủ mã trong danh mục → null; lọc theo DB + dữ liệu cũ chưa gán DB', async () => {
    prisma.item.findMany.mockResolvedValue([{ itemCode: 'A' }, { itemCode: 'B' }])
    expect(await checkOrderItems('db1', ['A', 'B', 'A'])).toBeNull()
    expect(prisma.item.findMany.mock.calls[0][0].where).toEqual({ sapDatabaseId: { in: ['db1', ''] }, itemCode: { in: ['A', 'B'] } })
  })

  it('thiếu mã → lỗi liệt kê mã', async () => {
    prisma.item.findMany.mockResolvedValue([{ itemCode: 'A' }])
    prisma.item.count.mockResolvedValue(500)
    expect(await checkOrderItems('db1', ['A', 'ZZ'])).toMatch(/Mặt hàng ZZ không có trong danh mục/)
  })

  it('danh mục DB còn trống (chưa đồng bộ) → không chặn', async () => {
    prisma.item.findMany.mockResolvedValue([])
    prisma.item.count.mockResolvedValue(0)
    expect(await checkOrderItems('db1', ['ZZ'])).toBeNull()
  })

  it('sửa đơn: mã đã có trong đơn được giữ dù danh mục đã gỡ', async () => {
    expect(await checkOrderItems('db1', ['OLD'], ['OLD'])).toBeNull()
    expect(prisma.item.findMany).not.toHaveBeenCalled()
  })
})
