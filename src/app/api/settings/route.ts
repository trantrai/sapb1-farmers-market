import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { encryptSecret } from '@/lib/fm-crypto'

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem cài đặt' }, { status: 403 })
  }

  let s = await prisma.appSettings.findUnique({ where: { id: 'main' } })
  if (!s) {
    s = await prisma.appSettings.create({ data: { id: 'main' } })
  }
  // Che mật khẩu SMTP. Kết nối SAP B1 giờ quản lý theo database riêng
  // ở /api/sap-databases — các field SAP singleton cũ không còn dùng.
  const { serviceLayerUrl: _u, companyDb: _d, sapUser: _su, sapPassword: _sp, sslSkipVerify: _sv, connected: _c, lastSyncAt: _ls, ...rest } = s
  return NextResponse.json({
    settings: {
      ...rest,
      smtpPass: s.smtpPass ? '••••••••' : '',
    },
    hasSmtpPass: Boolean(s.smtpPass),
  })
}

export async function PUT(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.settings?.edit) {
    return NextResponse.json({ error: 'Bạn không có quyền chỉnh sửa cài đặt' }, { status: 403 })
  }

  try {
    const body = await req.json()

    const existing = await prisma.appSettings.findUnique({ where: { id: 'main' } })
    const clampDays = (v: unknown, fallback: number) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(365, Math.max(7, Math.round(n))) : fallback
    }
    const clampMax = (v: unknown, fallback: number) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.round(n))) : fallback
    }
    // Lưu ý: kết nối SAP B1 quản lý theo database riêng ở /api/sap-databases;
    // PUT này chỉ nhận gợi ý mặt hàng + SMTP (bỏ qua mọi field SAP nếu client cũ gửi lên).
    const data = {
      // Gợi ý mặt hàng theo lịch sử đơn hàng
      suggestHistoryDays: clampDays(body.suggestHistoryDays, existing?.suggestHistoryDays ?? 90),
      suggestMaxItems: clampMax(body.suggestMaxItems, existing?.suggestMaxItems ?? 10),
      // Cấu hình Email (SMTP)
      smtpHost: (body.smtpHost as string | undefined) ?? existing?.smtpHost ?? '',
      smtpPort: (() => {
        const n = Number(body.smtpPort)
        return Number.isFinite(n) ? Math.min(65535, Math.max(1, Math.round(n))) : existing?.smtpPort ?? 587
      })(),
      smtpUser: (body.smtpUser as string | undefined) ?? existing?.smtpUser ?? '',
      smtpPass:
        !(body.smtpPass as string | undefined) || (body.smtpPass as string).includes('•')
          ? existing?.smtpPass ?? ''
          : encryptSecret(body.smtpPass as string),
      smtpFromEmail: (body.smtpFromEmail as string | undefined) ?? existing?.smtpFromEmail ?? '',
      smtpFromName: (body.smtpFromName as string | undefined) ?? existing?.smtpFromName ?? '',
    }

    const saved = await prisma.appSettings.upsert({
      where: { id: 'main' },
      update: data,
      create: { id: 'main', ...data },
    })

    const { serviceLayerUrl: _u2, companyDb: _d2, sapUser: _su2, sapPassword: _sp2, sslSkipVerify: _sv2, connected: _c2, lastSyncAt: _ls2, ...savedRest } = saved
    return NextResponse.json({
      ok: true,
      settings: {
        ...savedRest,
        smtpPass: saved.smtpPass ? '••••••••' : '',
      },
    })
  } catch (e) {
    console.error('PUT /api/settings', e)
    return NextResponse.json({ error: 'Không thể lưu cài đặt' }, { status: 500 })
  }
}
