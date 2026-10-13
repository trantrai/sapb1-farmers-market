import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { decryptSecret } from '@/lib/fm-crypto'
import { sapTestLogin } from '@/lib/sap-service-layer'

// POST /api/sap-databases/[id]/test — kiểm tra kết nối 1 database (quyền settings.edit)
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  // Yêu cầu quyền SỬA: mỗi lần test là 1 lần login vào SAP B1,
  // test liên tục có thể làm khóa tài khoản SAP phía server
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền kiểm tra kết nối SAP B1' }, { status: 403 })
  }
  // M10: mỗi lần test là 1 lần login SAP — tối đa 10 lượt / 10 phút / user
  // để tránh test liên tục làm khóa tài khoản SAP
  const rl = rateLimit(`sapdb:test:${user.id}`, 10, 10 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: `Đã vượt giới hạn 10 lượt kiểm tra kết nối trong 10 phút — vui lòng thử lại sau ${rl.retryAfterSec} giây.` },
      { status: 429 },
    )
  }
  const { id } = await ctx.params
  const db = await prisma.sapDatabase.findUnique({ where: { id } })
  if (!db) return NextResponse.json({ error: 'Database không tồn tại' }, { status: 404 })

  const res = await sapTestLogin({
    serviceLayerUrl: db.serviceLayerUrl,
    companyDb: db.companyDb,
    sapUser: db.sapUser,
    sapPassword: decryptSecret(db.sapPassword),
    sslSkipVerify: db.sslSkipVerify,
    dbId: db.id,
    dbLabel: db.label,
  })
  await prisma.sapDatabase.update({
    where: { id },
    data: { connected: res.ok, lastTestAt: new Date() },
  })

  if (!res.ok) {
    return NextResponse.json({ error: res.error ?? 'Kiểm tra kết nối thất bại' }, { status: 502 })
  }
  return NextResponse.json({
    ok: true,
    message: `Kết nối thành công — SAP B1 ${res.version ?? ''}`.trim(),
  })
}
