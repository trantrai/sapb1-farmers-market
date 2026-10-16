// ============================================================
// POST /api/bom-import/runs/[id]/approve — approval gate #2 (F5)
// Body: { approved: number[] } — danh sách rowNo mã cha được duyệt.
// Apply bị DISABLED khi còn fail-fast hoặc chưa duyệt cha nào (check ở client
// + server khi gọi apply ở Sprint 3).
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { readSidecar, writeSidecar } from '../../../_lib'
import { buildPreviewPayload } from '../../../_preview'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền duyệt mã cha' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })
  if (run.status !== 'validated') {
    return NextResponse.json({ error: `Run chưa parse xong (trạng thái: ${run.status})` }, { status: 409 })
  }

  let body: { approved?: number[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body không phải JSON' }, { status: 400 })
  }
  const sidecar = await readSidecar(run)
  if (!sidecar?.canonical) {
    return NextResponse.json({ error: 'Chưa có dữ liệu canonical — hãy chạy parse lại' }, { status: 409 })
  }
  const parentRows = new Set(sidecar.canonical.parents.map((p) => p.rowNo))
  const approved = [...new Set(body.approved ?? [])].filter((r) => parentRows.has(r))

  const updated = await writeSidecar(run, { approvedParents: approved })
  if (!updated) return NextResponse.json({ error: 'Không ghi được sidecar' }, { status: 500 })
  const preview = buildPreviewPayload(updated)
  return NextResponse.json({
    runId: id,
    approvedParents: approved,
    approvedCount: preview.approvedCount,
    canApply: preview.canApply,
    applyNote: preview.applyNote,
  })
}
