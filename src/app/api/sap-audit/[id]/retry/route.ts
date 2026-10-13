import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGet, sapPost, sapPatch } from '@/lib/sap-service-layer'

// ============================================================
// POST /api/sap-audit/[id]/retry — gửi LẠI lệnh gọi Service Layer
// đã ghi trong nhật ký audit:
//   - POST /Orders  → gửi lại payload gốc (lưu ý: có thể tạo chứng từ trùng)
//   - PATCH /Orders → gửi lại payload PATCH (cập nhật lại chứng từ)
//   - POST /Login   → đăng nhập lại bằng cấu hình HIỆN TẠI (payload gốc đã che mật khẩu)
//   - GET …         → gọi lại đúng path+query đã lưu (không thay đổi dữ liệu)
// Kết quả được ghi vào audit với retryOf = id bản ghi gốc.
// ============================================================

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền Retry lệnh gọi Service Layer' }, { status: 403 })
  }

  const { id } = await ctx.params
  const entry = await prisma.sapAuditLog.findUnique({ where: { id } })
  if (!entry) {
    return NextResponse.json({ error: 'Không tìm thấy bản ghi nhật ký' }, { status: 404 })
  }

  // Retry dùng DB GỐC của bản ghi audit (đơn được đẩy từ DB nào → retry đúng DB đó);
  // bản ghi cũ chưa có sapDatabaseId thì fallback DB của phiên hiện tại
  const s = await loadSapSettings(entry.sapDatabaseId ?? user.databaseId)
  if (!isSapConfigured(s)) {
    return NextResponse.json({ error: 'Chưa cấu hình SAP B1 Service Layer — hãy cấu hình ở trang Cài đặt trước khi Retry' }, { status: 400 })
  }

  if (entry.method === 'POST') {
    // POST /Login: payload gốc đã che mật khẩu → dựng lại từ cấu hình hiện tại
    if (entry.path === '/Login') {
      const res = await sapPost<Record<string, unknown>>(s, '/Login', {
        CompanyDB: s.companyDb,
        UserName: s.sapUser,
        Password: s.sapPassword,
      }, { retryOf: id })
      return NextResponse.json({
        ok: res.ok,
        retryOf: id,
        httpStatus: res.status,
        error: res.error,
        result: res.ok ? { Version: res.data?.Version } : undefined,
      })
    }

    let payload: unknown
    try {
      payload = entry.payload ? JSON.parse(entry.payload) : {}
    } catch {
      return NextResponse.json({ error: 'Payload gốc không đọc được — không thể Retry' }, { status: 400 })
    }
    const res = await sapPost(s, entry.path, payload, { retryOf: id })
    return NextResponse.json({
      ok: res.ok,
      retryOf: id,
      httpStatus: res.status,
      error: res.error,
      result: res.ok ? (res.data as Record<string, unknown>) : undefined,
    })
  }

  // PATCH: gửi lại payload PATCH đã lưu (cập nhật chứng từ — không tạo mới)
  if (entry.method === 'PATCH') {
    let payload: unknown
    try {
      payload = entry.payload ? JSON.parse(entry.payload) : {}
    } catch {
      return NextResponse.json({ error: 'Payload gốc không đọc được — không thể Retry' }, { status: 400 })
    }
    const res = await sapPatch(s, entry.path, payload, { retryOf: id })
    return NextResponse.json({
      ok: res.ok,
      retryOf: id,
      httpStatus: res.status,
      error: res.error,
      result: res.ok ? ((res.data as Record<string, unknown>) ?? { updated: entry.path }) : undefined,
    })
  }

  // GET: gọi lại đúng path+query đã lưu (path có thể kèm ?$filter=…)
  const res = await sapGet(s, entry.path, {}, { audit: 'always', retryOf: id })
  return NextResponse.json({
    ok: res.ok,
    retryOf: id,
    httpStatus: res.status,
    error: res.error,
    result: res.ok ? (res.data as Record<string, unknown>) : undefined,
  })
}
