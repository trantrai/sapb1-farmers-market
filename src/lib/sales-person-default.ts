// ============================================================
// Tự điền nhân viên bán hàng (NVBH) cho chứng từ MỚI theo NVKD gắn với người
// dùng ở DB đang làm việc (GET /api/sales-persons → mine). Không ghi đè giá trị
// đã có (người dùng đã chọn, nháp khôi phục, chứng từ sao chép từ nguồn).
// ============================================================

/** Đọc `mine` từ payload /api/sales-persons → mã NVKD hoặc null */
export function parseMySalesPerson(payload: unknown): number | null {
  const v = (payload as { mine?: unknown } | null)?.mine
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}

/** Form B2B (ô NVBH dạng chuỗi): điền mã khi đang trống */
export function withMySalesPerson<T extends { salesPersonCode: string }>(form: T, mine: number | null): T {
  if (mine === null || form.salesPersonCode !== '') return form
  return { ...form, salesPersonCode: String(mine) }
}
