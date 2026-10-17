import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { fetchSapOrders, type SapOrderRow } from '@/lib/sap-orders'
import { mergeOrders, computeStats, type LocalOrderInput } from '@/lib/fm-dashboard-merge'

// GET /api/stats — số liệu dashboard.
// Gộp đơn SAP B1 live + đơn local (khử trùng theo DocEntry: đơn local đã synced
// mà SAP vẫn còn thì giữ bản SAP — giống trang Đơn hàng). SAP lỗi → fallback
// local-only kèm warning (không chặn hiển thị).
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  // B1: cách ly DB (giống trang Đơn hàng)
  const s = await loadSapSettings(user.databaseId)
  const dbScope = user.databaseId ? { OR: [{ sapDatabaseId: user.databaseId }, { sapDatabaseId: null }] } : {}

  const localOrders = await prisma.salesOrder.findMany({
    where: dbScope,
    select: {
      id: true,
      docNum: true,
      cardCode: true,
      cardName: true,
      docDate: true,
      docDueDate: true,
      status: true,
      grandTotal: true,
      sapSyncStatus: true,
      sapDocEntry: true,
    },
  })

  let sapRows: SapOrderRow[] = []
  let sapUsed = false
  let warning: string | undefined
  if (isSapConfigured(s)) {
    // Tận dụng cache 45s của fetchSapOrders (trang Đơn hàng cũng dùng chung)
    const live = await fetchSapOrders(s, {})
    if (live.ok && live.data) {
      sapRows = live.data
      sapUsed = true
    } else {
      warning = `Không truy vấn được SAP B1 (${live.error ?? 'lỗi không rõ'}) — đang hiển thị số liệu local`
    }
  }

  const merged = mergeOrders(sapRows, localOrders as unknown as LocalOrderInput[])
  const stats = computeStats(merged)

  return NextResponse.json({
    ...stats,
    sources: { sap: sapUsed },
    ...(warning ? { warning } : {}),
  })
}
