// ============================================================
// POST /api/bom-import/runs/[id]/links — gán tay parent ↔ set (NQ4, F5)
// Body: { links: { [rowNo]: setName | null } } — null = xóa gán tay.
// Lưu vào sidecar, validate lại + dựng lại crossChecks.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { readSidecar, writeSidecar } from '../../../_lib'
import { buildPreviewPayload, revalidateWithLinks } from '../../../_preview'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền gán link báo giá' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })
  if (run.status !== 'validated') {
    return NextResponse.json({ error: `Run chưa parse xong (trạng thái: ${run.status})` }, { status: 409 })
  }

  let body: { links?: Record<string, string | null> }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body không phải JSON' }, { status: 400 })
  }
  const sidecar = await readSidecar(run)
  if (!sidecar?.canonical) {
    return NextResponse.json({ error: 'Chưa có dữ liệu canonical — hãy chạy parse lại' }, { status: 409 })
  }
  const setNames = new Set((sidecar.canonical.quotation?.sets ?? []).map((s) => s.name))
  const parentRows = new Set(sidecar.canonical.parents.map((p) => p.rowNo))

  const manualLinks = { ...sidecar.manualLinks }
  for (const [rowNoStr, setName] of Object.entries(body.links ?? {})) {
    const rowNo = Number(rowNoStr)
    if (!parentRows.has(rowNo)) {
      return NextResponse.json({ error: `Dòng ${rowNoStr} không phải mã cha trong đợt này` }, { status: 400 })
    }
    if (setName === null) {
      delete manualLinks[rowNo]
    } else {
      if (!setNames.has(setName)) {
        return NextResponse.json({ error: `Set báo giá "${setName}" không tồn tại` }, { status: 400 })
      }
      manualLinks[rowNo] = setName
    }
  }

  const updated = await writeSidecar(run, { manualLinks })
  if (!updated) return NextResponse.json({ error: 'Không ghi được sidecar' }, { status: 500 })
  // Validate lại + cập nhật crossChecks trong canonical
  const { issues, crossChecks } = revalidateWithLinks(updated)
  updated.canonical.crossChecks = crossChecks
  await writeSidecar(run, { canonical: updated.canonical, issues })

  const final = (await readSidecar(run)) ?? updated
  return NextResponse.json({ runId: id, preview: buildPreviewPayload(final) })
}
