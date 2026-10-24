import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'
import { mySalesPersonCode } from '@/lib/user-sales-person'

// ============================================================
// GET /api/sales-persons → [{ code, name }]
// Danh sách nhân viên bán hàng ĐANG HOẠT ĐỘNG của DB hiện tại (+ mine) —
// dùng cho dropdown chọn NVBH (SAP SalesPersonCode) trong form
// chứng từ. Nguồn: mirror /SalesPersons (OSLP) đồng bộ tại
// POST /api/sales-persons/sync.
// ============================================================

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  // Danh mục chỉ gồm mã + tên → cho cả người tạo/sửa chứng từ bán hàng (dropdown NVBH)
  const P = user.permissions
  const docKeys = ['ordersNew', 'quotations', 'invoices', 'creditMemos', 'returns', 'downPayments', 'deliveries'] as const
  const canUse = P.settings?.view || docKeys.some((k) => P[k]?.create || P[k]?.edit)
  if (!canUse) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục nhân viên bán hàng' }, { status: 403 })
  }

  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null

  const rows = await prisma.salesPerson.findMany({
    where: { active: true, ...(dbId ? { sapDatabaseId: dbId } : {}) },
    select: { code: true, name: true },
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({
    data: rows.map((r) => ({ code: r.code, name: r.name })),
    // NVKD gắn với user ở DB này (màn Người dùng) → form chứng từ mới tự điền
    mine: await mySalesPersonCode(user.id, dbId),
  })
}
