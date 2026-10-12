// ============================================================
// MOCK SAP B1 SERVICE LAYER — dùng để kiểm thử tích hợp local
// Mô phỏng: POST /Login, GET /BusinessPartners, GET /Items
// Chạy: bun scripts/mock-sap-server.ts  (port 9090)
// Đăng nhập mock: CompanyDB bất kỳ, user=manager, pass=Sap@1234
// ============================================================
/// <reference types="bun-types" />

interface MockBP { CardCode: string; CardName: string; Address: string; Phone1: string; CardType: string }
interface MockItem { ItemCode: string; ItemName: string; InventoryUOM: string; SalesUnit: string; BarCode: string; SalesVATGroup: string; QuantityOnStock: number; SalesItem: string; ItemPrices: { PriceList: number; Price: number }[] }

const PARTNERS: MockBP[] = [
  { CardCode: 'C20001', CardName: 'Cửa hàng Rau Sạch Đà Lạt', Address: '12 Nguyễn Trãi, Q.1, TP.HCM', Phone1: '0903123456', CardType: 'C' },
  { CardCode: 'C20002', CardName: 'Siêu Thị Xanh Quận 7', Address: '45 Nguyễn Hữu Thọ, Q.7', Phone1: '0912888777', CardType: 'C' },
  { CardCode: 'C20003', CardName: 'Hộ kinh doanh Lê Thị Bé', Address: '78 Lò Đúc, Hà Nội', Phone1: '0987654321', CardType: 'C' },
  { CardCode: 'C20004', CardName: 'Nhà hàng Cả Mắm', Address: '9 Võ Văn Tần, Q.3', Phone1: '0909123123', CardType: 'C' },
  { CardCode: 'C20005', CardName: 'Công ty CP Thực phẩm Sạch VN', Address: '22 Trường Chinh, Đà Nẵng', Phone1: '0240123456', CardType: 'C' },
  { CardCode: 'C20006', CardName: 'Trường Mầm non Hạt Mầm', Address: '34 Đường số 7, Bình Thạnh', Phone1: '02835123456', CardType: 'C' },
  { CardCode: 'N30001', CardName: 'Nông trại Cúc Phương', Address: 'Ninh Bình', Phone1: '', CardType: 'S' },
]

const ITEMS: MockItem[] = [
  { ItemCode: 'FM-RAU-001', ItemName: 'Rau Muống Tươi', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000011', SalesVATGroup: 'S2', QuantityOnStock: 120.5, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 12000 }] },
  { ItemCode: 'FM-RAU-002', ItemName: 'Cải Ngọt Bio', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000028', SalesVATGroup: 'S2', QuantityOnStock: 80, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 18000 }] },
  { ItemCode: 'FM-RAU-003', ItemName: 'Rau Dền Đỏ', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000035', SalesVATGroup: 'S2', QuantityOnStock: 45, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 15000 }] },
  { ItemCode: 'FM-QUA-001', ItemName: 'Cà Chua Bi Đà Lạt', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000042', SalesVATGroup: 'S2', QuantityOnStock: 60, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 32000 }] },
  { ItemCode: 'FM-QUA-002', ItemName: 'Bí Đỏ Hữu Cơ', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000059', SalesVATGroup: 'S2', QuantityOnStock: 200, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 21000 }] },
  { ItemCode: 'FM-CU-001', ItemName: 'Cà Rốt Đà Lạt', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000066', SalesVATGroup: 'S2', QuantityOnStock: 150, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 14000 }] },
  { ItemCode: 'FM-UA-001', ItemName: 'Khoai Lang Tím', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000073', SalesVATGroup: 'S2', QuantityOnStock: 90, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 16000 }] },
  { ItemCode: 'FM-UA-002', ItemName: 'Khoai Tây Jinju', InventoryUOM: 'kg', SalesUnit: 'kg', BarCode: '8934500000080', SalesVATGroup: 'S2', QuantityOnStock: 75, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 25000 }] },
  { ItemCode: 'FM-DAC-001', ItemName: 'Mật Ong Rừng Nguyên Chất 500ml', InventoryUOM: 'chai', SalesUnit: 'chai', BarCode: '8934500000097', SalesVATGroup: 'S8', QuantityOnStock: 40, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 185000 }] },
  { ItemCode: 'FM-DAC-002', ItemName: 'Nước Mắm Cá Cơm Đảo 45 độ', InventoryUOM: 'chai', SalesUnit: 'chai', BarCode: '8934500000103', SalesVATGroup: 'S8', QuantityOnStock: 55, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 95000 }] },
  { ItemCode: 'FM-DAC-003', ItemName: 'Trà Hoa Cúc Đà Lạt 200g', InventoryUOM: 'gói', SalesUnit: 'gói', BarCode: '8934500000110', SalesVATGroup: 'S8', QuantityOnStock: 0, SalesItem: 'tYES', ItemPrices: [{ PriceList: 1, Price: 68000 }] },
  { ItemCode: 'FM-NGHIEP-001', ItemName: 'Phân bón hữu cơ vi sinh (không bán)', InventoryUOM: 'bao', SalesUnit: 'bao', BarCode: '8934500000127', SalesVATGroup: 'S1', QuantityOnStock: 10, SalesItem: 'tNO', ItemPrices: [{ PriceList: 1, Price: 300000 }] },
]

// Giá bán đặc biệt (bảng OSPP) — theo cặp Mặt hàng + Khách hàng + Bảng giá.
// Giống metadata SL thật: tên trường là PriceListNo (KHÔNG phải PriceList).
const SPECIAL_PRICES: { ItemCode: string; CardCode: string; Price: number; Currency: string; DiscountPercent: number; PriceListNo: number }[] = [
  { ItemCode: 'FM-QUA-001', CardCode: 'C20001', Price: 30000, Currency: 'VND', DiscountPercent: 0, PriceListNo: 1 },
  { ItemCode: 'FM-QUA-001', CardCode: 'C20001', Price: 35000, Currency: 'VND', DiscountPercent: 0, PriceListNo: 2 },
  { ItemCode: 'FM-RAU-001', CardCode: 'C20002', Price: 11500, Currency: 'VND', DiscountPercent: 5, PriceListNo: 1 },
]

// Nhóm thuế (bảng OVTG) — mã thuế → thuế suất %
const VAT_GROUPS: { Code: string; Name: string; Rate: number }[] = [
  { Code: 'S1', Name: 'VAT 10%', Rate: 10 },
  { Code: 'S2', Name: 'VAT 5%', Rate: 5 },
  { Code: 'S8', Name: 'VAT 8%', Rate: 8 },
]

// Kho hàng (bảng OWHS) — cho GET /Warehouses + tách tồn kho trong /InventoryItems
const WAREHOUSES: { WarehouseCode: string; WarehouseName: string }[] = [
  { WarehouseCode: '01', WarehouseName: 'Kho chính TP.HCM' },
  { WarehouseCode: '02', WarehouseName: 'Kho lạnh Đà Lạt' },
  { WarehouseCode: '03', WarehouseName: 'Kho thực phẩm khô Hà Nội' },
]

/** Tồn kho theo kho của 1 mặt hàng — dùng chung cho /InventoryItems và ItemWarehouseInfo */
function stockRowsFor(it: MockItem) {
  const shares = [0.6, 0.25, 0.15]
  return WAREHOUSES.map((w, idx) => {
    const inStock = Math.round(it.QuantityOnStock * shares[idx] * 10) / 10
    const committed = inStock > 0 ? Math.min(inStock, Math.round(inStock * 0.1)) : 0
    const onOrder = it.ItemCode.charCodeAt(it.ItemCode.length - 1) % 3 === 0 ? 20 : 0
    return { WarehouseCode: w.WarehouseCode, InStock: inStock, IsCommitted: committed, OnOrder: onOrder }
  })
}

// ---------- Đơn hàng bán (ORDR/RDR1) — nhận POST /Orders, trả GET /Orders ----------
interface MockDocLineInput { ItemCode: string; Quantity: number; UnitPrice: number; DiscountPercent?: number; VatGroup?: string; WarehouseCode?: string }
interface MockOrderLine {
  LineNum: number; ItemCode: string; ItemDescription: string; Quantity: number; Price: number
  DiscountPercent: number; LineTotal: number; VatGroup: string; MeasureUnit: string; VatSum: number; WarehouseCode?: string
}
interface MockOrder {
  DocEntry: number
  DocNum: number
  CardCode: string
  CardName: string
  DocDate: string
  DocDueDate: string
  Comments?: string
  DocumentStatus: string
  DocTotal: number
  VatSum: number
  /** Chiết khấu ĐẦU CHỨNG TỪ % (SAP: Documents.DiscountPercent) */
  DiscountPercent?: number
  /** Số tiền CK đầu chứng từ (DocTotal đã trừ) */
  DocDiscount?: number
  DocumentLines: MockOrderLine[]
}
const ORDERS: MockOrder[] = []
let orderSeq = 0 // DocEntry tăng dần từ 1; DocNum = 1000 + DocEntry

const odataEscape = (s: string) => s.replace(/'/g, "''")

/**
 * Dựng chứng từ RDR1 đầy đủ từ payload POST /Orders: tra thông tin mặt hàng
 * (tên, đơn vị tính, mã thuế) và tính LineTotal/VatSum/DocTotal như SAP thật.
 * Ném Error với message tiếng Anh kiểu SAP khi payload sai.
 */
function buildOrder(body: { CardCode?: string; DocDate?: string; DocDueDate?: string; Comments?: string; DiscountPercent?: number | string; DocumentLines?: MockDocLineInput[] }): MockOrder {
  if (!body?.CardCode || !Array.isArray(body.DocumentLines) || body.DocumentLines.length === 0) {
    throw new Error('Invalid payload — CardCode and DocumentLines are required')
  }
  const bp = PARTNERS.find((p) => p.CardCode === body.CardCode)
  if (!bp) throw new Error(`Invalid CardCode '${body.CardCode}'`)
  if (bp.CardType !== 'C') throw new Error(`'${bp.CardCode}' is not a customer account`)

  const lines: MockOrderLine[] = body.DocumentLines.map((l, i) => {
    const item = ITEMS.find((x) => x.ItemCode === l.ItemCode)
    if (!item) throw new Error(`Invalid ItemCode '${l.ItemCode}' in DocumentLines/${i}`)
    if (!(Number(l.Quantity) > 0)) throw new Error(`Invalid Quantity in DocumentLines/${i}`)
    const price = Number(l.UnitPrice) || 0
    const qty = Number(l.Quantity) || 0
    const disc = Number(l.DiscountPercent) || 0
    const lineTotal = Math.round(qty * price * (1 - disc / 100))
    const vg = l.VatGroup || item.SalesVATGroup || ''
    const rate = VAT_GROUPS.find((v) => v.Code === vg)?.Rate ?? 0
    const vatSum = rate > 0 ? Math.round((lineTotal * rate) / 100) : 0
    if (l.WarehouseCode && !WAREHOUSES.some((w) => w.WarehouseCode === l.WarehouseCode)) {
      throw new Error(`Invalid WarehouseCode '${l.WarehouseCode}' in DocumentLines/${i}`)
    }
    return {
      LineNum: i + 1,
      ItemCode: l.ItemCode,
      ItemDescription: item.ItemName,
      Quantity: qty,
      Price: price,
      DiscountPercent: disc,
      LineTotal: lineTotal,
      VatGroup: vg,
      MeasureUnit: item.SalesUnit || item.InventoryUOM,
      VatSum: vatSum,
      ...(l.WarehouseCode ? { WarehouseCode: l.WarehouseCode } : {}),
    }
  })
  const docDiscPct = Math.min(100, Math.max(0, Number(body.DiscountPercent) || 0))
  const docDiscount = applyDocDiscount(lines, docDiscPct)
  return {
    DocEntry: ++orderSeq,
    DocNum: 1000 + orderSeq,
    CardCode: bp.CardCode,
    CardName: bp.CardName,
    DocDate: body.DocDate ?? new Date().toISOString().slice(0, 10),
    DocDueDate: body.DocDueDate ?? body.DocDate ?? new Date().toISOString().slice(0, 10),
    Comments: body.Comments,
    DocumentStatus: 'O',
    DocTotal: lines.reduce((s, l) => s + l.LineTotal + l.VatSum, 0) - docDiscount,
    VatSum: lines.reduce((s, l) => s + l.VatSum, 0),
    ...(docDiscPct > 0 ? { DiscountPercent: docDiscPct, DocDiscount: docDiscount } : {}),
    DocumentLines: lines,
  }
}

/**
 * Phân bổ CK đầu chứng từ về từng dòng (floor từng dòng, phần dư cộng cho dòng
 * có tiền lớn nhất — cùng công thức order-calc của app) và TÍNH LẠI VatSum trên
 * phần SAU CK đầu — SAP B1 thật tính thuế trên tiền sau CK đầu, mock phải y
 * hệt để đọc lại chứng từ khớp từng đồng với số app đã lưu.
 * Trả về docDiscount = tổng tiền CK đầu đã phân bổ (0 khi pct = 0).
 */
function applyDocDiscount(lines: MockOrderLine[], pct: number): number {
  const lineSum = lines.reduce((s, l) => s + l.LineTotal, 0)
  const docDiscount = pct > 0 && lineSum > 0 ? Math.round((lineSum * pct) / 100) : 0
  if (docDiscount <= 0) return 0
  let allocated = 0
  const shares = lines.map((l) => {
    const sh = lineSum > 0 ? Math.floor((l.LineTotal * docDiscount) / lineSum) : 0
    allocated += sh
    return sh
  })
  if (lines.length > 0) {
    const residual = docDiscount - allocated
    if (residual !== 0) {
      const maxIdx = lines.reduce((mi, l, i) => (l.LineTotal > lines[mi].LineTotal ? i : mi), 0)
      shares[maxIdx] += residual
    }
  }
  lines.forEach((l, i) => {
    const rate = VAT_GROUPS.find((v) => v.Code === l.VatGroup)?.Rate ?? 0
    l.VatSum = rate > 0 ? Math.round(((l.LineTotal - shares[i]) * rate) / 100) : 0
  })
  return docDiscount
}

// ---------- Mô phỏng giới hạn số bản ghi/trang của Service Layer thật ----------
// SL thật thường CHỈ TRẢ ~20 bản ghi mỗi trang dù client yêu cầu $top=500
// (server-driven paging). Mock mặc định chặn ở 20 để tái hiện đúng hành vi đó
// và kiểm thử phân trang phía app. Đổi bằng MOCK_MAX_PAGE (0 = không giới hạn).
const MAX_PAGE = Number(process.env.MOCK_MAX_PAGE ?? 20)

// Chế độ MOCK_BULK=1: sinh thêm 60 mặt hàng + 30 khách hàng để kiểm tra
// app có lấy ĐỦ danh sách lớn (>20 dòng) hay không, kèm 3 đơn hàng mẫu
// trong SAP để kiểm tra danh sách đơn lấy trực tiếp từ Service Layer.
if (process.env.MOCK_BULK === '1') {
  const uoms = ['kg', 'chai', 'gói', 'thùng', 'bó']
  const taxs = ['S1', 'S2', 'S8']
  for (let i = 1; i <= 60; i++) {
    const nn = String(i).padStart(3, '0')
    ITEMS.push({
      ItemCode: `FM-GEN-${nn}`,
      ItemName: `Hàng sinh thử ${nn} — phân trang`,
      InventoryUOM: uoms[i % uoms.length],
      SalesUnit: uoms[i % uoms.length],
      BarCode: `8934599${nn}001`,
      SalesVATGroup: taxs[i % taxs.length],
      QuantityOnStock: 10 + i,
      SalesItem: 'tYES',
      ItemPrices: [{ PriceList: 1, Price: 5000 + i * 777 }],
    })
  }
  for (let i = 1; i <= 30; i++) {
    const nn = String(i).padStart(3, '0')
    PARTNERS.push({
      CardCode: `C900${nn}`,
      CardName: `Khách hàng sinh thử ${nn}`,
      Address: `Số ${i}, đường kiểm thử phân trang, TP.HCM`,
      Phone1: `09${String(8000000 + i * 137).slice(0, 8)}`,
      CardType: 'C',
    })
  }
  // 3 đơn hàng mẫu trong "SAP" — ngày 05-07/10/2026, một đơn đã Closed
  try {
    const seed1 = buildOrder({ CardCode: 'C20001', DocDate: '2026-10-05', DocDueDate: '2026-10-15', Comments: 'Đơn mẫu trong SAP (mock bulk)', DocumentLines: [{ ItemCode: 'FM-QUA-001', Quantity: 5, UnitPrice: 32000 }] })
    ORDERS.push(seed1)
    const seed2 = buildOrder({ CardCode: 'C20002', DocDate: '2026-10-06', DocDueDate: '2026-10-16', DocumentLines: [{ ItemCode: 'FM-RAU-001', Quantity: 10, UnitPrice: 12000 }, { ItemCode: 'FM-CU-001', Quantity: 3, UnitPrice: 14000, DiscountPercent: 10 }] })
    seed2.DocumentStatus = 'C'
    ORDERS.push(seed2)
    const seed3 = buildOrder({ CardCode: 'C20003', DocDate: '2026-10-07', DocDueDate: '2026-10-20', DocumentLines: [{ ItemCode: 'FM-DAC-001', Quantity: 2, UnitPrice: 185000 }] })
    ORDERS.push(seed3)
    console.log(`   MOCK_BULK: đã tạo 3 đơn mẫu trong SAP — DocNum ${seed1.DocNum}/${seed2.DocNum}/${seed3.DocNum}`)
  } catch (e) {
    console.log(`   MOCK_BULK: không tạo được đơn mẫu (${e instanceof Error ? e.message : e})`)
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function errorBody(status: number, value: string) {
  return json({ error: { code: status, message: { lang: 'en-us', value } } }, status)
}

// OData v2 của Service Layer thật trả Edm.Decimal dạng CHUỖI (vd "12000.000000") —
// mock mô phỏng đúng hành vi này để kiểm tra app có ÉP SỐ đúng không.
const dec = (x: number): string => Number(x).toFixed(2)

/** SL thật phân tích $filter phân biệt CHỮ HOA/THƯỜNG — thuộc tính sai tên → 400 */
function assertFilterProps(filter: string, allowed: string[], entity: string): Response | null {
  if (!filter) return null
  const bad = [...filter.matchAll(/([A-Za-z_]\w*)\s+eq\s/g)]
    .map((m) => m[1])
    .filter((p) => !allowed.includes(p))
  if (bad.length > 0) {
    return errorBody(400, `Could not find a property named '${bad[0]}' in type '${entity}'`)
  }
  return null
}

/** Serial hóa mặt hàng: số thập phân trả dạng chuỗi như SL thật */
function serItem(it: MockItem) {
  return {
    ...it,
    QuantityOnStock: dec(it.QuantityOnStock),
    ItemPrices: it.ItemPrices.map((p) => ({ PriceList: p.PriceList, Price: dec(p.Price) })),
  }
}
/** Serial hóa tồn kho theo kho: số thập phân trả dạng chuỗi như SL thật.
 *  Tên trường đúng theo metadata SL (ComplexType ItemWarehouseInfo):
 *  Committed / Ordered (KHÔNG phải IsCommitted / OnOrder). */
function serStock(rows: ReturnType<typeof stockRowsFor>) {
  return rows.map((w) => ({ WarehouseCode: w.WarehouseCode, InStock: dec(w.InStock), Committed: dec(w.IsCommitted), Ordered: dec(w.OnOrder) }))
}

/** Serial hóa 1 dòng RDR1: các trường số thập phân trả dạng chuỗi như SL thật.
 * LƯU Ý: Service Layer thật KHÔNG trả VatSum theo dòng (metadata
 * SAPB1.DocumentLine không có property này — chỉ header Document mới có
 * VatSum), nên mock cũng KHÔNG trả để kiểm thử trung thực. App phải tự tính
 * VAT dòng từ thuế suất (xem finalizeTotals trong src/lib/sap-orders.ts). */
function serLine(l: MockOrderLine) {
  const { VatSum: _noVatSumOnRealSL, ...rest } = l
  return {
    ...rest,
    Quantity: dec(l.Quantity),
    Price: dec(l.Price),
    DiscountPercent: dec(l.DiscountPercent),
    LineTotal: dec(l.LineTotal),
  }
}

/** Serial hóa chứng từ ORDR: số thập phân trả dạng chuỗi như SL thật */
function serOrder(o: MockOrder) {
  return {
    ...o,
    DocTotal: dec(o.DocTotal),
    VatSum: dec(o.VatSum),
    DocumentLines: o.DocumentLines ? o.DocumentLines.map(serLine) : o.DocumentLines,
  }
}

/**
 * Giống SL thật của khách hàng: $filter KHÔNG hỗ trợ ngoặc tròn lẫn hàm
 * substringof → 400 "Query string error - the value 'true' of property ')' is
 * invalid". Bật mặc định để bắt hồi quy (app phải tìm kiếm and-only, không
 * ngoặc); tắt bằng MOCK_STRICT_FILTER=0.
 */
const STRICT_FILTER = process.env.MOCK_STRICT_FILTER !== '0'
function assertNoBrackets(filter: string): Response | null {
  if (!STRICT_FILTER || !filter) return null
  if (filter.includes('(') || filter.includes(')') || /substringof/i.test(filter)) {
    return errorBody(400, "Query string error - the value 'true' of property ')' is invalid")
  }
  return null
}

// Chế độ HTTPS self-signed (giả lập Service Layer thật): MOCK_TLS=1 MOCK_PORT=9443 bun scripts/mock-sap-server.ts
const tlsEnabled = process.env.MOCK_TLS === '1'
const tlsConfig = tlsEnabled
  ? {
      cert: await Bun.file(new URL('./mock-cert/cert.pem', import.meta.url)).text(),
      key: await Bun.file(new URL('./mock-cert/key.pem', import.meta.url)).text(),
    }
  : undefined

Bun.serve({
  port: Number(process.env.MOCK_PORT ?? 9090),
  tls: tlsConfig,
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, '').replace(/^.*\/b1s\/v1/, '')

    // ---------- POST /Login ----------
    if (path === '/Login' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { CompanyDB?: string; UserName?: string; Password?: string }
      await new Promise((r) => setTimeout(r, 120)) // giả độ trễ mạng
      if (body.UserName === 'manager' && body.Password === 'Sap@1234' && body.CompanyDB) {
        return json(
          { SessionId: `MOCK-${Date.now()}`, SessionTimeout: 30, Version: '1000000900_MOCK_FAKE' },
          200,
          {
            'Set-Cookie': [
              `B1SESSION=MOCKSESSION${Date.now()}; HttpOnly; path=/b1s`,
              'ROUTEID0=.node0; path=/b1s',
            ].join(', '),
          },
        )
      }
      return errorBody(401, 'Invalid user name or password')
    }

    // ---------- Kiểm tra session ----------
    const cookie = req.headers.get('cookie') ?? ''
    if (!cookie.includes('B1SESSION=')) {
      return errorBody(401, 'Session expired or not authenticated')
    }

    // ---------- GET /BusinessPartners ----------
    if (path === '/BusinessPartners' && req.method === 'GET') {
      const filter = url.searchParams.get('$filter') ?? ''
      const badBr = assertNoBrackets(filter)
      if (badBr) return badBr
      const topRaw = url.searchParams.get('$top')
      // Không $top → trả TẤT CẢ; có $top → giới hạn theo MAX_PAGE như SL thật
      const top = topRaw === null ? Infinity : Math.min(Number(topRaw) || 0, MAX_PAGE > 0 ? MAX_PAGE : Infinity)
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      const m = [...filter.matchAll(/substringof\('((?:[^']|'')*)',\s*(CardCode|CardName)\)/g)]
      let list = PARTNERS
      const cardType = filter.match(/CardType eq '([^']*)'/)?.[1]
      if (cardType) list = list.filter((p) => p.CardType === cardType)
      const cardEq = filter.match(/CardCode eq '([^']*)'/)?.[1]
      if (cardEq) list = list.filter((p) => p.CardCode === cardEq)
      if (m.length >= 1) {
        const term = m[0][1].replace(/''/g, "'").toLowerCase()
        list = list.filter(
          (p) => (m.some((x) => x[2] === 'CardCode') && p.CardCode.toLowerCase().includes(term)) || (m.some((x) => x[2] === 'CardName') && p.CardName.toLowerCase().includes(term)),
        )
      }
      return json({ value: list.slice(skip, top === Infinity ? undefined : skip + top) })
    }

    // ---------- GET /Items ----------
    if (path === '/Items' && req.method === 'GET') {
      const filter = url.searchParams.get('$filter') ?? ''
      const badBr = assertNoBrackets(filter)
      if (badBr) return badBr
      const topRaw = url.searchParams.get('$top')
      // Không $top → trả TẤT CẢ; có $top → giới hạn theo MAX_PAGE như SL thật
      const top = topRaw === null ? Infinity : Math.min(Number(topRaw) || 0, MAX_PAGE > 0 ? MAX_PAGE : Infinity)
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      const m = [...filter.matchAll(/substringof\('((?:[^']|'')*)',\s*(ItemCode|ItemName)\)/g)]
      let list = ITEMS
      const salesItem = filter.match(/SalesItem eq '([^']*)'/)?.[1]
      if (salesItem) list = list.filter((i) => i.SalesItem === salesItem)
      const itemEq = filter.match(/ItemCode eq '([^']*)'/)?.[1]
      if (itemEq) list = list.filter((i) => i.ItemCode === itemEq)
      if (m.length >= 1) {
        const term = m[0][1].replace(/''/g, "'").toLowerCase()
        list = list.filter(
          (i) => (m.some((x) => x[2] === 'ItemCode') && i.ItemCode.toLowerCase().includes(term)) || (m.some((x) => x[2] === 'ItemName') && i.ItemName.toLowerCase().includes(term)),
        )
      }
      return json({ value: list.slice(skip, top === Infinity ? undefined : skip + top).map(serItem) })
    }

    // ---------- GET /SpecialPrices (giá đặc biệt theo Mặt hàng + Khách hàng) ----------
    // Giống SL thật: từ chối property sai tên (vd itemCode thường) với lỗi 400
    if (path === '/SpecialPrices' && req.method === 'GET') {
      const filter = url.searchParams.get('$filter') ?? ''
      const bad = assertFilterProps(filter, ['ItemCode', 'CardCode'], 'SpecialPrices')
      if (bad) return bad
      const badBr = assertNoBrackets(filter)
      if (badBr) return badBr
      // Giống SL thật: $select chứa thuộc tính không có trong metadata → 400
      // (trường bảng giá tên thật là PriceListNo — KHÔNG có trường PriceList)
      if (STRICT_FILTER) {
        const sel = (url.searchParams.get('$select') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
        const badProp = sel.find((p) => !['ItemCode', 'CardCode', 'Price', 'Currency', 'DiscountPercent', 'PriceListNo'].includes(p))
        if (badProp) return errorBody(400, `Property '${badProp}' of 'SpecialPrice' is invalid`)
      }
      const itemCode = filter.match(/ItemCode eq '([^']*)'/)?.[1] ?? ''
      const cardCode = filter.match(/CardCode eq '([^']*)'/)?.[1] ?? ''
      const list = SPECIAL_PRICES.filter((s) => s.ItemCode === itemCode && s.CardCode === cardCode)
      return json({ value: list.map((s) => ({ ...s, Price: dec(s.Price), DiscountPercent: dec(s.DiscountPercent) })) })
    }

    // ---------- GET /VatGroups (nhóm thuế → thuế suất) ----------
    // Giống SL THẬT: KHÔNG có Rate trên dòng cha OVTG; %VAT nằm trong mảng con
    // VatGroups_Lines (VTG1) KÈM SẴN trong response, dạng /Date(...) như SL thật.
    // (Một số bản SL còn từ chối $select trên VatGroups → chỉ lấy nguyên văn)
    if (path === '/VatGroups' && req.method === 'GET') {
      if (STRICT_FILTER && (url.searchParams.get('$select') ?? '') !== '') {
        return errorBody(400, "Query string error - $select is not supported on resource 'VatGroups'")
      }
      const topRaw = url.searchParams.get('$top')
      const top = topRaw === null ? Infinity : Math.min(Number(topRaw) || 0, MAX_PAGE > 0 ? MAX_PAGE : Infinity)
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      const page = VAT_GROUPS.slice(skip, top === Infinity ? undefined : skip + top).map((v) => ({
        Code: v.Code,
        Category: 'S',
        Name: v.Name,
        // Lịch sử suất VTG1: hiệu lực từ 2018-01-01, không ngày kết thúc
        VatGroups_Lines: [
          { Code: v.Code, Category: 'S', Rate: dec(v.Rate), DateFrom: '/Date(1514764800000)/', DateTo: null },
        ],
      }))
      return json({ value: page })
    }

    // ---------- GET /Warehouses (danh sách kho OWHS — chọn "Kho hàng xuất bán") ----------
    if (path === '/Warehouses' && req.method === 'GET') {
      const topRaw = url.searchParams.get('$top')
      const top = topRaw === null ? Infinity : Math.min(Number(topRaw) || 0, MAX_PAGE > 0 ? MAX_PAGE : Infinity)
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      return json({ value: WAREHOUSES.slice(skip, top === Infinity ? undefined : skip + top) })
    }

    // ---------- /InventoryItems — KHÔNG hỗ trợ (như SL thật của khách hàng) ----------
    // SL thật trả 400 "Unrecognized resource path." — tồn kho lấy qua
    // GET /Items('X') (ItemWarehouseInfo trả sẵn trong body). Đặt
    // MOCK_LEGACY_INVENTORY=1 để quay lại hành vi cũ (trả dữ liệu).
    if (path === '/InventoryItems' && req.method === 'GET') {
      if (process.env.MOCK_LEGACY_INVENTORY !== '1') {
        return errorBody(400, 'Unrecognized resource path.')
      }
      const filter = url.searchParams.get('$filter') ?? ''
      // Giống SL thật: property trong $filter phân biệt hoa/thường — itemCode thường → 400
      const bad = assertFilterProps(filter, ['ItemCode'], 'InventoryItem')
      if (bad) return bad
      const itemEq = filter.match(/ItemCode eq '([^']*)'/)?.[1]
      let list = ITEMS
      if (itemEq) list = list.filter((i) => i.ItemCode === itemEq)
      const topRaw = url.searchParams.get('$top')
      const top = topRaw === null ? Infinity : Math.min(Number(topRaw) || 0, MAX_PAGE > 0 ? MAX_PAGE : Infinity)
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      const value = list.slice(skip, top === Infinity ? undefined : skip + top).map((it) => ({
        ItemCode: it.ItemCode,
        ItemName: it.ItemName,
        Warehouses: serStock(stockRowsFor(it)),
      }))
      return json({ value })
    }

    // ---------- GET /Items('X') — 1 mặt hàng (kèm ItemWarehouseInfoCollection — ATP bước 1) ----------
    // MOCK_NO_ITEM_WHS=1 → giả lập SL thật không trả collection trong body
    // (để test các bước fallback trong /api/items/stock)
    const itemKey = path.match(/^\/Items\('([^']*)'\)$/)
    if (itemKey && req.method === 'GET') {
      const it = ITEMS.find((i) => i.ItemCode === itemKey[1])
      if (!it) return errorBody(404, `Item '${itemKey[1]}' not found`)
      if (process.env.MOCK_NO_ITEM_WHS === '1') {
        return json(serItem(it))
      }
      return json({ ...serItem(it), ItemWarehouseInfoCollection: serStock(stockRowsFor(it)) })
    }

    // ---------- GET /Items('X')/ItemWarehouseInfoCollection — tồn kho theo kho (ATP bước 2) ----------
    const itemWhsKey = path.match(/^\/Items\('([^']*)'\)\/ItemWarehouseInfoCollection$/)
    if (itemWhsKey && req.method === 'GET') {
      if (process.env.MOCK_NO_ITEM_WHS === '1') {
        return errorBody(400, 'Mock simulates SL — property not available')
      }
      const it = ITEMS.find((i) => i.ItemCode === itemWhsKey[1])
      if (!it) return errorBody(404, `Item '${itemWhsKey[1]}' not found`)
      const rows = serStock(stockRowsFor(it))
      return json({ value: rows })
    }

    // ---------- GET /Orders(DocEntry) — chi tiết 1 chứng từ (kèm DocumentLines) ----------
    // MOCK_NO_EXPAND=1 → giả lập SL thật chặn/từ chối $expand (lỗi 201) để test chuỗi fallback
    // MOCK_LINES_OMIT=1 → giả lập SL không trả DocumentLines trong GET 1 chứng từ (để test tập con/$expand)
    const orderKey = path.match(/^\/Orders\((\d+)\)$/)
    if (orderKey && req.method === 'GET') {
      const doc = ORDERS.find((o) => o.DocEntry === Number(orderKey[1]))
      if (!doc) return errorBody(404, `Order DocEntry=${orderKey[1]} not found`)
      if (process.env.MOCK_NO_EXPAND === '1' && url.searchParams.has('$expand')) {
        return errorBody(400, "Mock simulates SL rejecting $expand — Cannot expand invalid navigation property 'DocumentLines' for entity type 'Document'")
      }
      if (process.env.MOCK_LINES_OMIT === '1' && !url.searchParams.has('$expand')) {
        return json({ ...serOrder(doc), DocumentLines: undefined })
      }
      return json(serOrder(doc))
    }

    // ---------- PATCH /Orders(DocEntry) — SỬA chứng từ đang Open (như SL thật) ----------
    // Header B1S-ReplaceCollectionsOnPatch=true (app luôn gửi): DocumentLines được
    // THAY THẾ toàn bộ — dòng có LineNum → cập nhật, dòng mới không LineNum → thêm,
    // dòng bị bỏ khỏi mảng → bị xóa. Thành công trả 204 No Content như SL thật.
    if (orderKey && req.method === 'PATCH') {
      const doc = ORDERS.find((o) => o.DocEntry === Number(orderKey[1]))
      if (!doc) return errorBody(404, `Order DocEntry=${orderKey[1]} not found`)
      if (doc.DocumentStatus !== 'O') {
        return errorBody(400, `Document ${doc.DocNum} is already closed — cannot update`)
      }
      const body = (await req.json().catch(() => null)) as
        | { CardCode?: string; DocDate?: string; DocDueDate?: string; Comments?: string; DiscountPercent?: number | string; DocumentLines?: MockDocLineInput[] }
        | null
      if (!body) return errorBody(400, 'Invalid payload')

      if (body.CardCode !== undefined) {
        const bp = PARTNERS.find((p) => p.CardCode === body.CardCode)
        if (!bp) return errorBody(400, `Invalid CardCode '${body.CardCode}'`)
        if (bp.CardType !== 'C') return errorBody(400, `'${bp.CardCode}' is not a customer account`)
        doc.CardCode = bp.CardCode
        doc.CardName = bp.CardName
      }
      if (body.DocDate) doc.DocDate = body.DocDate.slice(0, 10)
      if (body.DocDueDate) doc.DocDueDate = body.DocDueDate.slice(0, 10)
      if (body.Comments !== undefined) doc.Comments = body.Comments
      if (body.DiscountPercent !== undefined) {
        doc.DiscountPercent = Math.min(100, Math.max(0, Number(body.DiscountPercent) || 0))
      }

      const incoming = Array.isArray(body.DocumentLines) ? body.DocumentLines : []
      const lines: MockOrderLine[] = []
      let seq = 0
      for (const l of incoming) {
        const item = ITEMS.find((x) => x.ItemCode === l.ItemCode)
        if (!item) return errorBody(400, `Invalid ItemCode '${l.ItemCode}' in DocumentLines/${seq}`)
        if (!(Number(l.Quantity) > 0)) return errorBody(400, `Invalid Quantity in DocumentLines/${seq}`)
        if (l.WarehouseCode && !WAREHOUSES.some((w) => w.WarehouseCode === l.WarehouseCode)) {
          return errorBody(400, `Invalid WarehouseCode '${l.WarehouseCode}' in DocumentLines/${seq}`)
        }
        const price = Number(l.UnitPrice) || 0
        const qty = Number(l.Quantity) || 0
        const disc = Number(l.DiscountPercent) || 0
        const lineTotal = Math.round(qty * price * (1 - disc / 100))
        const vg = l.VatGroup || item.SalesVATGroup || ''
        const rate = VAT_GROUPS.find((v) => v.Code === vg)?.Rate ?? 0
        const vatSum = rate > 0 ? Math.round((lineTotal * rate) / 100) : 0
        const ln = typeof (l as unknown as { LineNum?: number }).LineNum === 'number' ? (l as unknown as { LineNum: number }).LineNum : 0
        lines.push({
          LineNum: ln > 0 ? ln : 0, // tạm 0 — đánh số lại sau khi biết tổng số dòng giữ LineNum cũ
          ItemCode: l.ItemCode,
          ItemDescription: item.ItemName,
          Quantity: qty,
          Price: price,
          DiscountPercent: disc,
          LineTotal: lineTotal,
          VatGroup: vg,
          MeasureUnit: item.SalesUnit || item.InventoryUOM,
          VatSum: vatSum,
          ...(l.WarehouseCode ? { WarehouseCode: l.WarehouseCode } : {}),
        })
        seq++
      }
      // Dòng giữ nguyên LineNum cũ; dòng mới (không LineNum) nhận số tiếp theo
      let maxLn = Math.max(0, ...lines.map((l) => l.LineNum))
      for (const l of lines) if (l.LineNum === 0) l.LineNum = ++maxLn
      doc.DocumentLines = lines
      const pct = Math.min(100, Math.max(0, Number(doc.DiscountPercent) || 0))
      doc.DocDiscount = applyDocDiscount(lines, pct)
      doc.VatSum = lines.reduce((s, l) => s + l.VatSum, 0)
      doc.DocTotal = lines.reduce((s, l) => s + l.LineTotal + l.VatSum, 0) - (doc.DocDiscount ?? 0)
      console.log(`✏️ PATCH /Orders(${doc.DocEntry}) → DocNum=${doc.DocNum} ${doc.CardCode} (${lines.length} dòng, DocTotal=${doc.DocTotal})`)
      return new Response(null, { status: 204 })
    }

    // ---------- GET /Orders(DocEntry)/DocumentLines — tập con dòng hàng ----------
    // Dùng làm phương án dự phòng khi Service Layer không hỗ trợ $expand trên lệnh truy vấn 1 chứng từ
    // MOCK_NO_SUBCOLL=1 → giả lập SL thật chặn cả tập con (DocumentLines không phải navigation property)
    const orderLinesKey = path.match(/^\/Orders\((\d+)\)\/DocumentLines$/)
    if (orderLinesKey && req.method === 'GET') {
      if (process.env.MOCK_NO_SUBCOLL === '1') {
        return errorBody(400, "Mock simulates SL rejecting sub-collection — Resource not found for the segment 'DocumentLines'")
      }
      const doc = ORDERS.find((o) => o.DocEntry === Number(orderLinesKey[1]))
      if (!doc) return errorBody(404, `Order DocEntry=${orderLinesKey[1]} not found`)
      const topRaw = url.searchParams.get('$top')
      const top = topRaw === null ? Infinity : Math.min(Number(topRaw) || 0, MAX_PAGE > 0 ? MAX_PAGE : Infinity)
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      return json({ value: doc.DocumentLines.slice(skip, top === Infinity ? undefined : skip + top).map(serLine) })
    }

    // ---------- GET /Orders — danh sách chứng từ ($filter/$orderby/$top/$skip) ----------
    if (path === '/Orders' && req.method === 'GET') {
      const filter = url.searchParams.get('$filter') ?? ''
      const badBr = assertNoBrackets(filter)
      if (badBr) return badBr
      const topRaw = url.searchParams.get('$top')
      const top = topRaw === null ? Infinity : Math.min(Number(topRaw) || 0, MAX_PAGE > 0 ? MAX_PAGE : Infinity)
      const skip = Number(url.searchParams.get('$skip') ?? 0)
      let list = [...ORDERS]
      // Phân tích $filter kiểu OData: tách top-level theo ' and ', nhóm trong (…)
      // chứa ' or ' thì khớp nếu MỘT điều kiện con đúng (vd: (DocNum eq 1002 or substringof…))
      const splitTop = (s: string, sep: string): string[] => {
        const out: string[] = []
        let depth = 0, cur = ''
        for (let i = 0; i < s.length; i++) {
          const ch = s[i]
          if (ch === '(') depth++
          else if (ch === ')') depth--
          if (depth === 0 && s.startsWith(sep, i)) {
            out.push(cur)
            cur = ''
            i += sep.length - 1
            continue
          }
          cur += ch
        }
        out.push(cur)
        return out
      }
      const condMatch = (raw: string, o: MockOrder): boolean => {
        const cond = raw.trim()
        const numEq = cond.match(/^DocNum eq (\d+)$/)
        if (numEq) return String(o.DocNum) === numEq[1]
        const st = cond.match(/^DocumentStatus eq '([^']*)'$/)
        if (st) return o.DocumentStatus === st[1]
        const cc = cond.match(/^CardCode eq '([^']*)'$/)
        if (cc) return o.CardCode === cc[1]
        const sub = cond.match(/^substringof\('((?:[^']|'')*)',\s*(CardCode|CardName)\)\s+eq\s+(true|false)$/)
        if (sub) {
          const term = sub[1].replace(/''/g, "'").toLowerCase()
          const hit = sub[2] === 'CardCode' ? o.CardCode.toLowerCase().includes(term) : o.CardName.toLowerCase().includes(term)
          return sub[3] === 'true' ? hit : !hit
        }
        const dge = cond.match(/^DocDate ge '([^']*)'$/)
        if (dge) return o.DocDate.slice(0, 10) >= dge[1].slice(0, 10)
        const dle = cond.match(/^DocDate le '([^']*)'$/)
        if (dle) return o.DocDate.slice(0, 10) <= dle[1].slice(0, 10)
        return true // điều kiện không hiểu → bỏ qua
      }
      const andConds = splitTop(filter, ' and ').filter((x) => x.trim())
      list = list.filter((o) =>
        andConds.every((c) => {
          const inner = c.trim().replace(/^\((.*)\)$/, '$1')
          return inner.includes(' or ')
            ? splitTop(inner, ' or ').some((x) => condMatch(x, o))
            : condMatch(inner, o)
        }),
      )
      if ((url.searchParams.get('$orderby') ?? '').replace(/\s+/g, '').toLowerCase() === 'docentrydesc') {
        list.reverse()
      }
      return json({ value: list.slice(skip, top === Infinity ? undefined : skip + top).map(serOrder) })
    }

    // ---------- POST /Orders (tạo đơn hàng bán — như Service Layer thật) ----------
    if (path === '/Orders' && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as Parameters<typeof buildOrder>[0] | null
      // Giả lập SAP chậm: trễ nhỏ trước khi tạo chứng từ
      await new Promise((r) => setTimeout(r, 80))
      let created: MockOrder
      try {
        created = buildOrder(body ?? {})
      } catch (e) {
        return errorBody(400, e instanceof Error ? e.message : 'Invalid payload')
      }
      ORDERS.push(created)
      console.log(`📥 POST /Orders → DocEntry=${created.DocEntry} DocNum=${created.DocNum} ${created.CardCode} (${created.DocumentLines.length} dòng, DocTotal=${created.DocTotal})`)
      return json(serOrder(created), 201)
    }

    return errorBody(404, `Resource not found: ${url.pathname}`)
  },
})

console.log(`🧪 Mock SAP B1 Service Layer chạy tại ${tlsEnabled ? 'https' : 'http'}://127.0.0.1:${process.env.MOCK_PORT ?? 9090}/b1s/v1${tlsEnabled ? ' (HTTPS self-signed)' : ''}`)
console.log('   Đăng nhập mock: CompanyDB=*, UserName=manager, Password=Sap@1234')
console.log(`   Giới hạn bản ghi/trang (MOCK_MAX_PAGE): ${MAX_PAGE > 0 ? MAX_PAGE : 'không giới hạn'} — mô phỏng server-driven paging của SL thật`)
if (process.env.MOCK_BULK === '1') console.log(`   MOCK_BULK: đã sinh thêm dữ liệu — ${PARTNERS.length} đối tác, ${ITEMS.length} mặt hàng`)
const simFlags = [
  STRICT_FILTER ? 'MOCK_STRICT_FILTER (chặn ngoặc/substringof trong $filter + $select rủi ro — như SL thật)' : '',
  process.env.MOCK_NO_EXPAND === '1' ? 'MOCK_NO_EXPAND (chặn $expand DocumentLines — lỗi 201)' : '',
  process.env.MOCK_NO_SUBCOLL === '1' ? 'MOCK_NO_SUBCOLL (chặn tập con /DocumentLines)' : '',
  process.env.MOCK_LINES_OMIT === '1' ? 'MOCK_LINES_OMIT (GET 1 chứng từ không trả DocumentLines)' : '',
  process.env.MOCK_NO_ITEM_WHS === '1' ? 'MOCK_NO_ITEM_WHS (không trả/chặn ItemWarehouseInfo — test fallback QuantityOnStock)' : '',
  process.env.MOCK_LEGACY_INVENTORY === '1' ? 'MOCK_LEGACY_INVENTORY (bật lại /InventoryItems)' : '',
].filter(Boolean)
if (simFlags.length > 0) console.log(`   ⚠ Chế độ mô phỏng SL thật: ${simFlags.join(', ')}`)
