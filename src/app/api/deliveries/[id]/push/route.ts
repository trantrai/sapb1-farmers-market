import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { acquirePushLock, releasePushLock } from '@/lib/order-push-lock'
import { pushDeliveryToSap } from '@/lib/sap-push-delivery'
import { headerExtrasFromRecord } from '@/lib/sap-push-document'
import { clearSapDeliveriesCache } from '@/lib/sap-deliveries'
import { isSapDeliveryLine } from '@/lib/delivery-bom'

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
    include: {
      lines: { orderBy: { lineNum: 'asc' } },
      sourceOrder: { select: { status: true } },
    },
  })
  if (!delivery) return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && delivery.sapDatabaseId && delivery.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: 'Không tìm thấy phiếu giao hàng' }, { status: 404 })
  }
  if (delivery.sapSyncStatus === 'synced') {
    return NextResponse.json({ ok: true, message: 'Phiếu đã được đẩy trước đó', delivery })
  }
  if (delivery.status === 'Cancelled') {
    return NextResponse.json({ error: 'Phiếu đã hủy — không thể đẩy sang SAP' }, { status: 400 })
  }
  // Chặn khi đơn nguồn đã hủy
  if (delivery.sourceOrder?.status === 'Cancelled') {
    return NextResponse.json(
      { error: 'Đơn nguồn đã bị hủy — không thể sửa/đẩy phiếu giao hàng' },
      { status: 400 },
    )
  }

  // Khóa chống 2 lượt đẩy đồng thời tạo trùng chứng từ trên SAP
  // (cả 2 cùng qua check sapSyncStatus + UDF lookup trước khi POST).
  if (!acquirePushLock('delivery', id)) {
    return NextResponse.json(
      { error: 'Phiếu đang được đẩy sang SAP — vui lòng đợi lượt hiện tại xong rồi thử lại.' },
      { status: 409 },
    )
  }
  try {
    const result = await pushDeliveryToSap({
      databaseId: delivery.sapDatabaseId ?? user.databaseId,
      cardCode: delivery.cardCode,
      docDate: delivery.docDate.toISOString(),
      comments: delivery.remarks,
      warehouseCode: delivery.warehouseCode ?? null,
      localId: delivery.id,
      // Lập từ đơn hàng CHỈ có trên SAP → base dựng từ DocEntry này (dòng nguồn id `sap-<LineNum>`)
      sapSourceDocEntry: delivery.sapSourceDocEntry ?? null,
      // B2B / SAP B1 (Đợt 2+3): các trường header đã lưu trên DB — tầng push
      // (buildPayload → sapDocHeaderExtras) chỉ gửi khi có giá trị
      ...headerExtrasFromRecord(delivery),
      headerDiscPct: delivery.headerDiscPct ?? 0,
      pickAndPackNotes: delivery.pickAndPackNotes ?? null,
      // BOM: chỉ gửi dòng cha + hàng thường — SAP tự bung thành phần theo công thức
      lines: delivery.lines.filter(isSapDeliveryLine).map((l) => ({
        itemCode: l.itemCode,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        uom: l.uom,
        taxCode: l.taxCode ?? null,
        discPct: l.discPct ?? 0,
        warehouseCode: l.warehouseCode ?? null,
        // Số lô (SAP: DocumentLines.BatchNumbers) — chỉ dòng có giá trị mới gửi
        batchNumber: l.batchNumber ?? null,
        // Copy-from: local id dòng nguồn → tầng push tra BaseType/BaseEntry/BaseLine
        sourceOrderLineId: l.sourceOrderLineId ?? null,
        sourceQuotationLineId: l.sourceQuotationLineId ?? null,
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
      // Xóa cache danh sách SAP để lần tải sau thấy chứng từ mới trên SAP,
      // bản ghi local đã synced sẽ bị ẩn (tránh trùng)
      clearSapDeliveriesCache()
      return NextResponse.json({ ok: true, message: `Đã đẩy sang SAP B1 — DocNum ${result.docNum ?? ''}`, delivery: updated })
    }
    return NextResponse.json(
      { ok: false, error: result.error ?? 'Đẩy thất bại', delivery: updated },
      // Bị chặn ở tầng validate (dòng nguồn chưa lên SAP) → 400 rõ ràng;
      // chưa cấu hình SAP → 400; lỗi đẩy khác → 502
      { status: result.status === 'none' || result.blocked ? 400 : 502 },
    )
  } finally {
    releasePushLock('delivery', id)
  }
}
