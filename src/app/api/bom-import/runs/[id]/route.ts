// GET /api/bom-import/runs/[id] — chi tiết run (kèm tóm tắt canonical nếu có)
import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { getBomImportDir } from '@/lib/fm-bom-import/base-client'
import { serializeRun } from '../../_lib'

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

  // Tóm tắt canonical đã parse (nếu có)
  let canonicalSummary: {
    parents: number
    components: number
    errors: number
    warnings: number
    validatedAt: string | null
  } | null = null
  if (run.canonicalRef) {
    try {
      const abs = path.join(getBomImportDir(), ...run.canonicalRef.split('/'))
      const raw = JSON.parse(await fs.readFile(abs, 'utf8'))
      const parents = raw?.canonical?.parents ?? []
      const issues = raw?.issues ?? []
      canonicalSummary = {
        parents: parents.length,
        components: parents.reduce((n: number, p: { components?: unknown[] }) => n + (p.components?.length ?? 0), 0),
        errors: issues.filter((i: { severity: string }) => i.severity === 'error').length,
        warnings: issues.filter((i: { severity: string }) => i.severity === 'warning').length,
        validatedAt: raw?.validatedAt ?? null,
      }
    } catch {
      /* file canonical lỗi — bỏ qua */
    }
  }

  return NextResponse.json({ run: serializeRun(run), canonicalSummary })
}
