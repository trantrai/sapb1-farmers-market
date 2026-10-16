// ============================================================
// POST /api/bom-import/runs/[id]/apply — Sprint 3: apply thật lên SAP B1 (F6)
// - Chỉ apply các cha đã duyệt gate 2 (approvedParents) và đã sinh mã.
// - Chặn khi còn lỗi fail-fast (revalidate).
// - Idempotent: chạy lại cùng runId an toàn (pre-check GET trước POST).
// - Mọi call B1 audit 'always' + retryOf=runId (F7).
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { readSidecar } from '../../../_lib'
import { buildPreviewPayload } from '../../../_preview'
import {
  applyParents,
  realB1IO,
  type ApplyParentInput,
  type CreatedKey,
} from '@/lib/fm-bom-import/applier'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền apply Import BOM' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })
  if (run.status !== 'validated' && run.status !== 'failed') {
    return NextResponse.json(
      { error: `Run ở trạng thái '${run.status}' — chỉ apply khi đã validate (hoặc retry khi failed)` },
      { status: 409 },
    )
  }

  const s = await loadSapSettings(user.databaseId)
  if (!isSapConfigured(s)) {
    return NextResponse.json(
      { error: 'Chưa cấu hình SAP B1 cho database này — vào Cài đặt khai báo Service Layer trước khi apply' },
      { status: 400 },
    )
  }

  const sidecar = await readSidecar(run)
  if (!sidecar?.canonical) {
    return NextResponse.json({ error: 'Chưa có dữ liệu canonical — hãy chạy parse lại' }, { status: 409 })
  }

  // Chặn khi còn lỗi fail-fast (giống điều kiện canApply ở preview)
  const preview = buildPreviewPayload(sidecar)
  if (preview.blocked) {
    return NextResponse.json(
      { error: `Còn ${preview.errors} lỗi fail-fast — khắc phục trước khi apply` },
      { status: 409 },
    )
  }

  const approved = new Set(sidecar.approvedParents)
  const inputs: ApplyParentInput[] = []
  for (const p of sidecar.canonical.parents) {
    const code = sidecar.generatedCodes[p.rowNo] ?? p.itemCode ?? null
    if (!code) {
      return NextResponse.json(
        { error: `Cha '${p.itemName}' (dòng Excel ${p.rowNo}) chưa sinh mã — sinh mã trước khi apply` },
        { status: 409 },
      )
    }
    if (!approved.has(p.rowNo)) continue // chỉ apply cha đã duyệt gate 2
    inputs.push({ rowNo: p.rowNo, code, parent: p })
  }
  if (inputs.length === 0) {
    return NextResponse.json({ error: 'Chưa duyệt mã cha nào ở gate 2' }, { status: 409 })
  }

  await prisma.importRun.update({ where: { id }, data: { status: 'applying' } })

  let result
  try {
    result = await applyParents(realB1IO(s, id), id, inputs)
  } catch (e) {
    await prisma.importRun.update({ where: { id }, data: { status: 'failed' } })
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Apply thất bại', runId: id },
      { status: 500 },
    )
  }

  // Cộng dồn createdKeys (retry cùng runId không tạo trùng nhờ idempotent)
  let prevKeys: CreatedKey[] = []
  try {
    const parsed = JSON.parse(run.createdKeys || '[]')
    if (Array.isArray(parsed)) prevKeys = parsed
  } catch {
    prevKeys = []
  }
  for (const k of result.createdKeys) {
    if (!prevKeys.some((x) => x.type === k.type && x.code === k.code)) prevKeys.push(k)
  }
  const status = result.failed > 0 ? 'failed' : 'applied'
  await prisma.importRun.update({
    where: { id },
    data: {
      status,
      createdKeys: JSON.stringify(prevKeys),
      finishedAt: result.failed > 0 ? null : new Date(),
    },
  })

  return NextResponse.json({
    runId: id,
    status,
    total: result.results.length,
    succeeded: result.succeeded,
    failed: result.failed,
    results: result.results,
    createdKeys: prevKeys,
  })
}
