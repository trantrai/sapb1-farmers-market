import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

// GET /api/excel-templates — danh sách template
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const templates = await prisma.excelTemplate.findMany({
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
  })
  return NextResponse.json({
    data: templates.map((t) => ({
      ...t,
      mapping: JSON.parse(t.mapping),
    })),
  })
}

// POST /api/excel-templates — tạo template mới
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  try {
    const body = (await req.json()) as {
      name?: string
      description?: string
      isDefault?: boolean
      mapping?: Record<string, string>
    }
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Tên template không được để trống' }, { status: 400 })
    }
    if (!body.mapping || Object.keys(body.mapping).length === 0) {
      return NextResponse.json({ error: 'Mapping không được để trống' }, { status: 400 })
    }

    // Nếu đặt làm mặc định, bỏ mặc định của các template khác
    if (body.isDefault) {
      await prisma.excelTemplate.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      })
    }

    const template = await prisma.excelTemplate.create({
      data: {
        name: body.name.trim(),
        description: body.description?.trim() || null,
        isDefault: body.isDefault ?? false,
        mapping: JSON.stringify(body.mapping),
      },
    })
    return NextResponse.json({
      data: { ...template, mapping: JSON.parse(template.mapping) },
    }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Không thể tạo template' }, { status: 500 })
  }
}
