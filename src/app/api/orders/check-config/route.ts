import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { parseOrderCheckConfig } from '@/lib/order-check-config'

// ---------- GET /api/orders/check-config ----------
// Thiết lập bật/tắt cảnh báo của vùng "Kiểm tra đơn" cho form đơn hàng.
// Người lên đơn không có quyền xem Cài đặt → endpoint riêng, chỉ trả cấu hình này.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  const s = await prisma.appSettings.findUnique({ where: { id: 'main' }, select: { orderCheckConfig: true } })
  return NextResponse.json({ ok: true, config: parseOrderCheckConfig(s?.orderCheckConfig ?? '') })
}
