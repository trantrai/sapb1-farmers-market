import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'

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
  // Che mật khẩu
  return NextResponse.json({
    settings: {
      ...s,
      sapPassword: s.sapPassword ? '••••••••' : '',
      smtpPass: s.smtpPass ? '••••••••' : '',
    },
    hasPassword: Boolean(s.sapPassword),
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
    const { serviceLayerUrl, companyDb, sapUser, sapPassword } = body as {
      serviceLayerUrl?: string; companyDb?: string; sapUser?: string
      sapPassword?: string
      sslSkipVerify?: boolean
      suggestHistoryDays?: number
      suggestMaxItems?: number
    }

    const existing = await prisma.appSettings.findUnique({ where: { id: 'main' } })
    const clampDays = (v: unknown, fallback: number) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(365, Math.max(7, Math.round(n))) : fallback
    }
    const clampMax = (v: unknown, fallback: number) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.round(n))) : fallback
    }
    const data = {
      serviceLayerUrl: serviceLayerUrl ?? existing?.serviceLayerUrl ?? '',
      companyDb: companyDb ?? existing?.companyDb ?? '',
      sapUser: sapUser ?? existing?.sapUser ?? '',
      // Nếu mật khẩu gửi về là dạng che hoặc rỗng thì giữ nguyên mật khẩu cũ
      sapPassword:
        !sapPassword || sapPassword.includes('•')
          ? existing?.sapPassword ?? ''
          : sapPassword,
      // Bỏ qua xác thực SSL (chỉ nhận khi client gửi rõ ràng kiểu boolean)
      sslSkipVerify:
        typeof body.sslSkipVerify === 'boolean'
          ? (body as { sslSkipVerify: boolean }).sslSkipVerify
          : existing?.sslSkipVerify ?? false,
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
          : (body.smtpPass as string),
      smtpFromEmail: (body.smtpFromEmail as string | undefined) ?? existing?.smtpFromEmail ?? '',
      smtpFromName: (body.smtpFromName as string | undefined) ?? existing?.smtpFromName ?? '',
    }

    const saved = await prisma.appSettings.upsert({
      where: { id: 'main' },
      update: data,
      create: { id: 'main', ...data },
    })

    return NextResponse.json({
      ok: true,
      settings: {
        ...saved,
        sapPassword: saved.sapPassword ? '••••••••' : '',
        smtpPass: saved.smtpPass ? '••••••••' : '',
      },
    })
  } catch (e) {
    console.error('PUT /api/settings', e)
    return NextResponse.json({ error: 'Không thể lưu cài đặt' }, { status: 500 })
  }
}
