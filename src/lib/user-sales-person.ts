// ============================================================
// Gắn người dùng ↔ nhân viên kinh doanh (SAP OSLP.SlpCode) theo từng DB SAP.
// - Màn Người dùng: chọn NVKD cho từng DB (dropdown từ mirror SalesPerson)
// - Form chứng từ mới: tự điền NVBH = NVKD đã gắn của DB đang làm việc
// SalesPerson có sapDatabaseId null (dữ liệu cũ trước khi đa DB) được coi
// là thuộc DB mặc định.
// ============================================================
import { db as prisma } from '@/lib/db'
import { defaultDatabaseId } from '@/lib/sap-service-layer'

export interface SlpAssignment {
  databaseId: string
  /** null = bỏ gắn */
  code: number | null
}

export interface UserSlpView {
  databaseId: string
  code: number
  name: string | null
}

/** Parse body.salesPersons → danh sách hợp lệ về kiểu (chưa kiểm tồn tại) */
export function parseSlpAssignments(input: unknown): { ok: true; data: SlpAssignment[] } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, data: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'Danh sách nhân viên kinh doanh không hợp lệ' }
  if (input.length > 50) return { ok: false, error: 'Quá nhiều cơ sở dữ liệu trong danh sách gắn NVKD' }
  const seen = new Set<string>()
  const data: SlpAssignment[] = []
  for (const raw of input) {
    const r = raw as { databaseId?: unknown; code?: unknown }
    const databaseId = typeof r?.databaseId === 'string' ? r.databaseId.trim() : ''
    if (!databaseId || databaseId.length > 64) return { ok: false, error: 'Thiếu cơ sở dữ liệu SAP khi gắn NVKD' }
    if (seen.has(databaseId)) return { ok: false, error: 'Mỗi cơ sở dữ liệu chỉ gắn 1 nhân viên kinh doanh' }
    seen.add(databaseId)
    let code: number | null = null
    if (r.code !== null && r.code !== undefined && r.code !== '') {
      const n = Number(r.code)
      if (!Number.isInteger(n) || n < -1 || n > 2_000_000_000) {
        return { ok: false, error: 'Mã nhân viên kinh doanh không hợp lệ' }
      }
      code = n
    }
    data.push({ databaseId, code })
  }
  return { ok: true, data }
}

/** Điều kiện lọc SalesPerson thuộc 1 DB (kèm dòng cũ chưa gán DB nếu là DB mặc định) */
function slpDbWhere(databaseId: string, defaultId: string | null) {
  return databaseId === defaultId
    ? { OR: [{ sapDatabaseId: databaseId }, { sapDatabaseId: null }] }
    : { sapDatabaseId: databaseId }
}

/** Danh mục DB + NVKD đang hoạt động theo từng DB — cho dropdown màn Người dùng */
export async function salesPersonOptions() {
  const defaultId = await defaultDatabaseId()
  const dbs = await prisma.sapDatabase.findMany({
    select: { id: true, label: true, isDefault: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  })
  const rows = await prisma.salesPerson.findMany({
    where: { active: true },
    select: { code: true, name: true, sapDatabaseId: true },
    orderBy: { name: 'asc' },
  })
  const byDb: Record<string, { code: number; name: string }[]> = {}
  for (const d of dbs) byDb[d.id] = []
  for (const r of rows) {
    const key = r.sapDatabaseId ?? defaultId
    if (key && byDb[key]) byDb[key].push({ code: r.code, name: r.name })
  }
  return { databases: dbs, salesPersons: byDb }
}

/** Kiểm tra mã NVKD tồn tại + đang hoạt động trong đúng DB; trả lỗi tiếng Việt */
export async function validateSlpAssignments(list: SlpAssignment[]): Promise<string | null> {
  if (list.length === 0) return null
  const defaultId = await defaultDatabaseId()
  for (const a of list) {
    const dbRow = await prisma.sapDatabase.findUnique({ where: { id: a.databaseId }, select: { label: true } })
    if (!dbRow) return 'Cơ sở dữ liệu SAP không tồn tại'
    if (a.code === null) continue
    const sp = await prisma.salesPerson.findFirst({
      where: { code: a.code, active: true, ...slpDbWhere(a.databaseId, defaultId) },
      select: { code: true },
    })
    if (!sp) return `Nhân viên kinh doanh mã ${a.code} không tồn tại hoặc đã ngừng hoạt động trong "${dbRow.label}"`
  }
  return null
}

/** Ghi danh sách gắn (đã validate): code null → bỏ gắn; DB không có trong list giữ nguyên */
export async function saveSlpAssignments(userId: string, list: SlpAssignment[]) {
  for (const a of list) {
    if (a.code === null) {
      await prisma.userSalesPerson.deleteMany({ where: { userId, sapDatabaseId: a.databaseId } })
    } else {
      await prisma.userSalesPerson.upsert({
        where: { userId_sapDatabaseId: { userId, sapDatabaseId: a.databaseId } },
        create: { userId, sapDatabaseId: a.databaseId, salesPersonCode: a.code },
        update: { salesPersonCode: a.code },
      })
    }
  }
}

/** Gắn NVKD của nhiều user → { userId: [{databaseId, code, name}] } */
export async function slpByUser(userIds: string[]): Promise<Record<string, UserSlpView[]>> {
  if (userIds.length === 0) return {}
  const defaultId = await defaultDatabaseId()
  const links = await prisma.userSalesPerson.findMany({ where: { userId: { in: userIds } } })
  const codes = [...new Set(links.map((l) => l.salesPersonCode))]
  const persons = codes.length
    ? await prisma.salesPerson.findMany({ where: { code: { in: codes } }, select: { code: true, name: true, sapDatabaseId: true } })
    : []
  const nameOf = (dbId: string, code: number) =>
    persons.find((p) => p.code === code && (p.sapDatabaseId ?? defaultId) === dbId)?.name ?? null
  const out: Record<string, UserSlpView[]> = {}
  for (const l of links) {
    ;(out[l.userId] ??= []).push({ databaseId: l.sapDatabaseId, code: l.salesPersonCode, name: nameOf(l.sapDatabaseId, l.salesPersonCode) })
  }
  return out
}

/** NVKD đã gắn của user trong DB đang làm việc (null = chưa gắn / NVKD đã ngừng) */
export async function mySalesPersonCode(userId: string, dbId: string | null): Promise<number | null> {
  if (!dbId) return null
  const link = await prisma.userSalesPerson.findUnique({
    where: { userId_sapDatabaseId: { userId, sapDatabaseId: dbId } },
    select: { salesPersonCode: true },
  })
  if (!link) return null
  const defaultId = await defaultDatabaseId()
  const sp = await prisma.salesPerson.findFirst({
    where: { code: link.salesPersonCode, active: true, ...slpDbWhere(dbId, defaultId) },
    select: { code: true },
  })
  return sp?.code ?? null
}
