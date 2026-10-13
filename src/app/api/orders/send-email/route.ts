import { NextRequest, NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { decryptSecret } from '@/lib/fm-crypto'
import { rateLimit } from '@/lib/rate-limit'

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(n || 0)) + ' ₫'

const fmtDate = (d: Date | string) => {
  const dt = d instanceof Date ? d : new Date(d)
  return dt.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function buildOrderHtml(
  order: any,
  partner: { address?: string | null; contactPerson?: string | null; contactPhone?: string | null } | null,
  customMessage?: string,
) {
  const rows = (order.lines ?? [])
    .sort((a: any, b: any) => (a.lineNum ?? 0) - (b.lineNum ?? 0))
    .map((l: any, i: number) => {
      const afterDisc = (l.unitPrice ?? 0) * (l.quantity ?? 0) * (1 - (l.discPct ?? 0) / 100)
      const total = afterDisc * (1 + (l.vatPct ?? 0) / 100)
      return `<tr>
        <td style="padding:8px;border:1px solid #e5e7eb;">${i + 1}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;"><b>${esc(l.itemCode)}</b></td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${esc(l.itemName)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${l.quantity}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${esc(l.uom)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${fmtVND(l.unitPrice)}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${l.discPct ?? 0}%</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${l.vatPct ?? 0}%</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;"><b>${fmtVND(total)}</b></td>
      </tr>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"></head>
<body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;max-width:760px;margin:0 auto;padding:16px;">
  <div style="background:#0e1c2f;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
    <div style="font-size:20px;font-weight:bold;">FARMERS MARKET</div>
    <div style="font-size:12px;color:#cbd5e1;">Hệ thống Sale Order — SAP Business One</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
    <h2 style="margin:0 0 4px;color:#0e1c2f;">PHIẾU BÁN HÀNG SO-${order.docNum}</h2>
    ${customMessage ? `<p style="background:#f8f9ff;border-left:3px solid #fea619;padding:10px 12px;">${esc(customMessage).replace(/\n/g, '<br>')}</p>` : ''}
    <table style="width:100%;margin:12px 0;font-size:13px;">
      <tr><td style="padding:4px 0;"><b>Khách hàng:</b> ${esc(order.cardName)} (${esc(order.cardCode)})</td>
          <td style="padding:4px 0;"><b>Ngày chứng từ:</b> ${fmtDate(order.docDate)}</td></tr>
      <tr><td style="padding:4px 0;"><b>Địa chỉ:</b> ${esc(partner?.address || '—')}</td>
          <td style="padding:4px 0;"><b>Ngày giao hàng:</b> ${fmtDate(order.docDueDate)}</td></tr>
      <tr><td style="padding:4px 0;"><b>Người liên hệ:</b> ${esc(partner?.contactPerson || '—')}${partner?.contactPhone ? ` · ${esc(partner.contactPhone)}` : ''}</td>
          <td style="padding:4px 0;"><b>Người lập:</b> ${esc(order.createdBy)}</td></tr>
    </table>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#0e1c2f;color:#fff;">
        <th style="padding:8px;border:1px solid #0e1c2f;">STT</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">Mã hàng</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">Tên hàng</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">SL</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">ĐVT</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">Đơn giá</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">CK%</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">VAT%</th>
        <th style="padding:8px;border:1px solid #0e1c2f;">Thành tiền</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="8" style="padding:8px;border:1px solid #e5e7eb;text-align:right;">Tổng tiền hàng:</td>
            <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${fmtVND(order.totalBeforeDisc)}</td></tr>
        <tr><td colspan="8" style="padding:8px;border:1px solid #e5e7eb;text-align:right;">Tiền VAT:</td>
            <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;">${fmtVND(order.vatAmt)}</td></tr>
        <tr><td colspan="8" style="padding:8px;border:1px solid #e5e7eb;text-align:right;"><b>TỔNG CỘNG THANH TOÁN:</b></td>
            <td style="padding:8px;border:1px solid #e5e7eb;text-align:right;"><b>${fmtVND(order.grandTotal)}</b></td></tr>
      </tfoot>
    </table>
    ${order.remarks ? `<p style="font-size:13px;"><b>Ghi chú:</b> ${esc(order.remarks)}</p>` : ''}
    <p style="font-size:11px;color:#6b7280;margin-top:16px;">Email được gửi tự động từ hệ thống Farmers Market — SAP B1 Sale Order.</p>
  </div>
</body></html>`
}

// ---------- POST : gửi email đơn hàng ----------
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.orders?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xem đơn hàng' }, { status: 403 })
  }

  // Giới hạn theo user: tối đa 10 email / 10 phút (chống spam email)
  const rl = rateLimit(`order:send-email:${user.id}`, 10, 10 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'Bạn đã gửi quá nhiều email — vui lòng thử lại sau' },
      { status: 429 },
    )
  }

  try {
    const body = await req.json().catch(() => null)
    const { orderId, toEmail, subject, message } = (body ?? {}) as {
      orderId?: string; toEmail?: string; subject?: string; message?: string
    }
    if (!orderId) return NextResponse.json({ error: 'Thiếu orderId' }, { status: 400 })
    if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      return NextResponse.json({ error: 'Email người nhận không hợp lệ' }, { status: 400 })
    }

    const settings = await prisma.appSettings.findUnique({ where: { id: 'main' } })
    if (!settings?.smtpHost || !settings?.smtpUser || !settings?.smtpPass) {
      return NextResponse.json({ error: 'Chưa cấu hình SMTP. Vui lòng vào Cài đặt → Cấu hình Email.' }, { status: 400 })
    }

    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    if (!order) return NextResponse.json({ error: 'Không tìm thấy đơn hàng' }, { status: 404 })

    const partner = await prisma.businessPartner.findFirst({
      where: {
        cardCode: order.cardCode,
        ...(order.sapDatabaseId ? { sapDatabaseId: order.sapDatabaseId } : {}),
      },
    })

    const transporter = nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort || 587,
      secure: (settings.smtpPort || 587) === 465,
      auth: { user: settings.smtpUser, pass: decryptSecret(settings.smtpPass) },
    })

    const fromName = settings.smtpFromName || 'Farmers Market'
    const fromEmail = settings.smtpFromEmail || settings.smtpUser
    const mailSubject = subject?.trim() || `Phiếu bán hàng SO-${order.docNum} — ${order.cardName}`

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: toEmail,
      subject: mailSubject,
      html: buildOrderHtml(order, partner, message),
    })

    return NextResponse.json({ ok: true, message: `Đã gửi email đến ${toEmail}` })
  } catch (e: any) {
    console.error('POST /api/orders/send-email', e)
    return NextResponse.json({ error: `Gửi email thất bại: ${e?.message ?? 'lỗi không xác định'}` }, { status: 500 })
  }
}
