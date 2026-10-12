import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// PUT /api/excel-templates/[id] — cập nhật template
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.excelTemplates?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền sửa mẫu Excel' }, { status: 403 })
  }

  try {
    const { id } = await params
    const body = (await req.json()) as {
      name?: string
      description?: string
      isDefault?: boolean
      mapping?: Record<string, string>
    }

    const existing = await prisma.excelTemplate.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Không tìm thấy template' }, { status: 404 })
    }

    if (body.isDefault) {
      await prisma.excelTemplate.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      })
    }

    const template = await prisma.excelTemplate.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        ...(body.mapping !== undefined ? { mapping: JSON.stringify(body.mapping) } : {}),
      },
    })
    return NextResponse.json({
      data: { ...template, mapping: JSON.parse(template.mapping) },
    })
  } catch {
    return NextResponse.json({ error: 'Không thể cập nhật template' }, { status: 500 })
  }
}

// DELETE /api/excel-templates/[id] — xóa template
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.excelTemplates?.delete) {
    return NextResponse.json({ error: 'Bạn không có quyền xóa mẫu Excel' }, { status: 403 })
  }

  try {
    const { id } = await params
    const existing = await prisma.excelTemplate.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Không tìm thấy template' }, { status: 404 })
    }
    await prisma.excelTemplate.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Không thể xóa template' }, { status: 500 })
  }
}
