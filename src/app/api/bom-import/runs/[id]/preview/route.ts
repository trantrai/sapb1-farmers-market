// ============================================================
// GET /api/bom-import/runs/[id]/preview — preview dry-run Sprint 2 (F5)
// Bảng cha→con, link set (NQ4 + gán tay), crossChecks W7/W8/W9,
// gate #2 (checkbox duyệt từng cha), trạng thái canApply.
// Dry-run tuyệt đối không gọi API B1 ghi dữ liệu.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { readSidecar } from '../../../_lib'
import { buildPreviewPayload } from '../../../_preview'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem Import BOM' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })
  if (!['validated'].includes(run.status)) {
    return NextResponse.json(
      { error: `Run chưa parse xong (trạng thái: ${run.status}) — hãy parse trước khi xem preview` },
      { status: 409 },
    )
  }
  const sidecar = await readSidecar(run)
  if (!sidecar?.canonical) {
    return NextResponse.json({ error: 'Chưa có dữ liệu canonical — hãy chạy parse lại' }, { status: 409 })
  }
  return NextResponse.json({ runId: id, preview: buildPreviewPayload(sidecar) })
}
