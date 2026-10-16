// ============================================================
// FARMERS MARKET — Import BOM: Canonical model v1.1 (ADR-001, ADR-010)
// Mọi adapter chỉ đọc canonical — không đọc Excel trực tiếp.
// v1.1 tương thích ngược v1.0: chỉ THÊM section optional
// (jobContext/quotation/costing/crossChecks); parents[] giữ nguyên.
// ============================================================

export type BomKind = 'BOM_PRODUCT' | 'BOM_ASSEMBLY'

export interface CanonicalBarcode {
  trade: string | null
  internal8: string | null
  internalI: string | null
}

export interface CanonicalUom {
  purchase: string | null
  sales: string | null
  inventory: string | null
}

export interface CanonicalComponent {
  /** Số dòng Excel (1-based) */
  rowNo: number
  /** Thứ tự dòng trong file, 0-based — KHÔNG dùng STT (quirk Q8) */
  sortOrder: number
  childCode: string
  childName: string | null
  uom: string | null
  /** Định mức gốc cột X (chưa chuẩn hóa) */
  qtyRaw: number | null
  /** Đã chuẩn hóa: X / batchQty, làm tròn 6 decimals (T2, ADR-002) */
  qtyPerParent: number | null
  note: string | null
}

export interface CanonicalMdChecks {
  /** Σ(giá mua Z × định mức X) — chỉ dùng validate, không import (quirk Q14) */
  costTotal: number | null
  /** Tự tính lại = (priceExVat − costTotal)/priceExVat; không tin công thức file (quirk Q7) */
  marginPct: number | null
  /** Cột AC (GIÁ VỐN) nếu có */
  systemCost: number | null
  costDelta: number | null
  uomMismatch: string[]
  duplicateNameHit: boolean
}

export interface CanonicalParent {
  rowNo: number
  /** null = chờ sinh mã theo Q1 (user nhập mã đầu + tăng dần) */
  itemCode: string | null
  itemName: string
  itemNameEn: string | null
  /** I | M | N | W — chỉ lưu canonical, không map B1 (Q3) */
  itemTypeLetter: string | null
  bomKind: BomKind | null
  barcode: CanonicalBarcode
  /** Barcode chính theo Q2a: thương mại → đầu 8 → đầu I */
  primaryBarcode: string | null
  categoryLevel7: string | null
  uom: CanonicalUom
  /** null = kho mặc định trong config (Q9) */
  warehouse: string | null
  /** P0–P4 — giữ nguyên mã, không suy suất (T4) */
  taxIn: string | null
  /** S0–S4 */
  taxOut: string | null
  /** Cột T (+VAT nhập tay) */
  priceIncVat: number | null
  /** Tính lại = T/(1+rate) (T3, Q5: lưu trước VAT) */
  priceExVat: number | null
  /** Giá trị cột Q / S để cross-check công thức (W5) */
  priceCheckQ: number | null
  priceCheckS: number | null
  /** Công thức gốc (pass 2) — phục vụ đối chiếu */
  formulas?: { q?: string; r?: string; s?: string; t?: string }
  supplier: { name: string | null; code: string | null }
  batchQty: number
  components: CanonicalComponent[]
  mdChecks: CanonicalMdChecks
}

export interface JobContextSourceFile {
  field: string
  filename: string
  md5: string
  sha256: string
  bytes: number
  downloadedAt: string
}

export interface CanonicalJobContext {
  jobId: string
  jobName: string | null
  workflowId: string | null
  sourceFiles: JobContextSourceFile[]
}

// Quotation/costing/crossChecks: parse ở Sprint 2 (F19) — khai báo khung v1.1
export interface CanonicalDoc {
  version: '1.1'
  sourceFile: string
  importedAt: string
  batchQtyDefault: number
  parents: CanonicalParent[]
  jobContext?: CanonicalJobContext
  quotation?: unknown
  costing?: unknown
  crossChecks?: unknown[]
}

/** Barcode chính theo Q2a: thương mại → đầu 8 → đầu I */
export function primaryBarcodeOf(b: CanonicalBarcode): string | null {
  return b.trade ?? b.internal8 ?? b.internalI ?? null
}

export interface BuildDocOptions {
  sourceFile: string
  batchQtyDefault?: number
  jobContext?: CanonicalJobContext
  importedAt?: string
}

/** Dựng canonical doc v1.1 từ danh sách parents đã parse */
export function buildCanonicalDoc(
  parents: CanonicalParent[],
  opts: BuildDocOptions,
): CanonicalDoc {
  return {
    version: '1.1',
    sourceFile: opts.sourceFile,
    importedAt: opts.importedAt ?? new Date().toISOString(),
    batchQtyDefault: opts.batchQtyDefault ?? 1,
    parents,
    ...(opts.jobContext ? { jobContext: opts.jobContext } : {}),
  }
}

/** Adapter cũ (chỉ cần parents[]) đọc được cả v1.0 lẫn v1.1 (ADR-010) */
export function parentsOf(doc: { parents: CanonicalParent[] }): CanonicalParent[] {
  return doc.parents
}
