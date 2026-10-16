/**
 * Sprint 3 — Apply BOM/Combo lên SAP B1 (F6) + Rollback (F13).
 *
 * Thứ tự mỗi cha (theo thiết kế §5): GET /Items → POST /Items (nếu chưa có)
 * → V4 check mã con tồn tại (fail-fast cả đợt — Q7) → GET /ProductTrees
 * → POST /ProductTrees (nếu chưa có).
 *
 * - Idempotent: pre-check GET trước POST nên chạy lại cùng runId an toàn
 *   (mã đã tồn tại → status 'exists', không tạo trùng).
 * - Lỗi giữa chừng: dừng cha đang chạy (fail-fast), các cha đã xong giữ
 *   nguyên; retry cùng runId tiếp tục được.
 * - Mọi call B1 qua IO với audit 'always' + retryOf=runId (F7).
 * - Rollback: ngược thứ tự tạo — DELETE /ProductTrees trước, DELETE /Items
 *   sau; chỉ xóa key do run này tạo (createdKeys).
 *
 * IO được inject (BomB1IO) để unit test không cần Service Layer thật.
 */
import type { SapConfig } from '../sap-service-layer'
import { sapGet, sapPost, sapDelete, type SapCallResult } from '../sap-service-layer'
import type { CanonicalParent } from './canonical'

/** 1 key đã tạo bởi run — cho rollback */
export interface CreatedKey {
  type: 'tree' | 'item'
  code: string
}

export interface ApplyParentInput {
  rowNo: number
  /** Mã cha đã sinh theo Q1 */
  code: string
  parent: CanonicalParent
}

export type ApplyUnitStatus = 'created' | 'exists' | 'failed'

export interface ParentApplyResult {
  rowNo: number
  code: string
  item: ApplyUnitStatus
  tree: ApplyUnitStatus | 'skipped'
  createdItem: boolean
  createdTree: boolean
  error?: string
}

export interface ApplyBatchResult {
  runId: string
  results: ParentApplyResult[]
  succeeded: number
  failed: number
  createdKeys: CreatedKey[]
}

export interface RollbackResult {
  runId: string
  deleted: CreatedKey[]
  failed: { type: 'tree' | 'item'; code: string; error: string }[]
}

/** IO trừu tượng — production dùng realB1IO, test dùng fake */
export interface BomB1IO {
  get: (path: string, query?: Record<string, string | undefined>) => Promise<SapCallResult>
  post: (path: string, body: unknown) => Promise<SapCallResult>
  del: (path: string) => Promise<SapCallResult>
}

/** IO thật qua Service Layer — mọi call audit 'always' + retryOf=runId (F7) */
export function realB1IO(cfg: SapConfig, runId: string): BomB1IO {
  const opts = { audit: 'always' as const, retryOf: runId }
  return {
    get: (path, query) => sapGet(cfg, path, query ?? {}, opts),
    post: (path, body) => sapPost(cfg, path, body, opts),
    del: (path) => sapDelete(cfg, path, opts),
  }
}

/** Escape mã hàng cho OData key: ' → '' */
export const odataKey = (code: string) => String(code).replace(/'/g, "''")

/**
 * Body POST /Items cho mã cha.
 * Mapping theo các quyết định đã chốt: Q2b (chỉ barcode chính), Q5 (giá trước
 * VAT vào Price List 1), Q8 (Mainsupplier khi NCC khớp tuyệt đối).
 * Q4 (Level 7 → ItemsGroupCode) thuộc bảng tra cấu hình Sprint 4 — chưa map.
 */
export function buildItemBody(code: string, p: CanonicalParent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ItemCode: code,
    ItemName: p.itemName,
    InventoryItem: 't',
    SalesItem: 't',
    PurchaseItem: 't',
  }
  if (p.itemNameEn) body.ForeignName = p.itemNameEn
  if (p.primaryBarcode) body.BarCode = p.primaryBarcode
  if (p.uom.sales) body.SalesUnit = p.uom.sales
  if (p.uom.purchase) body.PurchaseUnit = p.uom.purchase
  if (p.uom.inventory) body.InventoryUOM = p.uom.inventory
  if (p.priceExVat != null) {
    body.ItemPrices = [{ PriceList: 1, Price: Math.round(p.priceExVat * 100) / 100 }]
  }
  if (p.supplier.code) body.Mainsupplier = p.supplier.code
  return body
}

/**
 * Body POST /ProductTrees cho mã cha.
 * Q6: BOM_PRODUCT → iProductionTree, BOM_ASSEMBLY (COMBO) → iAssemblyTree.
 * Q10: Quantity = 1 (định mức con đã chuẩn hóa về 1 đơn vị cha).
 */
export function buildTreeBody(code: string, p: CanonicalParent): Record<string, unknown> {
  const treeType =
    p.bomKind === 'BOM_ASSEMBLY' ? 'iAssemblyTree' : p.bomKind === 'BOM_PRODUCT' ? 'iProductionTree' : null
  if (!treeType) {
    throw new Error(`bomKind chưa xác định (dòng Excel ${p.rowNo}) — không tạo được ProductTrees`)
  }
  return {
    TreeCode: code,
    TreeType: treeType,
    Quantity: 1,
    ProductTreeLines: p.components.map((c) => ({
      ItemCode: c.childCode,
      Quantity: c.qtyPerParent ?? c.qtyRaw ?? 1,
      ...(p.warehouse ? { Warehouse: p.warehouse } : {}),
    })),
  }
}

async function applyOneParent(io: BomB1IO, input: ApplyParentInput): Promise<ParentApplyResult> {
  const { rowNo, code, parent } = input
  const key = odataKey(code)
  const res: ParentApplyResult = {
    rowNo,
    code,
    item: 'failed',
    tree: 'skipped',
    createdItem: false,
    createdTree: false,
  }

  // 1. GET /Items — tồn tại thì bỏ qua (idempotent)
  const getItem = await io.get(`/Items('${key}')`, { $select: 'ItemCode' })
  if (!getItem.ok && getItem.status !== 404) {
    res.error = `GET /Items('${code}') lỗi: ${getItem.error ?? `HTTP ${getItem.status}`}`
    return res
  }
  if (getItem.ok) {
    res.item = 'exists'
  } else {
    // 2. POST /Items
    const post = await io.post('/Items', buildItemBody(code, parent))
    if (!post.ok) {
      res.error = `POST /Items('${code}') lỗi: ${post.error ?? `HTTP ${post.status}`}`
      return res
    }
    res.item = 'created'
    res.createdItem = true
  }

  // 3. V4: mã con phải tồn tại trên B1 — thiếu → fail-fast cả đợt (Q7)
  for (const c of parent.components) {
    const g = await io.get(`/Items('${odataKey(c.childCode)}')`, { $select: 'ItemCode' })
    if (!g.ok) {
      res.error =
        `Mã NVL '${c.childCode}' chưa tồn tại trên B1 (dòng Excel ${c.rowNo}) — ` +
        `dừng cả đợt theo Q7. Bổ sung mã hàng trên B1 rồi retry cùng run này.`
      return res
    }
  }

  // 4. GET /ProductTrees — tồn tại thì bỏ qua (idempotent)
  const getTree = await io.get(`/ProductTrees('${key}')`, { $select: 'TreeCode' })
  if (!getTree.ok && getTree.status !== 404) {
    res.error = `GET /ProductTrees('${code}') lỗi: ${getTree.error ?? `HTTP ${getTree.status}`}`
    return res
  }
  if (getTree.ok) {
    res.tree = 'exists'
  } else {
    // 5. POST /ProductTrees
    let treeBody: Record<string, unknown>
    try {
      treeBody = buildTreeBody(code, parent)
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e)
      return res
    }
    const post = await io.post('/ProductTrees', treeBody)
    if (!post.ok) {
      res.error = `POST /ProductTrees('${code}') lỗi: ${post.error ?? `HTTP ${post.status}`}`
      return res
    }
    res.tree = 'created'
    res.createdTree = true
  }
  return res
}

/**
 * Apply từng cha theo thứ tự. Fail-fast: cha lỗi → dừng cả đợt, các cha đã
 * xong giữ nguyên (retry cùng runId tiếp tục an toàn nhờ idempotent).
 */
export async function applyParents(
  io: BomB1IO,
  runId: string,
  inputs: ApplyParentInput[],
): Promise<ApplyBatchResult> {
  const results: ParentApplyResult[] = []
  const createdKeys: CreatedKey[] = []
  for (const input of inputs) {
    const r = await applyOneParent(io, input)
    results.push(r)
    if (r.createdTree) createdKeys.push({ type: 'tree', code: r.code })
    if (r.createdItem) createdKeys.push({ type: 'item', code: r.code })
    // Fail-fast: cha lỗi (kể cả V4 thiếu mã con) → dừng cả đợt
    if (r.error) break
  }
  const failed = results.filter((r) => !!r.error).length
  return { runId, results, succeeded: results.length - failed, failed, createdKeys }
}

/**
 * Rollback theo runId (F13): ngược thứ tự tạo — xóa ProductTrees trước,
 * Items sau; chỉ xóa key do run này tạo. Key đã xóa thành công được trả về
 * để caller cập nhật createdKeys (phần lỗi giữ lại để retry rollback).
 */
export async function rollbackCreated(
  io: BomB1IO,
  runId: string,
  createdKeys: CreatedKey[],
): Promise<RollbackResult> {
  const deleted: CreatedKey[] = []
  const failed: RollbackResult['failed'] = []
  // Ngược thứ tự tạo + tree trước item (sort ổn định trên Node hiện đại)
  const ordered = [...createdKeys]
    .reverse()
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'tree' ? -1 : 1))
  for (const k of ordered) {
    const path = k.type === 'tree' ? `/ProductTrees('${odataKey(k.code)}')` : `/Items('${odataKey(k.code)}')`
    const r = await io.del(path)
    // 404 khi rollback lại = đã sạch → coi như xong
    if (r.ok || r.status === 404) deleted.push(k)
    else failed.push({ ...k, error: r.error ?? `HTTP ${r.status}` })
  }
  return { runId, deleted, failed }
}
