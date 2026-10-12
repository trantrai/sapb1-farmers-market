import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { encryptSecret } from '@/lib/fm-crypto'

function maskDb(d: {
  id: string; label: string; serviceLayerUrl: string; companyDb: string
  sapUser: string; sapPassword: string; sslSkipVerify: boolean
  isDefault: boolean; connected: boolean; lastTestAt: Date | null
  createdAt: Date; updatedAt: Date
}) {
  const { sapPassword, ...rest } = d
  return { ...rest, hasPassword: Boolean(sapPassword), sapPassword: sapPassword ? '••••••••' : '' }
}

async function needEdit(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return { err: unauthorized() as NextResponse }
  if (!user.permissions.settings?.edit) {
    return { err: NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa cài đặt' }, { status: 403 }) }
  }
  return { user }
}

// PUT /api/sap-databases/[id] — sửa database
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { err, user } = await needEdit(req)
  if (err || !user) return err!
  const { id } = await ctx.params

  const existing = await prisma.sapDatabase.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Database không tồn tại' }, { status: 404 })

  try {
    const body = await req.json()
    const label = body.label !== undefined ? String(body.label).trim() : existing.label
    const serviceLayerUrl =
      body.serviceLayerUrl !== undefined
        ? String(body.serviceLayerUrl).trim().replace(/\/+$/, '')
        : existing.serviceLayerUrl
    const companyDb = body.companyDb !== undefined ? String(body.companyDb).trim() : existing.companyDb
    const sapUser = body.sapUser !== undefined ? String(body.sapUser).trim() : existing.sapUser
    if (!label) return NextResponse.json({ error: 'Vui lòng nhập tên database' }, { status: 400 })
    if (!/^https?:\/\/.+/i.test(serviceLayerUrl)) {
      return NextResponse.json({ error: 'URL Service Layer không hợp lệ' }, { status: 400 })
    }
    if (!companyDb) return NextResponse.json({ error: 'Vui lòng nhập CompanyDB' }, { status: 400 })
    if (!sapUser) return NextResponse.json({ error: 'Vui lòng nhập tài khoản SAP' }, { status: 400 })

    // Đặt làm mặc định → hạ các DB khác xuống
    if (body.isDefault === true && !existing.isDefault) {
      await prisma.sapDatabase.updateMany({ where: { isDefault: true }, data: { isDefault: false } })
    }

    try {
      const updated = await prisma.sapDatabase.update({
        where: { id },
        data: {
          label,
          serviceLayerUrl,
          companyDb,
          sapUser,
          // Mật khẩu dạng che hoặc rỗng → giữ nguyên; mật khẩu mới thì mã hóa
          sapPassword:
            body.sapPassword === undefined ||
            !String(body.sapPassword) ||
            String(body.sapPassword).includes('•')
              ? existing.sapPassword
              : encryptSecret(String(body.sapPassword)),
          sslSkipVerify: typeof body.sslSkipVerify === 'boolean' ? body.sslSkipVerify : existing.sslSkipVerify,
          isDefault: body.isDefault === true ? true : existing.isDefault,
          // Đổi thông tin kết nối → trạng thái test cũ không còn giá trị
          connected: false,
        },
      })
      return NextResponse.json({ ok: true, database: maskDb(updated) })
    } catch (e: unknown) {
      if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002') {
        return NextResponse.json(
          { error: 'Trùng với database khác (URL + CompanyDB + tài khoản)' },
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

// DELETE /api/sap-databases/[id] — xóa database
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { err, user } = await needEdit(req)
  if (err || !user) return err!
  const { id } = await ctx.params

  const existing = await prisma.sapDatabase.findUnique({ where: { id } })
  if (!existing) return NextResponse.json({ error: 'Database không tồn tại' }, { status: 404 })

  // Không cho xóa khi còn đơn hàng/mirror gắn với DB này — tránh mồ côi dữ liệu
  const [orders, items] = await Promise.all([
    prisma.salesOrder.count({ where: { sapDatabaseId: id } }),
    prisma.item.count({ where: { sapDatabaseId: id } }),
  ])
  if (orders > 0 || items > 0) {
    return NextResponse.json(
      {
        error:
          `Không thể xóa — còn ${orders} đơn hàng và ${items} mặt hàng gắn với database này. ` +
          'Hãy xóa dữ liệu liên quan trước.',
      },
      { status: 409 },
    )
  }

  await prisma.sapDatabase.delete({ where: { id } })
  // Nếu xóa DB mặc định → chuyển cờ mặc định cho DB còn lại (cũ nhất)
  if (existing.isDefault) {
    const next = await prisma.sapDatabase.findFirst({ orderBy: { createdAt: 'asc' } })
    if (next) await prisma.sapDatabase.update({ where: { id: next.id }, data: { isDefault: true } })
  }
  return NextResponse.json({ ok: true })
}
