# 🖥️ Hướng dẫn Deploy Website Local — SAP B1 Sale Order System (Farmers Market)

> Stack: Next.js 16 (App Router) · TypeScript · Tailwind 4 · Prisma + SQLite · Node.js (Bun tùy chọn)
> Database là **SQLite** (1 file duy nhất) — **không cần cài SQL Server / MySQL**.
> Ứng dụng chạy **on-premise** (máy chủ nội bộ / máy trạm) theo kiểu Next.js standalone — **không deploy lên Cloudflare** (xem mục cuối).
>
> 🔄 Đã cài bản cũ, chỉ muốn cập nhật? Xem **Bước 6b — Cập nhật lên phiên bản mới**.

---

## Bước 0 — Chuẩn bị máy

| Cần cài | Phiên bản | Kiểm tra bằng lệnh |
|---|---|---|
| Node.js | ≥ 20 (khuyến nghị 22/24) | `node -v` |
| Bun *(khuyến nghị)* | ≥ 1.1 | `bun -v` |
| Git *(tuỳ chọn)* | bất kỳ | `git --version` |

Cài Bun (chọn 1 trong 2):

```bash
npm install -g bun
# hoặc macOS/Linux:
curl -fsSL https://bun.sh/install | bash
```

---

## Bước 1 — Nhận mã nguồn

Cách khuyến nghị — clone từ GitHub (nhánh `main`):

```bash
git clone https://github.com/trantrai/sapb1-farmers-market.git
cd sapb1-farmers-market
```

Hoặc copy toàn bộ thư mục dự án về máy (bao gồm `src/`, `prisma/`, `public/`, `scripts/`,
`package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`,
`eslint.config.mjs`, `components.json`, `bun.lock`), ví dụ:

- Windows: `D:\sapb1-farmers-market`
- macOS/Linux: `~/sapb1-farmers-market`

Mở terminal / PowerShell tại thư mục dự án.

---

## Bước 2 — Cài thư viện

```bash
npm install        # khuyến nghị (package-lock.json là bản khóa phiên bản chuẩn)
# hoặc
bun install
```

> ⚠️ `bun.lock` hiện có thể lệch phiên bản Prisma so với `package-lock.json` — nếu `bun install` báo lỗi Prisma, dùng `npm install`.

---

## Bước 3 — File `.env`

Tạo file `.env` ở thư mục gốc từ mẫu `.env.example` (mẫu **không chứa giá trị thật**):

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

Các biến cần có:

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | Có | Đường dẫn SQLite, mặc định `file:../db/custom.db` |
| `FM_SESSION_SECRET` | **Có ở production** (≥ 16 ký tự) | Khóa ký phiên đăng nhập. Thiếu → mỗi lần restart server mọi người bị đăng xuất |
| `FM_DATA_KEY` | **Có ở production** (≥ 16 ký tự) | Khóa mã hóa AES-256-GCM cho mật khẩu SAP B1 / API key LLM lưu trong DB. Thiếu → production **từ chối khởi động** |

Sinh chuỗi ngẫu nhiên cho 2 khóa (chạy 2 lần, mỗi khóa một chuỗi khác nhau):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ Prisma tính đường dẫn `file:` **từ thư mục `prisma/`** — nên `../db/custom.db` chính là `db/custom.db` ngang hàng `package.json`. **Đừng đổi** sang đường dẫn tuyệt đối kiểu `file:/home/tenban/...` trừ khi bạn di chuyển file db (đường dẫn tuyệt đối của máy khác gây lỗi `P1003` — không mở được database).
>
> 🔒 **Không commit `.env`** (đã có trong `.gitignore`), không gửi file này qua chat/email. **Giữ nguyên `FM_DATA_KEY`** khi chuyển máy/nâng cấp — đổi khóa thì mật khẩu SAP đã lưu không giải mã được nữa, phải nhập lại ở **Cài đặt SAP B1**.

---

## Bước 4 — Khởi tạo database

```bash
bunx prisma generate      # tạo Prisma Client (BẮT BUỘC)
bunx prisma db push       # tạo các bảng trong SQLite (nếu db/custom.db đã có sẵn thì có thể bỏ qua)
bun prisma/seed.ts        # TÙY CHỌN — chỉ chạy khi muốn dữ liệu demo để thử nghiệm
```

Với **npm**:

```bash
npx prisma generate
npx prisma db push
npx tsx prisma/seed.ts    # tùy chọn
```

> 💡 **Cách nhanh nhất:** chạy 1 lệnh `bun run setup` = generate + db push + seed luôn. Ngoài ra lệnh `npm run dev` **tự động `prisma generate` + `prisma db push`** trước khi start server — nhờ vậy không bao giờ gặp lỗi `no such table` khi mang db sang máy khác hoặc đổi schema.
>
> ⚠️ **Đừng dùng `npm run db:push` trên DB đang có dữ liệu thật** — script này kèm cờ `--accept-data-loss` (có thể xóa cột/bảng). Luôn dùng `npx prisma db push` (không cờ): nếu thay đổi có nguy cơ mất dữ liệu, Prisma sẽ dừng lại và báo trước. Seed (`prisma/seed.ts`) **xóa sạch dữ liệu** trước khi tạo dữ liệu mẫu — chỉ chạy trên DB mới.

> 💡 **Lưu ý:** Từ phiên bản hiện tại, khách hàng & mặt hàng được lấy **TRỰC TIẾP từ SAP B1 Service Layer** (xem Bước 8), nên seed chỉ dùng khi muốn xem thử hệ thống với dữ liệu mẫu. Muốn xóa dữ liệu demo sau đó: `bun scripts/clear-demo-data.ts` (giữ nguyên users/roles).

---

## Bước 5 — Chạy chế độ Dev (thử nhanh)

```bash
npm run dev        # hoặc: bun run dev
```

Mở trình duyệt: **http://localhost:3000**

> `npm run dev` chạy `scripts/dev.js` — dùng được cả Windows/macOS/Linux, log vừa hiện trên console vừa ghi vào `dev.log`.

---

## Bước 6 — Chạy chế độ Production

```bash
npm run build       # prisma generate + build standalone + copy static/public
npm run start       # chạy server production tại cổng 3000 (scripts/start.js)
```

Mở: **http://localhost:3000**

Ghi chú:

- **Luôn khởi động bằng `npm run start`** (= `node scripts/start.js`), không gọi thẳng `.next/standalone/server.js`: `start.js` chốt đường dẫn DB tuyệt đối (tránh mở nhầm DB → lỗi đăng nhập “Yêu cầu không hợp lệ”), chạy `prisma db push` an toàn rồi ghi log ra `server.log`.
- `start.js` chỉ tự đọc `DATABASE_URL` từ `.env`. **`FM_SESSION_SECRET` và `FM_DATA_KEY` phải có trong biến môi trường** của tiến trình: dùng `EnvironmentFile=` của systemd (mục *Chạy service thường trực*), hoặc nạp tay trước khi start:
  - Linux/macOS: `set -a; . ./.env; set +a; npm run start`
  - Windows PowerShell: `Get-Content .env | ? { $_ -match '^\s*[A-Z_]+=' } | % { $k,$v = $_ -split '=',2; [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim().Trim('"')) }; npm run start`
- Muốn đổi cổng: `PORT=4000 npm run start` (Windows CMD: `set PORT=4000&& npm run start`).
- Cấu hình `next.config.ts` đã đặt `output: "standalone"`.

---

## Bước 6b — Cập nhật lên phiên bản mới

Mỗi lần có bản mới trên nhánh `main`:

```bash
git pull origin main
npm install
npx prisma generate
npx prisma db push          # KHÔNG thêm --accept-data-loss
npm run build
# rồi khởi động lại: systemd → sudo systemctl restart sapb1-so ; chạy tay → npm run start
```

> 💾 **Sao lưu `db/custom.db` trước khi cập nhật** (copy file sang chỗ khác) — SQLite chỉ là 1 file, khôi phục = chép đè lại.

Các thay đổi schema gần đây (đều **chỉ thêm** cột/bảng, `prisma db push` không mất dữ liệu):

| Thay đổi | Dùng cho |
|---|---|
| Cột barcode trên dòng chứng từ | Cột/ô tìm Barcode trong lưới hàng hóa (chỉ lưu local) |
| Người liên hệ, địa chỉ giao/ghi hóa đơn của khách hàng (`contactsJson`, `shipToDefault`, `billToDefault`…) | Chọn người liên hệ + địa chỉ trên chứng từ → gửi SAP `ContactPersonCode`, `ShipToCode`, `BillToCode` |
| `AppSettings.assistant*` | Cấu hình trợ lý sale admin (Bước 14) |
| Bảng `UserSalesPerson` | Gắn người dùng ↔ nhân viên kinh doanh theo từng DB SAP (Bước 15) |
| `DeliveryLine.isBomChild`, `bomGroupKey`, `bomEditable`, `bomQtyPerParent` | Phiếu giao hàng lưu nhóm BOM (dòng cha + thành phần con) như đơn hàng |

Sau khi cập nhật lần đầu lên bản có người liên hệ/địa chỉ: vào **Đồng bộ dữ liệu › Đối tác kinh doanh** bấm đồng bộ lại để có danh sách người liên hệ và địa chỉ.

---

## Bước 7 — Đăng nhập & tài khoản demo

Seed tạo 4 tài khoản với **mật khẩu ngẫu nhiên mạnh, sinh mới mỗi lần seed** — mật khẩu chỉ **in ra console 1 lần** khi chạy seed (không ghi vào file nào), hãy lưu lại ngay. **Lần đăng nhập đầu bắt buộc đổi mật khẩu.**

| Tài khoản | Vai trò | Quyền mặc định |
|---|---|---|
| `admin` | Admin | Toàn quyền: chứng từ, Quản lý người dùng, Ủy quyền, Cài đặt SAP B1 |
| `ketoan` | Kế toán | Chứng từ (không xóa) + xem/đồng bộ danh mục |
| `nhanvien` | Nhân viên bán hàng | Tạo/sửa đơn hàng |
| `kiemke` | Nhân viên bán hàng | Tạo/sửa đơn hàng (đổi vai trò tùy nhu cầu) |

Quên mật khẩu admin khi chưa có dữ liệu thật → chạy lại seed. Đã có dữ liệu thật → **không chạy seed** (seed xóa sạch DB); nhờ một Admin khác đặt lại mật khẩu ở **Quản lý người dùng**.

Khi có nhiều cơ sở dữ liệu SAP (Bước 8), màn đăng nhập cho chọn **Cơ sở dữ liệu** làm việc. Phiên sống 12 giờ (cookie `fm_session`, httpOnly).

---

## Bước 8 — Kết nối SAP B1 Service Layer (quan trọng)

Từ phiên bản hiện tại, **khách hàng & mặt hàng lấy TRỰC TIẾP từ SAP B1** qua Service Layer (OData v2), không dùng dữ liệu cứng local:

1. Đăng nhập `admin` → menu **Quản trị & hệ thống › Cài đặt SAP B1**
2. Thêm cơ sở dữ liệu SAP (có thể thêm **nhiều DB/công ty**, đánh dấu 1 DB **mặc định**):
   - **Service Layer URL**: `https://<server-sap>:50000/b1s/v1` (hoặc `/b1s/v2` tùy phiên bản Service Layer)
   - **Company DB**: tên CSDL công ty (VD: `FM_LIVE`)
   - **SAP User / Password**: **tài khoản dịch vụ riêng, quyền tối thiểu** cho CompanyDB đó — **không dùng `manager`**. Mật khẩu được mã hóa AES-256-GCM trong DB (khóa `FM_DATA_KEY`)
3. Bấm **Lưu** → bấm **Kiểm tra kết nối** — hệ thống đăng nhập thử vào Service Layer. Trạng thái kết nối hiện ở ô **Cơ sở dữ liệu** trên thanh đầu trang (chấm xanh = đang kết nối)
4. Kết nối thành công → mở **Tạo đơn hàng**:
   - **Khách hàng**: bấm vào ô → dropdown tải **TOÀN BỘ danh sách** từ SAP B1 (tự phân trang gom đủ dù SL giới hạn số bản ghi/trang), gõ để lọc ngay trên máy khách — **không phân biệt hoa/thường và dấu tiếng Việt** (VD: gõ `ca chua` vẫn ra “Cà Chua Bi Đà Lạt”).
   - **Hàng hóa (nâng cấp — tìm trực tiếp)**: dropdown KHÔNG tải sẵn danh mục nữa — chỉ khi bạn gõ **tối thiểu 2 ký tự**, app mới truy vấn SAP B1 theo mã và theo tên (chỉ lấy mặt hàng **SalesItem** bán được), debounce 300ms, giới hạn 30 kết quả. Danh mục hàng chục nghìn dòng trên SL thật không còn phải tải cả trăm giây nữa.

**Thông tin hiển thị trong dropdown Mặt hàng:** mã — tên hàng, **đơn giá** (Price List 1) bên phải, và dòng phụ: **Đơn vị** (`SalesUnit`), **Mã thuế** (`SalesVATGroup` kèm thuế suất), **Barcode** (`BarCode`). Dropdown Khách hàng hiển thị thêm địa chỉ và số điện thoại.

**Tự động điền giá, đơn vị tính, mã thuế & VAT khi chọn hàng:**
- **Đơn giá**: hệ thống tra **giá bán đặc biệt** theo cặp Mặt hàng + Khách hàng (bảng `OSPP` / `SpecialPrices`) **trước** — tìm thấy thì dùng luôn (ô giá có dấu **★**, rê chuột xem chú thích); không tìm thấy → lấy giá từ `ItemPrices` **Price List 1**.
- **Đơn vị tính** và **Mã thuế**: lưới chi tiết có 2 cột chỉ-đọc tự điền ngay khi chọn mặt hàng — **Đơn vị tính** từ `SalesUnit`, **Mã thuế** từ `SalesVATGroup` (kèm thuế suất, VD `S2 · 5%`).
- **VAT %**: tự điền theo thuế suất của mã thuế `SalesVATGroup` (tra bảng nhóm thuế `OVTG` / `VatGroups`) — vẫn chỉnh tay được.
- **Đổi khách hàng** → giá các dòng tự tính lại theo khách mới (trừ dòng bạn đã sửa giá tay); **Đơn vị** lưu vào đơn lấy từ `SalesUnit`.

> 💡 Dropdown Khách hàng tải toàn bộ **1 lần** và cache 60 giây. Dropdown Mặt hàng **tìm trực tiếp theo từ khóa** (cache theo từng từ khóa 60s) — gõ lùi/xóa không gọi lại SL; chưa đủ 2 ký tự thì hiển thị gợi ý “Nhập tối thiểu 2 ký tự…”.

**Tùy chọn "Bỏ qua xác thực SSL":** nếu máy SAP dùng HTTPS với **chứng chỉ tự ký (self-signed)** — lỗi thường gặp `unable to verify the first certificate` / `self-signed certificate in chain` — hãy tick chọn **"Bỏ qua xác thực SSL (Skip SSL verification)"** rồi Lưu và Kiểm tra kết nối lại. Chỉ nên bật cho máy chủ nội bộ. Lưu ý: ô SAP Password **để trống = giữ nguyên mật khẩu cũ**, chỉ nhập khi muốn đổi.

> ⚠️ Nếu **chưa kết nối**: ô autocomplete sẽ báo “Dữ liệu local trống” — đây là hành vi đúng, vì dữ liệu demo đã được loại bỏ.
> Nếu **SAP lỗi** (sai mật khẩu, mất mạng): ô autocomplete hiển thị lỗi đỏ kèm gợi ý.

Kiến trúc bảo mật: thông tin đăng nhập SAP chỉ nằm ở **máy chủ Next.js** (route handlers), không bao giờ gửi xuống trình duyệt; session B1 được cache và tự re-login khi hết hạn.

> 🧪 Muốn kiểm thử mà chưa có máy SAP thật? Chạy mock kèm theo dự án:
> ```bash
> bun scripts/mock-sap-server.ts   # chạy ở cổng 9090
> ```
> Rồi cấu hình URL = `http://127.0.0.1:9090/b1s/v1`, CompanyDB = `FM_MOCK`, user = `manager`, mật khẩu = `Sap@1234`.
> Mock có sẵn dữ liệu demo giá đặc biệt: khách `C20001` + hàng `FM-QUA-001` → 30.000₫ (★), khách `C20002` + `FM-RAU-001` → 11.500₫ giảm 5% = 10.925₫ (★); nhóm thuế `S1`=10%, `S2`=5%, `S8`=8%. Dropdown trong lưới dùng panel nổi (fixed) nên không bị bảng che.
> Mock hỗ trợ cả **POST /Orders** — tạo đơn sẽ được ghi nhận và cấp `DocNum` bắt đầu từ 1001 (xem log của mock).
>
> Hai biến môi trường hữu ích khi chạy mock:
>
> ```bash
> # Mặc định: mock chặn 20 bản ghi/trang — mô phỏng đúng hành vi server-driven paging của SL thật
> # (dùng để kiểm chứng app lấy ĐỦ dữ liệu dù SL trả trang nhỏ hơn $top yêu cầu)
> bun scripts/mock-sap-server.ts
>
> # MOCK_MAX_PAGE: đổi giới hạn bản ghi/trang (0 = không giới hạn)
> MOCK_MAX_PAGE=50 bun scripts/mock-sap-server.ts
>
> # MOCK_BULK=1: sinh thêm 60 mặt hàng + 30 khách hàng để thử danh sách lớn (>20 dòng)
> MOCK_BULK=1 bun scripts/mock-sap-server.ts
> ```

---

## Bước 8b — Đồng bộ dữ liệu chủ (nhóm menu **Đồng bộ dữ liệu**)

Sau khi kết nối Service Layer (Bước 8), đồng bộ các danh mục chủ về database local — theo thứ tự trên menu:

| Menu | Đồng bộ từ SAP B1 | Ghi chú |
|---|---|---|
| **Đối tác kinh doanh** | `GET /BusinessPartners` (`CardType = 'C'`) | Kèm người liên hệ (`ContactEmployees`), địa chỉ giao/ghi hóa đơn (`BPAddresses`), điều khoản thanh toán. Không kéo Nhà cung cấp |
| **Mặt hàng** | `GET /Items` (chỉ hàng bán được `SalesItem = tYES`) + giá Price List 1 | Dự phòng autocomplete khi SL gián đoạn |
| **Nhóm thuế** | `GET /VatGroups` — **%VAT lấy trường `Rate` trong mảng con `VatGroups_Lines` (VTG1)** trả kèm từng nhóm; dự phòng gọi `/VatGroups('MÃ')/VatGroups_Lines`, sau mới tới cột `Rate` trên OVTG | Giữ cả nhóm **Bán (S)** / **Mua (P)**; thuế suất lưu là suất **hiệu lực hôm nay** (theo DateFrom/DateTo của từng mốc) |
| **Nhân viên bán hàng** | `GET /SalesPersons` (OSLP) | Dropdown NVBH trên chứng từ + gắn NVKD cho người dùng (Bước 15) |
| **Điều khoản thanh toán** | `GET /PaymentTermsTypes` (OCTG) | Dropdown ĐKTT trên chứng từ |
| **Import BOM/Combo** | Nhập công thức BOM/Combo từ Base Workflow | Cần quyền **Import BOM** |

Danh mục lưu **theo từng cơ sở dữ liệu SAP** — đổi DB khi đăng nhập thì cần đồng bộ cho DB đó.

Cách dùng mỗi màn: bấm **Đồng bộ ngay từ SAP B1** → tác vụ **chạy nền trên máy chủ** (bấm xong có thể chuyển sang trang khác, quay lại vẫn thấy tiến trình) với **thanh tiến trình** theo từng giai đoạn: kết nối → lấy danh mục từ SAP → lưu vào CSDL (hiển thị % theo số dòng đã ghi) → hoàn tất; xong hiện thông báo kết quả và danh mục tự tải lại. Dữ liệu mirror toàn bộ về local (tải đủ dù SL trả nhiều trang), bảng hiển thị đầy đủ kèm tìm kiếm **không phân biệt hoa/thường và dấu tiếng Việt**; **Xóa dữ liệu** để dọn sạch khi muốn đồng bộ lại từ đầu. Chip trạng thái cho biết: kết nối SL / số dòng local / lần đồng bộ cuối; nhóm thuế có thêm chip lọc **Tất cả / Bán (S) / Mua (P)** và cảnh báo “N nhóm chưa rõ suất” nếu bản SL không trả được thuế suất.

Vai trò của dữ liệu đồng bộ:

- **Dự phòng khi SAP lỗi** — autocomplete Khách hàng / Mặt hàng trên form tạo đơn tự dùng bản local đã đồng bộ, tạo đơn không bị gián đoạn khi SL chập chờn.
- **Quản lý danh mục** — xem/tìm toàn bộ danh mục ngay trong app, không cần mở SAP B1.

Quyền: xem cần quyền **Cài đặt — Xem**, đồng bộ/xóa cần **Cài đặt — Sửa** (mặc định Admin full, Kế toán được đồng bộ, Nhân viên chỉ xem).

---

## Bước 9 — Đẩy đơn hàng trực tiếp sang SAP B1 (POST /Orders)

Khi bấm **Lưu đơn hàng**, hệ thống **luôn lưu đơn vào database local trước**, sau đó **tự động đẩy chứng từ sang SAP B1** qua `POST /Orders` (nếu đã cấu hình Service Layer ở Bước 8). Có 3 trạng thái hiển thị ở cột **SAP B1** trong danh sách đơn:

| Trạng thái | Ý nghĩa |
|---|---|
| 🟢 `SAP #<DocNum>` | Đã đẩy thành công — chip xanh hiển thị DocNum do SAP cấp (rê chuột xem DocEntry + thời điểm đồng bộ) |
| 🟡 `Chưa đẩy` | Đơn đã lưu local nhưng SAP từ chối / mất kết nối — **bấm vào chip để đẩy lại** bất cứ lúc nào |
| ⚪ `—` | Chưa cấu hình SAP B1 — đơn chỉ tồn tại trên hệ thống này |

Chi tiết ánh xạ dữ liệu sang chứng từ SAP B1:

| Ứng dụng | SAP B1 (POST /Orders) |
|---|---|
| Mã khách hàng | `CardCode` |
| Ngày chứng từ / Ngày giao hàng | `DocDate` / `DocDueDate` |
| Ghi chú | `Comments` (tối đa 254 ký tự) |
| Mã hàng / Số lượng / Đơn giá | `DocumentLines[].ItemCode` / `Quantity` / `UnitPrice` |
| Chiết khấu % dòng | `DocumentLines[].DiscountPercent` |
| **Chiết khấu ĐẦU CHỨNG TỪ % (nhập ở Bước 1)** | `Documents.DiscountPercent` |
| Mã thuế của mặt hàng (`SalesVATGroup`) | `DocumentLines[].VatGroup` |
| Kho xuất của dòng (chọn ở header/Bước 2) | `DocumentLines[].WarehouseCode` |

Các điểm cần biết:

1. **SAP sập không làm mất đơn** — thông báo lưu đơn sẽ kèm cảnh báo vàng “Chưa đẩy được sang SAP B1 …”; đơn vẫn nằm trong danh sách với chip **Chưa đẩy**, khi SAP hoạt động lại chỉ cần bấm chip đó (hoặc mở chi tiết đơn → dòng SAP B1 → bấm **Đẩy lại**).
2. **SAP từ chối dữ liệu** (VD: `Invalid ItemCode`, `Invalid CardCode`) — đơn cũng rơi vào trạng thái **Chưa đẩy** kèm thông báo lỗi tiếng Việt của Service Layer; bạn sửa dữ liệu nguồn trên SAP rồi đẩy lại.
3. Đơn **đã đẩy thành công không cho đẩy lại** (tránh tạo trùng chứng từ trên SAP); xóa đơn ở hệ thống này **không** xóa chứng từ tương ứng trên SAP B1.
4. Quyền đẩy đơn trùng với quyền **Tạo đơn hàng** — người không có quyền sẽ thấy chip trạng thái nhưng không bấm đẩy lại được.
5. **Chiết khấu ĐẦU CHỨNG TỪ (%)** — nhập ở **Bước 1** của form tạo đơn (mục “Chiết khấu đầu chứng từ (%)”), hiển thị ở Bước 3 và trong chi tiết đơn. SAP B1 tự phân bổ tiền CK về từng dòng **trước khi tính thuế từng dòng**; app tính local đúng cùng công thức nên tổng tiền khớp từng đồng với SAP. Khi **sửa đơn**, app luôn gửi `DiscountPercent` kể cả 0 — nhờ vậy xóa được CK cũ trên chứng từ SAP.

---

## Bước 10 — Danh sách đơn hàng lấy trực tiếp từ SAP B1 (GET /Orders)

Khi đã cấu hình Service Layer, trang **Danh sách đơn hàng SO** truy vấn **trực tiếp** chứng từ bán từ SAP B1 (`GET /Orders` — bảng ORDR, tự phân trang lấy đủ dù SL giới hạn số bản ghi/trang), rồi **gộp** với các đơn local **chưa đẩy** sang SAP:

- **Chứng từ gốc SAP** (kể cả đơn tạo từ SAP ngoài, không phải từ app này): hiển thị đầy đủ mã KH, ngày, trạng thái (`O`→Open, `C`→Closed), Tổng tiền (`DocTotal`) — cột **Người tạo** ghi “SAP B1 (chứng từ gốc)”, **không cho xóa/đóng/mở** từ app (muốn thao tác phải làm trên SAP B1).
- **Đơn local chưa đẩy** (chip 🟡 Chưa đẩy hoặc ⚪ chưa cấu hình): vẫn hiển thị bình thường, đẩy lại được như Bước 9.
- **Đơn local đã synced**: bị ẩn khỏi danh sách nếu SAP đã có chứng từ cùng DocEntry (tránh trùng); nếu chứng từ trên SAP bị xóa thì đơn local hiện lại (không bao giờ mất đơn).
- **Chi tiết chứng từ SAP**: bấm vào dòng → màn chi tiết tự tải `DocumentLines` (RDR1) kèm tên hàng, đơn vị tính, CK%, VAT%, tổng theo dòng (bố cục giống màn tạo/sửa — xem Bước 16).
- **Bộ lọc** chạy trên SAP bằng `$filter` OData: số chứng từ (`DocNum`), mã/tên KH, trạng thái, khoảng ngày chứng từ.
- **SAP lỗi khi mở trang**: danh sách tự chuyển sang dữ liệu local kèm dòng cảnh báo đỏ phía trên bảng — không treo màn hình.

> 🧪 Mock hỗ trợ đầy đủ `GET /Orders` (lọc + phân trang + `/Orders(DocEntry)`) để kiểm thử: chạy `MOCK_BULK=1 bun scripts/mock-sap-server.ts` sẽ có sẵn **3 đơn mẫu trong SAP** (DocNum 1001–1003, một đơn đã Closed) + nhận đơn đẩy từ app.

---

## Bước 11 — Kho hàng xuất bán (header) & ATP check tồn kho khả dụng

### Kho hàng xuất bán trên header đơn hàng

Màn **Tạo đơn hàng** có thêm trường **Kho hàng xuất bán** ở Bước 1 (header):

- Danh sách kho tải **trực tiếp từ SAP B1** (`GET /Warehouses` — bảng OWHS) qua `/api/warehouses`, cache 60s.
- Khi chưa cấu hình SAP hoặc SL lỗi → chọn “— (chưa có danh sách kho)”, vẫn nhập đơn được bình thường.
- Kho chọn ở header là **mặc định áp dụng cho TOÀN BỘ dòng hàng** ở Bước 2 — đổi kho header, mọi dòng đổi theo.
- Vẫn **chỉnh được kho theo từng dòng** ở cột “Kho” của lưới hàng hóa (cần cho đơn lấy nhiều kho).
- Khi đẩy đơn sang SAP, kho đi kèm từng dòng: `DocumentLines[].WarehouseCode`; để trống → SAP tự lấy kho mặc định của mặt hàng.

### ATP check — tồn kho khả dụng

Cột **Tồn kho (ATP)** trong lưới hàng hóa tự kiểm tra **ngay sau khi chọn mặt hàng** (và tự kiểm tra lại khi đổi kho của dòng, hoặc bấm nút ↻ để kiểm tra lại tay):

- API `/api/items/stock` truy vấn **trực tiếp** SAP B1 `GET /InventoryItems?$filter=ItemCode eq '…'`.
- Công thức **ATP = Tồn kho (InStock) − Đã cam kết (IsCommitted) + Đang đặt hàng (OnOrder)**; rê chuột vào chip xem chi tiết từng kho.
- 🟢 Chip xanh `ATP 65,3` — kho đủ cho số lượng bạn nhập.
- 🔴 Chip đỏ `Thiếu 934,7` — số lượng vượt tồn khả dụng (thiếu bao nhiêu hiển thị luôn). ATP chỉ là **cảnh báo tham khảo**, không chặn lưu đơn.
- Chưa cấu hình SAP → fallback tồn kho local (bảng Item.stock, không có chi tiết kho).

> 🧪 Mock có `GET /Warehouses` (3 kho: 01/02/03) và `GET /InventoryItems` (tồn chia theo kho 60%/25%/15% + IsCommitted/OnOrder) để kiểm thử ATP mà không cần SAP thật.

---

## Bước 12 — Màn hình Service Layer Audit (nhật ký + Retry)

Menu **Quản trị → Service Layer Audit** (yêu cầu quyền xem Cài đặt) ghi lại toàn bộ lệnh gọi từ app sang SAP B1 Service Layer:

| Lệnh gọi | Khi nào được ghi |
|---|---|
| `POST` (đẩy đơn `/Orders`, `/Login` khi bấm “Kiểm tra kết nối”) | **Luôn ghi** — cả thành công lẫn lỗi |
| `GET` lẻ (chi tiết đơn `/Orders(n)`, `/InventoryItems`…) | Chỉ ghi khi **LỖI** |
| `GET` lấy-all (danh sách KH / hàng / kho / đơn — tự phân trang) | Ghi **1 dòng tổng kết** (không spam từng trang) |

Mỗi dòng hiển thị: thời gian, method, endpoint, kết quả (chip OK/LỖI + mã HTTP), thời gian phản hồi (ms). Bấm vào dòng để **mở rộng xem payload JSON đã gửi** và thông báo lỗi đầy đủ. Bộ lọc: trạng thái (Tất cả / Chỉ thành công / Chỉ lỗi) + tìm theo endpoint; nút **Xóa log** dọn toàn bộ nhật ký.

### Chức năng Retry

Nút **Retry** trên mỗi dòng gửi lại lệnh gốc lên Service Layer:

- `POST /Orders` → gửi lại **payload gốc** — SAP sẽ tạo **CHỨNG TỪ MỚI** (app hỏi xác nhận trước vì có thể trùng đơn nếu lệnh gốc thực tế đã thành công).
- `GET …` → gọi lại đúng path + `$filter` đã lưu (an toàn, không đổi dữ liệu).
- `POST /Login` → đăng nhập lại bằng cấu hình **hiện tại** (payload gốc đã được che mật khẩu — app **không bao giờ** lưu mật khẩu SAP vào nhật ký).
- Kết quả Retry được ghi tiếp vào nhật ký với ký hiệu **↻** kèm liên kết về lệnh gốc.

Ứng dụng thực tế: SAP vừa chập chờn → vào Audit xem lệnh nào lỗi, bấm Retry ngay không phải nhập lại đơn; hoặc kiểm tra nhanh “SL có sống không” bằng Retry một lệnh GET.

---

## Bước 13 — Sửa đơn hàng đang Open

Mở **Danh sách đơn hàng bán** → bấm vào 1 đơn **Open** → màn chi tiết có nút **“Sửa”**. Yêu cầu quyền **Sửa** module Đơn hàng và đơn phải còn **Open**:

- Form sửa điền sẵn khách hàng, ngày, ghi chú, kho, **chiết khấu đầu chứng từ (%)** và toàn bộ dòng hàng (số lượng, đơn giá, CK%, VAT%, mã thuế, kho từng dòng) — **giữ nguyên số liệu gốc**, không tự giải lại giá.
- Sửa được: đổi khách hàng, ngày, ghi chú, kho header/dòng, thêm/xóa/sửa dòng hàng. Cột ATP vẫn tự kiểm tra như khi tạo mới.
- **Lưu thay đổi**:
  - Đơn **đã đẩy SAP** (`SAP #DocNum`) → app gọi `PATCH /Orders(DocEntry)` **cập nhật trực tiếp chứng từ trên SAP** trước (header `B1S-ReplaceCollectionsOnPatch=true`: dòng có `LineNum` → cập nhật, dòng mới → thêm, dòng bị bỏ → **xóa trên SAP**). PATCH thành công mới cập nhật dữ liệu local; PATCH bị SL từ chối → **không thay đổi gì cả** và hiện thông báo lỗi thật của SL.
  - Đơn **chưa đẩy SAP** / chưa cấu hình SL → chỉ cập nhật local (đơn pending vẫn bấm “Đẩy lại” như thường).
- Đơn **tạo trực tiếp trong SAP** (không qua app) không có bản ghi local → nút Sửa bị vô hiệu.
- Mọi lệnh `PATCH` được ghi vào **Service Layer Audit** (chip màu vàng đất) và có thể **Retry** như POST/GET.

> ⚠️ Không sửa được chứng từ đã **Closed** (SAP không cho PATCH chứng từ đã đóng). Đơn sửa trên SAP thì **tổng tiền do SAP tính lại** là chuẩn — local được cập nhật theo phản hồi của SL.

---

## Bước 14 — Trợ lý sale admin với LLM miễn phí (chạy nội bộ)

Trợ lý dùng **model mã nguồn mở, miễn phí** chạy trên máy trong mạng nội bộ — không trả phí API,
**không gửi dữ liệu ra ngoài**. Hệ thống gọi máy chủ qua API chuẩn OpenAI (`/v1/chat/completions`).

### 14.1 Cài Ollama + tải model (cách đơn giản nhất)

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh
# Windows / macOS: tải bộ cài tại https://ollama.com/download

ollama pull qwen2.5:7b          # ~4.7 GB — tiếng Việt tốt, hỗ trợ gọi công cụ (tool calling)
curl http://localhost:11434/v1/models   # kiểm tra: phải thấy "qwen2.5:7b"
```

| Model (miễn phí) | RAM / VRAM tối thiểu | Ghi chú |
|---|---|---|
| `qwen2.5:7b` | ~8 GB | **Khuyến nghị** — cân bằng tốc độ/chất lượng, tiếng Việt tốt |
| `qwen2.5:14b` | ~16 GB | Trả lời chính xác hơn, chậm hơn |
| `qwen2.5:3b` | ~4 GB | Máy yếu; hay chọn sai công cụ hơn |

> Model **bắt buộc hỗ trợ tool calling** (trợ lý tra dữ liệu bằng công cụ). Muốn dùng GLM bản mở
> hoặc model khác: kiểm tra trang model trên Ollama có nhãn *tools* trước khi dùng.

**Ngữ cảnh (context):** trợ lý gửi kèm mô tả công cụ + dữ liệu tra cứu (~4–6 nghìn token). Ollama mặc định
ngữ cảnh nhỏ — đặt lớn hơn trước khi chạy (Ollama bản mới):

```bash
# Linux (systemd): sudo systemctl edit ollama  → thêm:
#   [Service]
#   Environment="OLLAMA_CONTEXT_LENGTH=8192"
sudo systemctl restart ollama
```

**Ollama ở máy khác** (máy có GPU): đặt `OLLAMA_HOST=0.0.0.0` cho Ollama trên máy đó, và **chỉ mở cổng
11434 trong mạng nội bộ** (firewall) — Ollama không có xác thực.

### 14.2 Cấu hình trong hệ thống

1. Chạy `npm run db:push` (một lần — thêm cột cấu hình trợ lý).
2. **Cài đặt → Trợ lý sale admin (LLM nội bộ)** → *Mẫu nhanh*: **Ollama** → URL tự điền `http://localhost:11434/v1`
   (Ollama ở máy khác thì sửa `localhost` thành IP máy đó).
3. Bấm **Lưu** → **Tải danh sách model** → chọn `qwen2.5:7b` → tick **Bật trợ lý** → **Lưu** → **Kiểm tra kết nối**.
4. Tải lại trang: nút trợ lý (biểu tượng robot) hiện ở góc phải dưới.

Thay thế Ollama: **LM Studio** (cổng 1234, có giao diện), **llama.cpp server** (cổng 8080),
**vLLM** (cổng 8000, máy chủ GPU — bật tool calling khi khởi động). Đều có trong *Mẫu nhanh*.

### 14.3 Dùng LLM miễn phí trên cloud (không cần máy mạnh)

*Mẫu nhanh* có sẵn: **Zhipu GLM** (`https://open.bigmodel.cn/api/paas/v4`, model gợi ý `glm-4-flash`),
**OpenRouter** (`https://openrouter.ai/api/v1`, chọn model có đuôi `:free`), **Groq**, **Google Gemini**.

1. Đăng ký tài khoản ở nhà cung cấp → tạo **API key** (miễn phí).
2. Cài đặt → Trợ lý → *Mẫu nhanh* chọn nhà cung cấp → dán API key → tick **xác nhận cho phép gửi dữ liệu ra
   dịch vụ bên ngoài** → **Lưu** → **Tải danh sách model** → chọn model free có hỗ trợ tool calling → bật trợ lý → **Lưu**.
3. Kiểm tra trên trang nhà cung cấp tên model miễn phí hiện hành — danh sách model free thay đổi theo thời gian.

> ⚠️ **Dữ liệu rời mạng công ty:** câu hỏi và dữ liệu tra cứu (tên khách, mặt hàng, số lượng, giá, công nợ) được
> gửi tới nhà cung cấp. Hệ thống tự **che SĐT, địa chỉ, ghi chú đơn**; khung chat hiển thị cảnh báo cho người dùng.
> Gói miễn phí thường **giới hạn lượt gọi** (lỗi "đang giới hạn lượt gọi" → đợi vài phút) và có thể dùng dữ liệu để
> huấn luyện — đọc điều khoản trước khi bật. Hệ thống bắt buộc `https://` cho máy chủ ngoài mạng nội bộ.

---

## Bước 15 — Gắn nhân viên kinh doanh cho người dùng

Menu **Quản trị & hệ thống › Quản lý người dùng** (Admin):

- Bảng người dùng có cột **Nhân viên kinh doanh** (hoặc “Chưa gắn”), bộ lọc theo **vai trò / trạng thái / Đã gắn – Chưa gắn**, thẻ thống kê **Đã gắn NV kinh doanh**.
- Bấm ✎ trên một người dùng → hộp thoại gồm 2 phần:
  - **Tài khoản**: tên đăng nhập, họ tên, vai trò, đặt lại mật khẩu.
  - **Gắn nhân viên kinh doanh**: mỗi **cơ sở dữ liệu SAP** một ô chọn (mã NVKD — `SlpCode` — khác nhau giữa các công ty nên gắn riêng từng DB). Danh sách lấy từ **Đồng bộ dữ liệu › Nhân viên bán hàng** — chưa đồng bộ thì làm bước đó trước.
- Nhân viên đã gắn cho người khác → hiện cảnh báo nhưng vẫn cho lưu (nhiều người dùng chung 1 NVKD).
- **Tác dụng:** khi người dùng tạo **đơn hàng, báo giá, hóa đơn, ghi có, trả hàng, đặt cọc** mới, ô **Nhân viên bán hàng** tự điền NVKD đã gắn với DB đang làm việc (vẫn đổi được). Chứng từ sao chép từ chứng từ khác giữ NVBH của chứng từ gốc. NVKD bị ngừng hoạt động trên SAP → không tự điền.
- Danh mục NVBH (chỉ mã + tên) đọc được bởi mọi vai trò có quyền tạo/sửa chứng từ bán hàng.

---

## Bước 16 — Chứng từ bán hàng & tiện ích lên đơn nhanh

**Menu bên trái** sắp theo luồng bán hàng SAP B1: Tổng quan → Báo giá → Đơn hàng bán → Giao hàng → Trả hàng → Đặt cọc → Hóa đơn → Ghi có → Báo cáo bán hàng → Công nợ → Mẫu Excel. Nút **⇤** cạnh logo thu nhỏ menu thành dải icon (desktop; nhớ theo trình duyệt). Tạo đơn mới bằng nút **Tạo đơn hàng bán** ở danh sách đơn / Tổng quan.

**Chứng từ** (đơn hàng, giao hàng, báo giá, hóa đơn, ghi có, trả hàng, đặt cọc):

- Người liên hệ + địa chỉ giao/ghi hóa đơn lấy theo khách hàng, sửa được, gửi SAP `ContactPersonCode` / `ShipToCode` / `BillToCode`.
- Màn **chi tiết** hiển thị đủ thông tin như màn tạo/sửa, cùng bố cục cho cả 7 loại. Chứng từ chỉ có trên SAP (tạo ngoài app) mở ở chế độ **chỉ xem**.
- **Sao chép sang…** gom vào 1 nút menu (copy-from đúng `BaseType` / `BaseEntry` / `BaseLine` của SAP).
- **BOM Template**: thành phần hiển thị theo SL/1 cha, nhân theo SL cha, xóa theo nhóm, thu gọn/mở rộng, đổi thành phần (quyền **Đổi thành phần BOM**). Khi đẩy SAP, app đẩy **2 bước** (POST dòng cha → đọc lại dòng SAP tự bung → PATCH thành phần người dùng nhập) để **không bị nhân đôi công thức** — xem log trong **Service Layer Audit**.

**Tiện ích lên đơn nhanh** (form tạo đơn hàng bán):

| Tiện ích | Cách dùng |
|---|---|
| **Đặt lại đơn gần nhất** | Chọn khách → chọn 1 đơn gần đây → thay hoặc nối thêm toàn bộ dòng |
| **Dán danh sách** | Dán mã/barcode/tên + số lượng từ Excel, Zalo, email vào ô thêm dòng (hoặc Ctrl+V nhiều dòng) |
| **Phím tắt** | `Alt+K` ô khách hàng · `Alt+N` ô thêm dòng · `Ctrl+Enter` lưu · `Ctrl+Shift+Enter` lưu nháp · `Ctrl+Delete` xóa dòng · `?` bảng phím tắt |
| **Kiểm tra trước khi lưu** | Cảnh báo giá 0, số lượng bất thường, trùng mặt hàng, thiếu tồn… trước khi ghi |
| **Giỏ hàng quen của khách** | Lưới mặt hàng khách hay mua (90 ngày) + SL lần trước / trung bình → điền nhanh |
| **Gợi ý ngày giao & kho** | Theo lịch sử đơn của khách (thứ trong tuần, số ngày giao, kho hay dùng) → bấm **Áp dụng** |

---

## 🔧 Xử lý lỗi thường gặp

| Lỗi | Nguyên nhân & cách xử lý |
|---|---|
| Cổng 3000 bị chiếm | `bun run dev -- -p 3001` hoặc đổi PORT khi start production |
| `Environment variable not found: DATABASE_URL` | `.env` phải nằm ở thư mục gốc, đúng tên biến `DATABASE_URL` |
| `no such table` / thiếu bảng khi chạy | Chạy `bunx prisma db push` — bản này `bun run dev` cũng **tự push** trước khi start |
| Lỗi `Unknown argument …` (PrismaClientValidationError) sau khi cập nhật schema | Dev server đang giữ Prisma client cũ — chạy `bash scripts/restart-dev.sh` |
| Lỗi `P1003` / không tìm thấy file db | Đường dẫn trong `.env` sai — kiểm tra `file:` trỏ đúng tới `db/custom.db` |
| Đăng nhập không được sau khi seed lại | Seed sinh mật khẩu mới (in ra console) — dùng mật khẩu đó; xóa cookie cũ: F12 → Application → Cookies → xóa `fm_session` |
| Restart server xong mọi người bị đăng xuất | Chưa đặt `FM_SESSION_SECRET` (≥ 16 ký tự) trong `.env` |
| Production không khởi động: `[fm-crypto] FM_DATA_KEY chưa đặt` | Đặt `FM_DATA_KEY` (≥ 16 ký tự) trong `.env`, rồi nhập lại mật khẩu SAP ở **Cài đặt SAP B1** nếu trước đó chạy không có khóa |
| Lỗi CSS `Parsing CSS source code failed` sau khi cập nhật | Đang chạy bản cũ có lỗi comment CSS — `git pull origin main` lên bản mới; dev vẫn báo lỗi thì dừng server, xóa thư mục `.next` rồi chạy lại |
| Đẩy chứng từ có BOM Template bị nhân đôi thành phần trên SAP | Bản cũ — cập nhật bản mới (đẩy 2 bước, Bước 16). Chứng từ đã lỡ nhân đôi: sửa trên app rồi lưu lại để PATCH đúng dòng |
| Dropdown Nhân viên bán hàng trống / không tự điền | Chưa đồng bộ **Đồng bộ dữ liệu › Nhân viên bán hàng** cho DB đang làm việc, hoặc người dùng chưa được gắn NVKD (Bước 15) |
| PR trên GitHub có check đỏ **Workers Builds** của Cloudflare | Không liên quan code — xem mục **Không deploy lên Cloudflare** bên dưới |
| `bun: command not found` | Cài Bun lại (`npm i -g bun`) hoặc dùng `npm`/`npx` thay thế |
| Seed báo lỗi kiểu dữ liệu | Chỉ với DB demo/mới: `npx prisma db push --accept-data-loss` rồi seed lại. **Không làm trên DB có dữ liệu thật** (cờ này có thể xóa cột/bảng) |
| Build lỗi TypeScript | Đã bật `ignoreBuildErrors` — nếu vẫn lỗi, kiểm tra phiên bản Node ≥ 20 |
| “Kiểm tra kết nối” báo lỗi | Kiểm tra: URL kết thúc `/b1s/v1` hoặc `/b1s/v2`, server SAP mở cổng 50000, firewall/HTTPS cert, đúng CompanyDB + user/password |
| Autocomplete báo lỗi SAP | Xem thông báo trên dropdown — thường do sai mật khẩu SAP hoặc Service Layer không truy cập được |
| Tìm kiếm/tạo đơn báo 400 `the value 'true' of property ')' is invalid` | Bản SL thật **không hỗ trợ ngoặc tròn trong $filter**. Bản mới đã loại hoàn toàn ngoặc: tìm kiếm được tách thành nhiều lượt truy vấn `and`-only rồi gộp kết quả (đơn hàng, khách hàng, mặt hàng). Nếu vẫn thấy lỗi này → **bạn đang chạy bản zip cũ, cần deploy lại bản mới nhất** |
| Audit báo 400 `/InventoryItems?$filter=itemCode…` (viết thường) | OData phân biệt hoa/thường — SL chỉ nhận `ItemCode`. Bản cũ dùng chữ thường; **bản mới đã viết đúng hoa** — deploy lại bản zip mới nhất |
| Audit báo 400 `/SpecialPrices?$select=…` hoặc `/VatGroups` | Một số bản SL từ chối `$select` chứa thuộc tính không có trong metadata (vd `PriceList` — tên thật là `PriceListNo`). Bản mới: **không dùng `$select`** với SpecialPrices/VatGroups + có đường dự phòng thuần cho VatGroups |
| Giá/tồn kho hiển thị 0 trên SL thật | OData v2 của SL trả số thập phân dạng **CHUỖI** (`"185000.000000"`). Bản mới đã ép số an toàn ở mọi nơi đọc giá/tồn/thuế suất từ SL |
| Chi tiết đơn không hiện dòng hàng | App tự thử 3 cách theo thứ tự tương thích mọi bản SL: ① `GET /Orders(N)` thuần — DocumentLines luôn được trả sẵn trong body (chạy được cả trên SL chặn `$expand` — lỗi 201 "Cannot expand invalid navigation property"); ② tập con `GET /Orders(N)/DocumentLines`; ③ `GET /Orders(N)?$expand=DocumentLines`. Cả 3 đều lỗi → modal hiển thị thông báo gộp từng bước + nút **Thử lại**; xem chi tiết trong **Service Layer Audit** |
| ATP báo không đọc được tồn kho | App tự thử `/InventoryItems` → nếu SL không có resource này thì dùng `GET /Items('X')` thuần (ItemWarehouseInfo trả sẵn trong body) → chốt cuối `$expand=ItemWarehouseInfo`. Vẫn lỗi → SL chặn quyền đọc tồn kho; kiểm tra Audit |
| Số liệu chi tiết đơn sai/0 | Đã ép số an toàn cho trường hợp SL trả số dạng chuỗi; nếu vẫn sai, chụp dòng lỗi trong **Service Layer Audit** để kiểm tra |

---

## 📁 Cấu trúc quan trọng

```
sapb1-farmers-market/
├── .env                     # DATABASE_URL, FM_SESSION_SECRET, FM_DATA_KEY (tự tạo từ .env.example, không commit)
├── db/custom.db             # SQLite database (sao lưu file này trước khi cập nhật)
├── prisma/
│   ├── schema.prisma        # Models: User, Role, UserSalesPerson, SapDatabase, SalesOrder, Delivery, Quotation, ArInvoice…
│   └── seed.ts              # Dữ liệu demo (XÓA SẠCH DB trước khi tạo)
├── scripts/                 # dev.js / start.js, mock-sap-server.ts, clear-demo-data.ts, script bảo trì
├── src/
│   ├── app/api/             # REST API nội bộ: auth, orders, deliveries, quotations, invoices, credit-memos, returns,
│   │                        # down-payments, users, roles, sap-databases, sales-persons, payment-terms, items, partners,
│   │                        # vatgroups, warehouses, bom/bom-import, assistant, reports, sap-audit…
│   ├── components/fm/       # Giao diện: app-shell (menu), form/chi tiết chứng từ, users, settings, màn đồng bộ, trợ lý
│   └── lib/                 # sap-service-layer (client B1 duy nhất), fm-auth, fm-crypto (mã hóa secret), sap-push-document,
│                            # sap-bom-reconcile (đẩy BOM 2 bước), order-calc, user-sales-person, assistant/…
├── HUONG-DAN-DEPLOY-LOCAL.md
└── public/                  # Logo, tĩnh
```

---

## 🚀 Chạy service thường trực (tuỳ chọn)

**macOS/Linux (systemd):**

```ini
# /etc/systemd/system/sapb1-so.service
[Unit]
Description=SAP B1 SO System
After=network.target

[Service]
WorkingDirectory=/home/tenban/sapb1-farmers-market
# Nạp DATABASE_URL, FM_SESSION_SECRET, FM_DATA_KEY từ .env (chmod 600 .env)
EnvironmentFile=/home/tenban/sapb1-farmers-market/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node scripts/start.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now sapb1-so
```

Xem log: `journalctl -u sapb1-so -f` (hoặc file `server.log` trong thư mục dự án).

**Docker (tuỳ chọn):** build image từ Node 22, chạy `npm ci && npm run build`, khởi động bằng `node scripts/start.js`,
truyền `FM_SESSION_SECRET` / `FM_DATA_KEY` qua biến môi trường (không bake vào image), mount volume cho `db/` để giữ dữ liệu giữa các lần khởi động.

---

## ☁️ Không deploy lên Cloudflare

Ứng dụng dùng **SQLite + Prisma + Next.js standalone (Node.js)** và kết nối Service Layer trong mạng nội bộ — **không chạy được trên Cloudflare Workers/Pages**. Repo **không có** cấu hình Cloudflare (`wrangler`, OpenNext…); nếu PR trên GitHub vẫn hiện check đỏ **“Workers Builds: sapb1-farmers-market”** hoặc bot bình luận *Deploying Preview to Cloudflare*, đó là tích hợp bật từ phía Cloudflare. Tắt bằng một trong các cách:

1. **Cloudflare dashboard** → **Workers & Pages** → `sapb1-farmers-market` → **Settings → Build** → **Disconnect** repository (hoặc **Delete** worker nếu không dùng).
2. **GitHub** → **Settings → Applications → Installed GitHub Apps → Cloudflare Workers and Pages → Configure** → bỏ repo `sapb1-farmers-market` (hoặc **Uninstall**).

Deploy chuẩn: theo **Bước 6 / 6b** + mục **Chạy service thường trực** ở trên.
