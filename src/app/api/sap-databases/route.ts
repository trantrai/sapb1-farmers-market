import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { encryptSecret } from '@/lib/fm-crypto'
import { ensureSapDatabases } from '@/lib/sap-service-layer'
import { rateLimit } from '@/lib/rate-limit'

// Chuẩn hóa 1 bản ghi DB để trả về client — KHÔNG bao giờ trả mật khẩu thật
function maskDb(d: {
  id: string; label: string; serviceLayerUrl: string; companyDb: string
  sapUser: string; sapPassword: string; sslSkipVerify: boolean
  isDefault: boolean; connected: boolean; lastTestAt: Date | null
  createdAt: Date; updatedAt: Date
}) {
  const { sapPassword, ...rest } = d
  return { ...rest, hasPassword: Boolean(sapPassword), sapPassword: sapPassword ? '••••••••' : '' }
}

// GET /api/sap-databases — danh sách database (quyền settings.view)
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem cài đặt' }, { status: 403 })
  }
  await ensureSapDatabases()
  const list = await prisma.sapDatabase.findMany({
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  return NextResponse.json({ databases: list.map(maskDb) })
}

// POST /api/sap-databases — thêm database mới (quyền settings.edit)
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa cài đặt' }, { status: 403 })
  }
  const rl = rateLimit(`sapdb:create:${user.id}`, 20, 10 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Thao tác quá nhanh — vui lòng thử lại sau' },
      { status: 429 },
    )
  }

  try {
    const body = await req.json()
    const label = String(body.label ?? '').trim()
    const serviceLayerUrl = String(body.serviceLayerUrl ?? '').trim().replace(/\/+$/, '')
    const companyDb = String(body.companyDb ?? '').trim()
    const sapUser = String(body.sapUser ?? '').trim()
    const sapPassword = String(body.sapPassword ?? '')
    if (!label) return NextResponse.json({ error: 'Vui lòng nhập tên database' }, { status: 400 })
    if (!/^https?:\/\/.+/i.test(serviceLayerUrl)) {
      return NextResponse.json({ error: 'URL Service Layer không hợp lệ' }, { status: 400 })
    }
    if (!companyDb) return NextResponse.json({ error: 'Vui lòng nhập CompanyDB' }, { status: 400 })
    if (!sapUser) return NextResponse.json({ error: 'Vui lòng nhập tài khoản SAP' }, { status: 400 })
    if (!sapPassword) return NextResponse.json({ error: 'Vui lòng nhập mật khẩu SAP' }, { status: 400 })

    await ensureSapDatabases()
    const count = await prisma.sapDatabase.count()
    const setDefault = count === 0 || body.isDefault === true
    if (setDefault) {
      await prisma.sapDatabase.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    }
    try {
      const created = await prisma.sapDatabase.create({
        data: {
          label,
          serviceLayerUrl,
          companyDb,
          sapUser,
          sapPassword: encryptSecret(sapPassword),
          sslSkipVerify: body.sslSkipVerify === true,
          isDefault: setDefault,
        },
      })
      return NextResponse.json({ ok: true, database: maskDb(created) }, { status: 201 })
    } catch (e: unknown) {
      // Trùng (URL, CompanyDB, tài khoản)
      if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
        return NextResponse.json(
          { error: 'Database này đã được khai báo (trùng URL + CompanyDB + tài khoản)' },
          { status: 409 },
        )
      }
      throw e
    }
  } catch (e) {
    if (e instanceof SyntaxError) return NextResponse.json({ error: 'Dữ liệu không hợp lệ' }, { status: 400 })
    throw e
  }
}
