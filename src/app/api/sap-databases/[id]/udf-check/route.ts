import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { rateLimit } from '@/lib/rate-limit'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { checkLocalIdUdf, UDF_LOCAL_ID } from '@/lib/sap-push-document'

// POST /api/sap-databases/[id]/udf-check — CHỈ ĐỌC: DB SAP đã có UDF chống trùng
// U_FM_LocalId trên Đơn bán hàng (ORDR) chưa. Không tạo UDF — người dùng tự tạo
// trong SAP B1 (Tools → Customization Tools → User-Defined Fields - Management).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền kiểm tra cấu hình SAP B1' }, { status: 403 })
  }
  const rl = rateLimit(`sapdb:udf:${user.id}`, 10, 10 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: `Kiểm tra quá nhiều lần — thử lại sau ${rl.retryAfterSec} giây.` }, { status: 429 })
  }
  const { id } = await ctx.params
  const s = await loadSapSettings(id)
  if (s?.dbId !== id) return NextResponse.json({ error: 'Database không tồn tại' }, { status: 404 })
  if (!isSapConfigured(s)) return NextResponse.json({ error: 'Database chưa cấu hình kết nối SAP B1' }, { status: 400 })
  const r = await checkLocalIdUdf(s, 'Orders')
  if (r.error) return NextResponse.json({ ok: false, field: UDF_LOCAL_ID, error: r.error }, { status: 502 })
  return NextResponse.json({ ok: true, field: UDF_LOCAL_ID, supported: r.supported })
}
