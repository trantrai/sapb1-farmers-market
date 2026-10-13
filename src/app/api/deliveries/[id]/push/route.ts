import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { pushDeliveryToSap } from '@/lib/sap-push-delivery'

interface Ctx {
  params: Promise<{ id: string }>
}

// POST /api/deliveries/[id]/push — đẩy delivery sang SAP B1
export async function POST(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.deliveries?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền đẩy phiếu giao hàng' }, { status: 403 })
  }
  const rl = rateLimit(`delivery:push:${user.id}`, 10, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  const { id } = await ctx.params
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  if (delivery.sapSyncStatus === 'synced') {
    return NextResponse.json({ ok: true, message: 'Phiếu đã được đẩy trước đó', delivery })
  }
  if (delivery.status === 'Cancelled') {
    return NextResponse.json({ error: 'Phiếu đã hủy — không thể đẩy sang SAP' }, { status: 400 })
  }

  const result = await pushDeliveryToSap({
    databaseId: delivery.sapDatabaseId ?? user.databaseId,
    cardCode: delivery.cardCode,
    docDate: delivery.docDate.toISOString(),
    comments: delivery.remarks,
    localId: delivery.id,
    lines: delivery.lines.map((l) => ({
      itemCode: l.itemCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
    })),
  })

  const updated = await prisma.delivery.update({
    where: { id },
    data: {
      sapSyncStatus: result.status,
      sapSyncError: result.error ?? null,
      ...(result.status === 'synced'
        ? { sapDocEntry: result.docEntry ?? null, sapDocNum: result.docNum ?? null, sapSyncedAt: new Date() }
        : {}),
    },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })

  if (result.status === 'synced') {
    return NextResponse.json({ ok: true, message: `Đã đẩy sang SAP B1 — DocNum ${result.docNum ?? ''}`, delivery: updated })
  }
  return NextResponse.json(
    { ok: false, error: result.error ?? 'Đẩy thất bại', delivery: updated },
    { status: result.status === 'none' ? 400 : 502 },
  )
}
