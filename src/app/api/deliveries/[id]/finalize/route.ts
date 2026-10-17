import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

type Ctx = { params: Promise<{ id: string }> }

// ---------- PATCH /api/deliveries/[id]/finalize : duyệt nháp thành phiếu giao hàng chính thức ----------
// Phase 2: body { version } — kiểm tra optimistic locking, yêu cầu isDraft=true + status Open,
// cấp docNum thật (max+1), set isDraft=false. Không tự đẩy SAP (phiếu dùng nút đẩy thủ công).
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền duyệt phiếu giao hàng' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as { version?: number } | null
  const version = body?.version
  if (typeof version !== 'number') {
    return NextResponse.json(
      { error: 'Thiếu version — vui lòng tải lại chứng từ', code: 'VERSION_REQUIRED' },
      { status: 400 },
    )
  }

  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  if (user.databaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  if (version !== delivery.version) {
    return NextResponse.json(
      { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại chứng từ', code: 'VERSION_CONFLICT' },
      { status: 409 },
    )
  }
  if (!delivery.isDraft) {
    return NextResponse.json({ error: `Phiếu này không phải nháp — đã có số ${delivery.docNum ?? ''}` }, { status: 400 })
  }
  if (delivery.status !== 'Open') {
    return NextResponse.json({ error: 'Chỉ có thể duyệt nháp đang ở trạng thái Open' }, { status: 400 })
  }
  if (!delivery.lines || delivery.lines.length === 0) {
    return NextResponse.json({ error: 'Nháp không có dòng hàng nào — không thể duyệt' }, { status: 400 })
  }

  // Cấp số thật + chuyển chính thức (retry khi trùng số)
  let finalized: typeof delivery | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 5 && !finalized; attempt++) {
    try {
      finalized = await prisma.$transaction(async (tx) => {
        const last = await tx.delivery.findFirst({ orderBy: { docNum: 'desc' } })
        const docNum = (last?.docNum ?? 0) + 1
        return tx.delivery.update({
          where: { id, version },
          data: { isDraft: false, docNum, version: { increment: 1 } },
          include: { lines: { orderBy: { lineNum: 'asc' } } },
        })
      })
    } catch (e) {
      lastErr = e
      const code = (e as { code?: string })?.code
      if (code !== 'P2002' && code !== 'P2034' && code !== 'P2025') throw e
    }
  }
  if (!finalized) {
    const code = (lastErr as { code?: string } | null)?.code
    if (code === 'P2025') {
      return NextResponse.json(
        { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại chứng từ', code: 'VERSION_CONFLICT' },
        { status: 409 },
      )
    }
    throw lastErr ?? new Error('Không thể duyệt nháp')
  }

  return NextResponse.json({ ok: true, delivery: finalized })
}
