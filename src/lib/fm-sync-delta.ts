import { db as prisma } from './db'

// ============================================================
// ĐỒNG BỘ GIA TĂNG (delta sync) master data từ SAP B1 —
// dùng mốc thay đổi (watermark) từ UpdateDate + UpdateTime của Service Layer.
//
// Mỗi (database SAP, entity) giữ một mốc (D, T) = (UpdateDate, UpdateTime)
// lớn nhất đã đồng bộ. Lượt sync gia tăng chỉ tải các bản ghi:
//   UpdateDate > D  HOẶC  (UpdateDate = D VÀ UpdateTime > T)
//
// Vì một số bản Service Layer từ chối `or`/ngoặc tròn trong $filter,
// công thức trên được tách thành 2 query and-only rồi gộp kết quả tại chỗ:
//   ①  <base> and UpdateDate gt datetime'<D>T00:00:00'
//   ②  <base> and UpdateDate eq datetime'<D>T00:00:00' and UpdateTime gt <T>
// ============================================================

/** Mốc thay đổi SAP: ngày (YYYY-MM-DD) + giờ (số nguyên HHMMSS, vd 143025) */
export interface DeltaWatermark {
  date: string
  time: number
}

export type SyncEntity = 'items' | 'partners' | 'vatgroups'

/** Bản ghi SAP B1 tối thiểu cần có để tính watermark */
export interface HasUpdateStamp {
  UpdateDate?: string | null
  UpdateTime?: number | string | null
}

/** Ép UpdateTime (Edm.Int32, vd 143025) về số nguyên HHMMSS */
export const updateTimeNum = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Tách 'YYYY-MM-DD' từ UpdateDate (Edm.DateTime, vd '2026-10-13T00:00:00') */
export const updateDateStr = (v: unknown): string => {
  const d = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''
}

/** Literal datetime cho $filter của Service Layer: datetime'2026-10-13T00:00:00' */
export const dtLit = (date: string): string => `datetime'${date}T00:00:00'`

/**
 * Dựng 2 điều kiện $filter and-only cho delta (không dùng `or`/ngoặc —
 * an toàn với mọi bản Service Layer). Gộp kết quả 2 query rồi khử trùng
 * theo khóa tự nhiên tại chỗ.
 */
export function deltaFilters(baseFilter: string, wm: DeltaWatermark): [string, string] {
  const d = dtLit(wm.date)
  return [
    `${baseFilter} and UpdateDate gt ${d}`,
    `${baseFilter} and UpdateDate eq ${d} and UpdateTime gt ${wm.time}`,
  ]
}

/**
 * Nâng mốc watermark lên max(hiện tại, các bản ghi vừa xử lý).
 * So sánh theo cặp (date, time) — đúng thứ tự thời gian của SAP.
 */
export function advanceWatermark(cur: DeltaWatermark | null, rows: HasUpdateStamp[]): DeltaWatermark {
  let best: DeltaWatermark = cur ?? { date: '0000-00-00', time: 0 }
  for (const r of rows) {
    const d = updateDateStr(r.UpdateDate)
    if (!d) continue
    const t = updateTimeNum(r.UpdateTime)
    if (d > best.date || (d === best.date && t > best.time)) best = { date: d, time: t }
  }
  return best
}

// ---------- Lưu/đọc watermark (theo database SAP + entity) ----------

export async function getWatermark(dbId: string, entity: SyncEntity): Promise<DeltaWatermark | null> {
  const w = await prisma.syncWatermark.findUnique({
    where: { sapDatabaseId_entity: { sapDatabaseId: dbId, entity } },
  })
  if (!w?.lastUpdateDate) return null
  return { date: w.lastUpdateDate, time: w.lastUpdateTime ?? 0 }
}

export async function setWatermark(
  dbId: string,
  entity: SyncEntity,
  wm: DeltaWatermark,
  mode: 'full' | 'incremental',
): Promise<void> {
  // Khong bao gio throw: watermark chi la du lieu phu tro — neu Prisma client
  // chua duoc generate (thieu model SyncWatermark) thi bo qua, sync van chay
  // o che do full thay vi crash ca request.
  try {
    await prisma.syncWatermark.upsert({
      where: { sapDatabaseId_entity: { sapDatabaseId: dbId, entity } },
      create: {
        sapDatabaseId: dbId,
        entity,
        lastUpdateDate: wm.date,
        lastUpdateTime: wm.time,
        lastMode: mode,
        lastSyncAt: new Date(),
      },
      update: {
        lastUpdateDate: wm.date,
        lastUpdateTime: wm.time,
        lastMode: mode,
        lastSyncAt: new Date(),
      },
    })
  } catch {
    /* bo qua — lan sync sau se thu lai sau khi generate */
  }
}

/** Xóa mốc watermark (khi xóa toàn bộ dữ liệu mirror của entity) */
export async function clearWatermark(dbId: string, entity: SyncEntity): Promise<void> {
  try {
    await prisma.syncWatermark.deleteMany({ where: { sapDatabaseId: dbId, entity } })
  } catch {
    /* bo qua — tuong tu setWatermark */
  }
}

/** Thông tin mốc để hiển thị ở màn hình đồng bộ */
export async function watermarkInfo(
  dbId: string | null,
  entity: SyncEntity,
): Promise<{ date: string | null; time: number | null; lastMode: string | null; lastSyncAt: string | null }> {
  if (!dbId) return { date: null, time: null, lastMode: null, lastSyncAt: null }
  const w = await prisma.syncWatermark.findUnique({
    where: { sapDatabaseId_entity: { sapDatabaseId: dbId, entity } },
  })
  return {
    date: w?.lastUpdateDate ?? null,
    time: w?.lastUpdateTime ?? null,
    lastMode: w?.lastMode ?? null,
    lastSyncAt: w?.lastSyncAt ? w.lastSyncAt.toISOString() : null,
  }
}
