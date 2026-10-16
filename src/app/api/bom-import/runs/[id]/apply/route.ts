// ============================================================
// POST /api/bom-import/runs/[id]/apply — STUB Sprint 2 (F6 là Sprint 3)
// TUYỆT ĐỐI không gọi API B1 ghi dữ liệu ở Sprint 2.
// Trả 501 để client hiển thị đúng trạng thái.
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

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

  return NextResponse.json(
    {
      error: 'Apply lên SAP B1 là Sprint 3 — Sprint 2 chỉ preview dry-run, không ghi dữ liệu lên B1',
      code: 'E_SPRINT3',
      runId: id,
    },
    { status: 501 },
  )
}
