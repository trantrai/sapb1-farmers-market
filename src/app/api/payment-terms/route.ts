import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings } from '@/lib/sap-service-layer'

// ============================================================
// GET /api/payment-terms → [{ code, name }]
// Danh sách điều khoản thanh toán của DB hiện tại — dùng cho
// dropdown chọn ĐKTT (SAP PaymentGroupCode) trong form chứng từ.
// Nguồn: mirror /PaymentTermsTypes (OCTG) đồng bộ tại
// POST /api/payment-terms/sync.
// ============================================================

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem danh mục điều khoản thanh toán' }, { status: 403 })
  }

  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null

  const rows = await prisma.paymentTerm.findMany({
    where: dbId ? { sapDatabaseId: dbId } : {},
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  })

  return NextResponse.json({
    data: rows.map((r) => ({ code: r.code, name: r.name })),
  })
}
