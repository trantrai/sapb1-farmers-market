// GET /api/bom-import/decisions — 17 quyết định đã chốt (F8)
import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { BOM_DECISIONS } from '@/lib/fm-bom-import/decisions'

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem Import BOM' }, { status: 403 })
  }
  return NextResponse.json({
    decisions: BOM_DECISIONS,
    total: BOM_DECISIONS.length,
    decidedAt: '2026-10-16',
    source: 'docs/decision-log.md',
  })
}
