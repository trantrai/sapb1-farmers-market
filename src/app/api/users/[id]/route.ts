import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized, hashPassword } from '@/lib/fm-auth'
import { parseSlpAssignments, validateSlpAssignments, saveSlpAssignments } from '@/lib/user-sales-person'

const PUBLIC_SELECT = {
  id: true,
  username: true,
  fullName: true,
  role: true,
  active: true,
  createdAt: true,
  updatedAt: true,
}

async function countActiveAdmins(excludeId?: string) {
  const admins = await prisma.user.findMany({ where: { role: 'Admin', active: true }, select: { id: true } })
  return excludeId ? admins.filter((a) => a.id !== excludeId).length : admins.length
}

// PATCH /api/users/[id] — cập nhật họ tên / vai trò / mật khẩu / active
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = await getSessionUser(req)
  if (!me) return unauthorized()
  if (!me.permissions.users?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền sửa người dùng' }, { status: 403 })
  }

  const { id } = await ctx.params
  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) return NextResponse.json({ error: 'Không tìm thấy người dùng' }, { status: 404 })

  // Chỉ Admin mới được chỉnh người dùng thuộc vai trò Admin
  if (target.role === 'Admin' && me.role !== 'Admin') {
    return NextResponse.json({ error: 'Chỉ Admin mới được chỉnh sửa tài khoản Admin' }, { status: 403 })
  }

  try {
    const body = (await req.json()) as {
      fullName?: string
      role?: string
      password?: string
      active?: boolean
      salesPersons?: unknown
    }

    const slp = parseSlpAssignments(body.salesPersons)
    if (!slp.ok) return NextResponse.json({ error: slp.error }, { status: 400 })
    const slpErr = await validateSlpAssignments(slp.data)
    if (slpErr) return NextResponse.json({ error: slpErr }, { status: 400 })

    const data: { fullName?: string; role?: string; password?: string; active?: boolean } = {}

    if (body.fullName !== undefined) {
      const fullName = String(body.fullName).trim()
      if (!fullName) return NextResponse.json({ error: 'Họ tên không được để trống' }, { status: 400 })
      data.fullName = fullName
    }

    if (body.role !== undefined && body.role !== target.role) {
      if (target.id === me.id) {
        return NextResponse.json({ error: 'Bạn không thể tự thay đổi vai trò của chính mình' }, { status: 400 })
      }
      if (me.role !== 'Admin') {
        return NextResponse.json({ error: 'Chỉ Admin mới được phân vai trò' }, { status: 403 })
      }
      const roleExists = await prisma.role.findUnique({ where: { name: String(body.role) } })
      if (!roleExists) return NextResponse.json({ error: 'Vai trò mới không tồn tại' }, { status: 400 })
      if (target.role === 'Admin') {
        const otherAdmins = await countActiveAdmins(target.id)
        if (otherAdmins === 0) {
          return NextResponse.json(
            { error: 'Hệ thống cần tối thiểu 1 tài khoản Admin đang hoạt động' },
            { status: 400 },
          )
        }
      }
      data.role = String(body.role)
    }

    if (body.password !== undefined && body.password !== '') {
      const pw = String(body.password)
      if (pw.length < 8) {
        return NextResponse.json({ error: 'Mật khẩu tối thiểu 8 ký tự' }, { status: 400 })
      }
      data.password = await hashPassword(pw)
    }

    if (body.active !== undefined && body.active !== target.active) {
      if (target.id === me.id) {
        return NextResponse.json({ error: 'Bạn không thể tự vô hiệu hóa tài khoản của mình' }, { status: 400 })
      }
      if (!body.active && target.role === 'Admin') {
        const otherAdmins = await countActiveAdmins(target.id)
        if (otherAdmins === 0) {
          return NextResponse.json(
            { error: 'Không thể vô hiệu hóa Admin cuối cùng của hệ thống' },
            { status: 400 },
          )
        }
      }
      data.active = Boolean(body.active)
    }

    if (Object.keys(data).length === 0 && slp.data.length === 0) {
      return NextResponse.json({ error: 'Không có thay đổi nào' }, { status: 400 })
    }

    const updated = Object.keys(data).length
      ? await prisma.user.update({ where: { id }, data, select: PUBLIC_SELECT })
      : await prisma.user.findUniqueOrThrow({ where: { id }, select: PUBLIC_SELECT })
    await saveSlpAssignments(id, slp.data)
    return NextResponse.json({ ok: true, user: updated })
  } catch (e) {
    console.error('PATCH /api/users/[id]', e)
    return NextResponse.json({ error: 'Không thể cập nhật người dùng' }, { status: 500 })
  }
}

// DELETE /api/users/[id] — xóa người dùng
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = await getSessionUser(req)
  if (!me) return unauthorized()
  if (!me.permissions.users?.delete) {
    return NextResponse.json({ error: 'Bạn không có quyền xóa người dùng' }, { status: 403 })
  }

  const { id } = await ctx.params
  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) return NextResponse.json({ error: 'Không tìm thấy người dùng' }, { status: 404 })

  if (target.id === me.id) {
    return NextResponse.json({ error: 'Bạn không thể xóa tài khoản của chính mình' }, { status: 400 })
  }
  if (target.role === 'Admin' && me.role !== 'Admin') {
    return NextResponse.json({ error: 'Chỉ Admin mới được xóa tài khoản Admin' }, { status: 403 })
  }
  if (target.role === 'Admin' && target.active) {
    const otherAdmins = await countActiveAdmins(target.id)
    if (otherAdmins === 0) {
      return NextResponse.json({ error: 'Không thể xóa Admin cuối cùng của hệ thống' }, { status: 400 })
    }
  }

  await prisma.userSalesPerson.deleteMany({ where: { userId: id } })
  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
