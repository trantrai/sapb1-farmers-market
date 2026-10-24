import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// ---------- GET /api/app-config ----------
// Thiết lập hiển thị dùng chung cho form/chi tiết chứng từ. Người lên đơn không
// có quyền xem Cài đặt → endpoint riêng, chỉ trả các cờ hiển thị (không bí mật).
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  const s = await prisma.appSettings.findUnique({ where: { id: 'main' }, select: { showBomProductionChildren: true } })
  return NextResponse.json({ ok: true, showBomProductionChildren: s?.showBomProductionChildren ?? false })
}
