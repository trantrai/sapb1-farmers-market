// ============================================================
// POST /api/bom-import/runs/[id]/confirm — approval gate #1 (F20)
// Body: { action: 'confirm' | 'cancel' }
// - confirm: ingested → confirmed (mở khóa parse)
// - cancel:  → cancelled (file đã tải giữ lại, có log)
// Chưa xác nhận → parse bị chặn 409.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { serializeRun } from '../../../_lib'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền duyệt lượt import BOM' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })

  let body: { action?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body không phải JSON' }, { status: 400 })
  }

  if (body.action === 'cancel') {
    if (!['ingesting', 'ingested'].includes(run.status)) {
      return NextResponse.json(
        { error: `Run đang ở trạng thái ${run.status} — không thể hủy` },
        { status: 409 },
      )
    }
    const updated = await prisma.importRun.update({
      where: { id },
      data: { status: 'cancelled', finishedAt: new Date() },
    })
    return NextResponse.json({ run: serializeRun(updated), note: 'Đã hủy run — file đã tải được giữ lại để tra cứu' })
  }

  if (body.action === 'confirm') {
    if (run.status !== 'ingested') {
      return NextResponse.json(
        { error: `Run đang ở trạng thái ${run.status} — chỉ xác nhận được khi đang chờ (ingested)` },
        { status: 409 },
      )
    }
    const updated = await prisma.importRun.update({
      where: { id },
      data: { status: 'confirmed' },
    })
    return NextResponse.json({ run: serializeRun(updated) })
  }

  return NextResponse.json({ error: 'action phải là confirm hoặc cancel' }, { status: 400 })
}
