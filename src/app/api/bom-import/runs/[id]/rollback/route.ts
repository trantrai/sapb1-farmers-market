// ============================================================
// POST /api/bom-import/runs/[id]/rollback — Sprint 3: rollback theo runId (F13)
// Ngược thứ tự tạo: DELETE /ProductTrees trước, DELETE /Items sau;
// chỉ xóa key do run này tạo (createdKeys). Key xóa thành công được gỡ khỏi
// createdKeys; key lỗi giữ lại để retry rollback.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import {
  rollbackCreated,
  realB1IO,
  type CreatedKey,
} from '@/lib/fm-bom-import/applier'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền rollback Import BOM' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })

  let keys: CreatedKey[] = []
  try {
    const parsed = JSON.parse(run.createdKeys || '[]')
    if (Array.isArray(parsed)) keys = parsed.filter((k) => k && (k.type === 'tree' || k.type === 'item') && k.code)
  } catch {
    keys = []
  }
  if (keys.length === 0) {
    return NextResponse.json({ error: 'Run này chưa tạo gì trên B1 — không có gì để rollback' }, { status: 409 })
  }

  const s = await loadSapSettings(user.databaseId)
  if (!isSapConfigured(s)) {
    return NextResponse.json({ error: 'Chưa cấu hình SAP B1 cho database này' }, { status: 400 })
  }

  const result = await rollbackCreated(realB1IO(s, id), id, keys)

  // Gỡ key đã xóa khỏi createdKeys; giữ lại key lỗi để retry
  const deletedSet = new Set(result.deleted.map((k) => `${k.type}:${k.code}`))
  const remaining = keys.filter((k) => !deletedSet.has(`${k.type}:${k.code}`))
  await prisma.importRun.update({
    where: { id },
    data: {
      createdKeys: JSON.stringify(remaining),
      status: result.failed.length === 0 && remaining.length === 0 ? 'rolledback' : run.status,
    },
  })

  return NextResponse.json({
    runId: id,
    deleted: result.deleted,
    failed: result.failed,
    remainingKeys: remaining.length,
  })
}
