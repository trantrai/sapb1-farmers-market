import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { loadSapSettings, isSapConfigured, sapGet } from '@/lib/sap-service-layer'

const odataEscape = (s: string) => s.replace(/'/g, "''")

// OData v2 của Service Layer trả số thập phân (Edm.Decimal) dạng CHUỖI
// (vd "185000.000000") — bắt buộc ép số, nếu không giá sẽ thành 0 trên SL thật
const numv = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)

// GET /api/items/price?itemCode=&cardCode= — giải đơn giá bán cho 1 mặt hàng
// Ưu tiên GIÁ ĐẶC BIỆT (bảng OSPP / SpecialPrices) theo cặp Mặt hàng + Khách hàng;
// tìm thấy thì DÙNG LUÔN và dừng; không tìm thấy → lấy giá từ ItemPrices Price List 1.
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()

  const itemCode = (req.nextUrl.searchParams.get('itemCode') ?? '').trim()
  const cardCode = (req.nextUrl.searchParams.get('cardCode') ?? '').trim()
  if (!itemCode) return NextResponse.json({ ok: false, error: 'Thiếu itemCode' }, { status: 400 })

  // ---------- 1) Live từ SAP B1 ----------
  const s = await loadSapSettings()
  if (isSapConfigured(s)) {
    // 1a) Giá đặc biệt OSPP (SpecialPrices)
    // ⚠ KHÔNG dùng $select: một số bản Service Layer trả 400 khi $select chứa
    // thuộc tính không có trong metadata (vd PriceList — tên thật là PriceListNo).
    // Bản ghi lọc theo 2 khóa rất ít nên lấy nguyên văn vẫn nhẹ. Cũng KHÔNG dùng
    // $top để tránh khác biệt giữa các phiên bản OData.
    if (cardCode) {
      const sp = await sapGet<{ value?: { Price?: number | string; Currency?: string; DiscountPercent?: number | string; PriceListNo?: number | string; PriceList?: number | string }[] }>(
        s,
        '/SpecialPrices',
        { $filter: `ItemCode eq '${odataEscape(itemCode)}' and CardCode eq '${odataEscape(cardCode)}'` },
      )
      if (sp.ok && sp.data) {
        const rows = sp.data.value ?? []
        // Ưu tiên dòng bảng giá 1 (tên trường tùy phiên bản: PriceListNo | PriceList);
        // không có → dùng dòng đầu tiên
        const pl1 = rows.find((r) => numv(r.PriceListNo ?? r.PriceList) === 1)
        const row = pl1 ?? rows[0]
        if (row) {
          const raw = numv(row.Price)
          const disc = numv(row.DiscountPercent)
          const price = Math.round(raw * (1 - disc / 100))
          if (price > 0) {
            return NextResponse.json({ ok: true, price, source: 'special', discountPercent: disc, currency: row.Currency ?? '' })
          }
        }
      }
      // không tìm thấy giá đặc biệt (hoặc Price <= 0) → rơi xuống giá theo bảng giá
    }

    // 1b) Fallback: giá từ Price List 1
    const it = await sapGet<{ value?: { ItemPrices?: { PriceList?: number | string; Price?: number | string }[] }[] }>(
      s,
      '/Items',
      {
        $select: 'ItemPrices',
        $filter: `ItemCode eq '${odataEscape(itemCode)}'`,
        $top: '1',
      },
    )
    if (it.ok && it.data?.value?.length) {
      const price = it.data.value[0].ItemPrices?.find((p) => numv(p.PriceList) === 1)?.Price
      const nPrice = numv(price)
      if (nPrice > 0) {
        return NextResponse.json({ ok: true, price: nPrice, source: 'pricelist' })
      }
      return NextResponse.json({ ok: false, error: 'Mặt hàng chưa có giá trong Price List 1' })
    }
    return NextResponse.json({ ok: false, error: it.error ?? 'Không lấy được giá từ Service Layer' })
  }

  // ---------- 2) Fallback dữ liệu local (không có bảng giá đặc biệt) ----------
  const item = await prisma.item.findUnique({ where: { itemCode } })
  if (!item || !(item.price > 0)) {
    return NextResponse.json({ ok: false, error: 'Không tìm thấy giá bán của mặt hàng (local)' })
  }
  return NextResponse.json({ ok: true, price: item.price, source: 'pricelist' })
}
