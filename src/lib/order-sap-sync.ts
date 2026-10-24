// ============================================================
// ĐẨY ĐƠN HÀNG BÁN SANG SAP — phần dùng chung cho: tạo đơn, duyệt nháp,
// tạo từ báo giá, "Đẩy lại" và job tự thử lại nền.
// - recordOrderPush: ghi kết quả đẩy (LineNum, trạng thái, lịch thử lại)
// - syncOrderToSap: đẩy lại 1 đơn đã lưu (có khoá chống đẩy song song)
// ============================================================

import { db as prisma } from './db'
import { pushOrderToSap } from './sap-push-order'
import { headerExtrasFromRecord, bomLineFields, type SapPushResult } from './sap-push-document'
import { acquireOrderPushLock, releaseOrderPushLock } from './order-push-lock'
import { nextRetryState, withMarker, type SapSyncErrorKind } from './sap-sync-retry'

/**
 * Chuẩn hoá kết quả đẩy + ghi LineNum do SAP cấp. Trả status/error cuối cùng
 * và `data` để caller gộp vào prisma.salesOrder.update.
 * Chỉ công nhận 'synced' khi SAP trả về DocEntry hợp lệ — thiếu DocEntry thì
 * giữ 'pending' (chứng từ có thể đã tạo → cần UDF để tự thử lại an toàn).
 */
export async function recordOrderPush(
  push: SapPushResult,
  lines: { id: string; lineNum: number }[],
  opts: { prevAttempts?: number; auto?: boolean } = {},
) {
  const syncedOk = push.status === 'synced' && typeof push.docEntry === 'number'
  const noDocEntry = !syncedOk && push.status === 'synced'
  const status = noDocEntry ? 'pending' : push.status
  const error = noDocEntry ? 'SAP không trả về DocEntry — sẽ thử đẩy lại' : (push.error ?? null)
  const kind: SapSyncErrorKind | null = noDocEntry ? withMarker('unknown', Boolean(push.udf)) : (push.errorKind ?? null)

  if (syncedOk && push.lineNums?.length) {
    const dbLines = [...lines].sort((a, b) => a.lineNum - b.lineNum)
    await prisma.$transaction(
      dbLines.map((l, i) =>
        prisma.salesOrderLine.update({ where: { id: l.id }, data: { sapLineNum: push.lineNums?.[i] ?? null } }),
      ),
    )
  }
  // 'none' = chưa cấu hình SAP → không có gì để thử lại
  const retry = status === 'none'
    ? {}
    : nextRetryState({ ok: syncedOk, kind: kind ?? 'business' }, opts.prevAttempts ?? 0, Boolean(opts.auto))
  return {
    syncedOk,
    status,
    error,
    data: {
      sapSyncStatus: status,
      sapSyncError: error,
      ...retry,
      ...(syncedOk ? { sapDocEntry: push.docEntry ?? null, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() } : {}),
    },
  }
}

export type SyncOrderOutcome =
  | { kind: 'not_found' }
  | { kind: 'cancelled' }
  | { kind: 'draft' }
  | { kind: 'already_synced'; sapDocNum: number | null }
  | { kind: 'locked' }
  | { kind: 'needs_reconcile'; error: string | null }
  | { kind: 'done'; ok: boolean; status: string; error: string | null; push: SapPushResult; order: Awaited<ReturnType<typeof prisma.salesOrder.update>> }

/**
 * Đẩy lại 1 đơn đã lưu sang SAP.
 * - auto: lượt của job nền (tăng bộ đếm thử lại)
 * - force: người dùng đã đối chiếu và xác nhận SAP CHƯA có đơn → cho đẩy
 *   lại đơn đang ở trạng thái "Cần đối chiếu"
 */
export async function syncOrderToSap(
  orderId: string,
  opts: { auto?: boolean; force?: boolean; fallbackDatabaseId?: string | null } = {},
): Promise<SyncOrderOutcome> {
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!order) return { kind: 'not_found' }
  if (order.status === 'Cancelled') return { kind: 'cancelled' }
  if (order.isDraft) return { kind: 'draft' }
  if (order.sapSyncStatus === 'synced') return { kind: 'already_synced', sapDocNum: order.sapDocNum }
  // Không rõ SAP đã ghi chưa + không có UDF tra lại → đẩy lại có thể tạo trùng
  if (order.sapSyncErrorKind === 'reconcile' && !opts.force) return { kind: 'needs_reconcile', error: order.sapSyncError }
  // Khóa chống đẩy song song: 2 lượt cùng lúc không thể tạo trùng chứng từ SAP
  if (!acquireOrderPushLock(order.id)) return { kind: 'locked' }

  try {
    const push = await pushOrderToSap({
      // Đơn ghi nhận DB đích khi tạo — retry luôn dùng đúng DB đó
      databaseId: order.sapDatabaseId ?? opts.fallbackDatabaseId ?? null,
      cardCode: order.cardCode,
      docDate: order.docDate.toISOString(),
      docDueDate: order.docDueDate.toISOString(),
      comments: order.remarks,
      headerDiscPct: Number(order.headerDiscPct) || 0,
      localId: order.id,
      // B2B / SAP B1 (Đợt 2+3): các trường header đã lưu trên DB — tầng push
      // (buildSapDocPayload → sapDocHeaderExtras) chỉ gửi khi có giá trị
      ...headerExtrasFromRecord(order),
      lines: order.lines.map((l) => ({
        itemCode: l.itemCode,
        ...bomLineFields(l),
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discPct: l.discPct,
        uom: l.uom,
        taxCode: l.taxCode,
        warehouseCode: l.warehouseCode,
        // Đơn tạo từ báo giá (from-quotation): giữ sourceLineId để đẩy lại
        // vẫn gắn BaseType/BaseEntry/BaseLine chuẩn copy-to SAP B1
        sourceLineId: l.sourceLineId,
      })),
    })
    const rec = await recordOrderPush(push, order.lines, { prevAttempts: order.sapSyncAttempts, auto: opts.auto })
    const updated = await prisma.salesOrder.update({ where: { id: order.id }, data: rec.data })
    return { kind: 'done', ok: rec.syncedOk, status: rec.status, error: rec.error, push, order: updated }
  } finally {
    releaseOrderPushLock(order.id)
  }
}
