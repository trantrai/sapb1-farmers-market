import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'

// ============================================================
// GET /api/sales-persons → [{ code, name }]
// Danh sách nhân viên bán hàng ĐANG HOẠT ĐỘNG của DB hiện tại —
// dùng cho dropdown chọn NVBH (SAP SalesPersonCode) trong form
// chứng từ. Nguồn: mirror /SalesPersons (OSLP) đồng bộ tại
// POST /api/sales-persons/sync.
// ============================================================

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
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
  })
}
