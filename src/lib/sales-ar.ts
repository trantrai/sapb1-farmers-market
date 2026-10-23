// ============================================================
// SALES A/R — PHASE 1: handlers dùng chung cho 4 chứng từ mới
// (Báo giá / Hóa đơn bán hàng / Phiếu ghi có phải thu / Phiếu trả hàng).
// PHASE 2 (2026-10-17): + Hóa đơn đặt cọc phải thu (DownPayments),
// lưu nháp (isDraft) cho mọi chứng từ, docType hóa đơn
// (Item/Service/Reserve), khấu trừ đặt cọc dần (DownPaymentDraw).
//
// Tái dùng pattern của /api/orders và /api/deliveries/from-order:
// RBAC theo module, cách ly theo sapDatabaseId, gộp SAP + local ở
// danh sách, optimistic locking (version), chống tạo trùng khi bấm
// đúp (order lock + dedupeRequest), tính totals qua @/lib/order-calc.
//
// Đẩy SAP Service Layer: POST tạo mới / PATCH sửa khi đã synced
// (pushDocumentToSap / patchDocumentToSap dùng chung entitySet).
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { parsePageParam, type ModuleKey } from '@/lib/fm-shared'
import { rateLimit } from '@/lib/rate-limit'
import { dedupeRequest, acquireOrderLock, releaseOrderLock } from '@/lib/idempotency'
import { loadSapSettings, isSapConfigured } from '@/lib/sap-service-layer'
import { calcOrderLines, orderTotals, validateOrderLines, type OrderLineInput } from '@/lib/order-calc'
import { normalizeBomLines } from '@/lib/order-bom'
import { nextDocNum, type SalesDocType } from '@/lib/doc-num'
import { pushDocumentToSap, patchDocumentToSap, bomLineFields } from '@/lib/sap-push-document'
// WORKER C: đọc chứng từ trực tiếp từ SAP B1 Service Layer.
// Contract: fetchSapDocuments(entitySet, databaseId?) →
//   Promise<{ ok: boolean; rows: SapDocRow[]; error?: string }>
import { fetchSapDocuments, type SapDocRow } from '@/lib/sap-documents'

/**
 * Lỗi nghiệp vụ có mã HTTP — hooks ném lỗi này để handler trả về
 * response 4xx đúng thay vì 500. (Phase 2)
 */
export class SalesDocError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'SalesDocError'
    this.status = status
  }
}

/**
 * Hooks mở rộng theo loại chứng từ (Phase 2) — mọi hook đều tùy chọn,
 * chứng từ không cần thì không khai báo, luồng chung giữ nguyên.
 */
export interface SalesDocHooks {
  /**
   * Trường header bổ sung khi TẠO — vd đặt cọc: remainingAmount = grandTotal;
   * hóa đơn: docType từ body.
   */
  extraCreateFields?: (ctx: { grandTotal: number; body: Record<string, unknown> }) => Record<string, unknown>
  /**
   * Trường header bổ sung khi SỬA toàn bộ — vd hóa đơn: docType từ body.
   * Ném SalesDocError khi giá trị không hợp lệ.
   */
  extraUpdateFields?: (body: Record<string, unknown>) => Record<string, unknown>
  /**
   * Validate danh sách khấu trừ đặt cọc (CHỈ ĐỌC, không ghi) — ném
   * SalesDocError khi vi phạm rule. Chạy TRƯỚC khi cấp docNum để lỗi
   * validate của user không đốt số chứng từ.
   */
  validateDraws?: (
    db: any,
    draws: unknown,
    cardCode: string,
    grandTotal: number,
  ) => Promise<ParsedDraw[]>
  /**
   * Ghi DownPaymentDraw + trừ remainingAmount — chạy TRONG transaction
   * tạo/cập nhật hóa đơn (nguyên tử với lưu chứng từ).
   */
  writeDraws?: (tx: any, docId: string, parsed: ParsedDraw[]) => Promise<void>
  /**
   * Giải phóng khấu trừ khi sửa (thay draws mới) hoặc xóa hóa đơn:
   * hoàn lại remainingAmount cho các đặt cọc rồi xóa dòng draw.
   */
  releaseDraws?: (tx: any, docId: string) => Promise<void>
  /**
   * Sau khi SỬA toàn bộ — vd đặt cọc: tính lại remainingAmount =
   * grandTotal mới − tổng đã khấu trừ. Ném SalesDocError nếu tổng mới
   * nhỏ hơn số đã khấu trừ.
   */
  afterFullUpdate?: (tx: any, docId: string, grandTotal: number) => Promise<void>
  /**
   * Trả về thông báo lỗi nếu KHÔNG được xóa (vd đặt cọc đã bị khấu trừ),
   * null = được xóa.
   */
  checkDelete?: (id: string) => Promise<string | null>
}

/** 1 dòng khấu trừ đã validate: { downPaymentId, drawAmount } */
export interface ParsedDraw {
  downPaymentId: string
  drawAmount: number
}

export interface SalesDocConfig {
  /** Loại chứng từ — dùng cho dãy số DocNumSequence */
  docType: SalesDocType
  /** RBAC module key: user.permissions[<permModule>] */
  permModule: ModuleKey
  /** Entity set Service Layer để đọc live (WORKER C) */
  entitySet: 'Quotations' | 'Invoices' | 'CreditNotes' | 'Returns' | 'DownPayments'
  /** Tên đầy đủ: 'Báo giá bán hàng' */
  label: string
  /** Tên ngắn cho câu lỗi: 'báo giá' */
  short: string
  /** Key kết quả trong JSON trả về */
  resultKey: 'quotation' | 'invoice' | 'creditMemo' | 'salesReturn' | 'downPayment'
  /** Prisma delegate của header (dùng ngoài transaction) */
  model: any
  /** Tên delegate trong tx: 'quotation' | 'arInvoice' | ... */
  modelKey: string
  /** Tên delegate dòng trong tx: 'quotationLine' | ... */
  lineModelKey: string
  /** Tên FK dòng → header: 'quotationId' | 'invoiceId' | ... */
  lineFk: string
  /** Các FK chứng từ nguồn cho phép khi tạo/copy */
  sourceFks: string[]
  /** Hooks mở rộng theo loại chứng từ (Phase 2) */
  hooks?: SalesDocHooks
  /** Đợt 2 — loại chứng từ có cột paidAmount/paymentStatus (hóa đơn / ghi có / đặt cọc) */
  supportsPayment?: boolean
  /** Đợt 2 — dòng chứng từ có cột batchNumber (phiếu trả hàng) */
  lineBatchNumber?: boolean
}

export const QUOTATION_CFG: SalesDocConfig = {
  docType: 'quotation',
  permModule: 'quotations',
  entitySet: 'Quotations',
  label: 'Báo giá bán hàng',
  short: 'báo giá',
  resultKey: 'quotation',
  model: prisma.quotation,
  modelKey: 'quotation',
  lineModelKey: 'quotationLine',
  lineFk: 'quotationId',
  sourceFks: [],
}

// ---------- Phase 2: helpers khấu trừ đặt cọc (dùng cho Hóa đơn bán hàng) ----------

/** docType hợp lệ của hóa đơn: Item | Service | Reserve */
function validInvoiceDocType(v: unknown): 'Item' | 'Service' | 'Reserve' | undefined {
  const s = String(v ?? '').trim()
  return s === 'Item' || s === 'Service' || s === 'Reserve' ? s : undefined
}

/**
 * Hóa đơn dịch vụ (docType=Service → SAP dDocument_Service): MỌI dòng bắt
 * buộc có mã tài khoản (SAP: DocumentLines.AccountCode). Trả thông báo lỗi
 * tiếng Việt khi có dòng thiếu, ngược lại trả null.
 */
export function validateServiceLineAccounts(
  docType: unknown,
  lines: Array<{ itemCode?: unknown; accountCode?: unknown }>,
): string | null {
  if (docType !== 'Service') return null
  for (let i = 0; i < lines.length; i++) {
    const acct = String(lines[i]?.accountCode ?? '').trim()
    if (!acct) {
      const code = String(lines[i]?.itemCode ?? '').trim()
      return `Hóa đơn dịch vụ: dòng ${i + 1}${code ? ` (${code})` : ''} thiếu mã Tài khoản — vui lòng nhập Tài khoản cho mọi dòng (SAP B1 bắt buộc AccountCode với dòng dịch vụ).`
    }
  }
  return null
}

/**
 * Validate danh sách khấu trừ đặt cọc (CHỈ ĐỌC — không ghi DB).
 * Ném SalesDocError khi vi phạm.
 * Rule: đặt cọc cùng cardCode, đang Open, không phải nháp, số dư đủ,
 * tổng draw ≤ tổng hóa đơn, không trùng đặt cọc.
 */
async function validateInvoiceDraws(
  db: any,
  draws: unknown,
  cardCode: string,
  grandTotal: number,
): Promise<ParsedDraw[]> {
  if (!Array.isArray(draws)) {
    throw new SalesDocError(400, 'draws phải là một mảng [{ downPaymentId, drawAmount }]')
  }
  const parsed: ParsedDraw[] = []
  const seen = new Set<string>()
  let total = 0
  for (const d of draws) {
    const downPaymentId = String((d as any)?.downPaymentId ?? '').trim()
    const drawAmount = Number((d as any)?.drawAmount)
    if (!downPaymentId) throw new SalesDocError(400, 'Thiếu downPaymentId trong danh sách khấu trừ')
    if (seen.has(downPaymentId)) throw new SalesDocError(400, 'Trùng hóa đơn đặt cọc trong danh sách khấu trừ')
    seen.add(downPaymentId)
    if (!Number.isFinite(drawAmount) || drawAmount <= 0) {
      throw new SalesDocError(400, 'Số tiền khấu trừ phải là số > 0')
    }
    const dp = await db.arDownPayment.findUnique({ where: { id: downPaymentId } })
    if (!dp) throw new SalesDocError(400, 'Không tìm thấy hóa đơn đặt cọc cần khấu trừ')
    if (dp.cardCode !== cardCode) {
      throw new SalesDocError(
        400,
        `Hóa đơn đặt cọc #${dp.docNum ?? 'nháp'} không cùng khách hàng với hóa đơn`,
      )
    }
    if (dp.isDraft) throw new SalesDocError(400, 'Không thể khấu trừ từ hóa đơn đặt cọc đang là nháp')
    if (dp.status !== 'Open') throw new SalesDocError(400, 'Chỉ được khấu trừ từ hóa đơn đặt cọc đang ở trạng thái Open')
    // Đặt cọc chưa synced lên SAP không thể tham chiếu DocEntry khi đẩy hóa đơn —
    // chặn ngay tại validate để tránh lệch số dư DP giữa local và SAP.
    if (typeof dp.sapDocEntry !== 'number') {
      throw new SalesDocError(
        400,
        `Không thể khấu trừ đặt cọc #${dp.docNum ?? 'nháp'}: chứng từ đặt cọc chưa được đẩy lên SAP B1. Vui lòng đẩy đặt cọc lên SAP trước.`,
      )
    }
    const remaining = Number(dp.remainingAmount)
    if (drawAmount - remaining > 1e-9) {
      throw new SalesDocError(
        400,
        `Số tiền khấu trừ vượt số dư còn lại của đặt cọc #${dp.docNum ?? 'nháp'} (còn ${remaining})`,
      )
    }
    parsed.push({ downPaymentId, drawAmount })
    total += drawAmount
  }
  if (total - grandTotal > 1e-9) {
    throw new SalesDocError(400, 'Tổng tiền khấu trừ vượt tổng tiền hóa đơn')
  }
  return parsed
}

/**
 * Ghi DownPaymentDraw + trừ remainingAmount — chạy TRONG transaction
 * tạo/cập nhật hóa đơn (nguyên tử với lưu chứng từ).
 */
async function writeInvoiceDraws(tx: any, invoiceId: string, parsed: ParsedDraw[]): Promise<void> {
  for (const p of parsed) {
    await tx.downPaymentDraw.create({
      data: { invoiceId, downPaymentId: p.downPaymentId, drawAmount: new Prisma.Decimal(p.drawAmount) },
    })
    await tx.arDownPayment.update({
      where: { id: p.downPaymentId },
      data: { remainingAmount: { decrement: new Prisma.Decimal(p.drawAmount) } },
    })
  }
}

/**
 * Giải phóng khấu trừ của hóa đơn: hoàn lại remainingAmount cho các đặt cọc
 * rồi xóa dòng draw. Dùng khi sửa (thay draws mới) hoặc xóa hóa đơn.
 */
async function releaseInvoiceDraws(tx: any, invoiceId: string): Promise<void> {
  const draws = await tx.downPaymentDraw.findMany({ where: { invoiceId } })
  for (const d of draws) {
    await tx.arDownPayment.update({
      where: { id: d.downPaymentId },
      data: { remainingAmount: { increment: d.drawAmount } },
    })
  }
  await tx.downPaymentDraw.deleteMany({ where: { invoiceId } })
}

/** Hooks khấu trừ đặt cọc gắn vào INVOICE_CFG (Phase 2) */
const INVOICE_DRAW_HOOKS: SalesDocHooks = {
  extraCreateFields: ({ body }) => {
    const dt = validInvoiceDocType((body as any).docType)
    return dt ? { docType: dt } : {}
  },
  extraUpdateFields: (body) => {
    if ((body as any).docType === undefined) return {}
    const dt = validInvoiceDocType((body as any).docType)
    if (!dt) throw new SalesDocError(400, 'docType không hợp lệ — chỉ nhận Item | Service | Reserve')
    return { docType: dt }
  },
  validateDraws: validateInvoiceDraws,
  writeDraws: writeInvoiceDraws,
  releaseDraws: releaseInvoiceDraws,
}

export const INVOICE_CFG: SalesDocConfig = {
  docType: 'invoice',
  permModule: 'invoices',
  entitySet: 'Invoices',
  label: 'Hóa đơn bán hàng',
  short: 'hóa đơn',
  resultKey: 'invoice',
  model: prisma.arInvoice,
  modelKey: 'arInvoice',
  lineModelKey: 'arInvoiceLine',
  lineFk: 'invoiceId',
  sourceFks: ['sourceQuotationId', 'sourceOrderId', 'sourceDeliveryId'],
  hooks: INVOICE_DRAW_HOOKS,
  supportsPayment: true, // Đợt 2: paidAmount/paymentStatus
}

export const CREDIT_MEMO_CFG: SalesDocConfig = {
  docType: 'creditMemo',
  permModule: 'creditMemos',
  entitySet: 'CreditNotes',
  label: 'Phiếu ghi có phải thu',
  short: 'phiếu ghi có',
  resultKey: 'creditMemo',
  model: prisma.arCreditMemo,
  modelKey: 'arCreditMemo',
  lineModelKey: 'arCreditMemoLine',
  lineFk: 'creditMemoId',
  sourceFks: ['sourceInvoiceId', 'sourceReturnId'],
  supportsPayment: true, // Đợt 2: paidAmount/paymentStatus
}

export const RETURN_CFG: SalesDocConfig = {
  docType: 'return',
  permModule: 'returns',
  entitySet: 'Returns',
  label: 'Phiếu trả hàng bán',
  short: 'phiếu trả hàng',
  resultKey: 'salesReturn',
  model: prisma.salesReturn,
  modelKey: 'salesReturn',
  lineModelKey: 'salesReturnLine',
  lineFk: 'returnId',
  sourceFks: ['sourceDeliveryId', 'sourceInvoiceId'],
  lineBatchNumber: true, // Đợt 2: cột batchNumber (Số lô) trên dòng trả hàng
}

// ---------- Phase 2: Hóa đơn đặt cọc phải thu (203/ODPI) ----------
export const DOWN_PAYMENT_CFG: SalesDocConfig = {
  docType: 'downPayment',
  permModule: 'downPayments',
  entitySet: 'DownPayments',
  label: 'Hóa đơn đặt cọc phải thu',
  short: 'hóa đơn đặt cọc',
  resultKey: 'downPayment',
  model: prisma.arDownPayment,
  modelKey: 'arDownPayment',
  lineModelKey: 'arDownPaymentLine',
  lineFk: 'downPaymentId',
  sourceFks: ['sourceQuotationId', 'sourceOrderId'],
  supportsPayment: true, // Đợt 2: paidAmount/paymentStatus
  hooks: {
    // Tạo mới: số dư còn lại = tổng tiền chứng từ
    extraCreateFields: ({ grandTotal }) => ({
      remainingAmount: new Prisma.Decimal(grandTotal),
    }),
    // Sửa toàn bộ: tính lại số dư = tổng mới − tổng đã khấu trừ
    afterFullUpdate: async (tx, docId, grandTotal) => {
      const agg = await tx.downPaymentDraw.aggregate({
        where: { downPaymentId: docId },
        _sum: { drawAmount: true },
      })
      const drawn = Number(agg._sum.drawAmount ?? 0)
      if (drawn - grandTotal > 1e-9) {
        throw new SalesDocError(
          400,
          'Tổng tiền mới nhỏ hơn số tiền đã bị hóa đơn khấu trừ — không thể sửa',
        )
      }
      await tx.arDownPayment.update({
        where: { id: docId },
        data: { remainingAmount: new Prisma.Decimal(grandTotal - drawn) },
      })
    },
    // Không xóa đặt cọc đã bị hóa đơn khấu trừ (tránh treo công nợ)
    checkDelete: async (id) => {
      const n = await prisma.downPaymentDraw.count({ where: { downPaymentId: id } })
      return n > 0
        ? 'Không thể xóa hóa đơn đặt cọc đã bị hóa đơn bán hàng khấu trừ'
        : null
    },
  },
}

/** Dòng hàng đầu vào — mở rộng OrderLineInput với liên kết dòng nguồn */
export interface SalesDocLineInput extends OrderLineInput {
  sourceLineId?: string
  /** Số lô (SAP BatchNumbers) — chỉ dòng Phiếu trả hàng bán */
  batchNumber?: string | null
}

// ---------- Đợt 2: helpers Thông tin B2B / SAP B1 trên header ----------

/** Trạng thái thanh toán suy từ số tiền đã thu vs tổng chứng từ:
 *  paid nếu paidAmount >= grandTotal, partial nếu paidAmount > 0, else unpaid.
 *  Export cho tầng ghi nhận thanh toán (worker khác) dùng chung. */
export function derivePaymentStatus(paidAmount: unknown, grandTotal: unknown): 'paid' | 'partial' | 'unpaid' {
  const paid = Math.max(0, Number(paidAmount) || 0)
  const grand = Math.max(0, Number(grandTotal) || 0)
  if (paid >= grand) return 'paid'
  if (paid > 0) return 'partial'
  return 'unpaid'
}

/** Nhãn tiếng Việt cho chip trạng thái thanh toán — worker khác tái dùng khi cần */
export const PAYMENT_STATUS_VN: Record<string, string> = {
  unpaid: 'Chưa thanh toán',
  partial: 'Thanh toán một phần',
  paid: 'Đã thanh toán hết',
}

const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}

const strOrNull = (v: unknown, max = 100): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s.slice(0, max) : null
}

const dateOrNull = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Chuẩn hóa đính kèm: mảng [{name, url}] → JSON string (cột attachmentsJson).
 *  Chấp nhận mảng hoặc chuỗi JSON — sai định dạng → null. */
function parseAttachments(v: unknown): string | null {
  let arr: unknown = v
  if (typeof v === 'string') {
    try {
      arr = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!Array.isArray(arr)) return null
  const cleaned = arr
    .slice(0, 20)
    .map((a) => ({
      name: String((a as { name?: unknown })?.name ?? '').trim().slice(0, 200),
      url: String((a as { url?: unknown })?.url ?? '').trim().slice(0, 2000),
    }))
    .filter((a) => a.name || a.url)
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null
}

export interface B2bHeaderFields {
  salesPersonCode: number | null
  paymentGroupCode: number | null
  shipToCode: string | null
  billToCode: string | null
  contactPersonCode: number | null
  numAtCard: string | null
  taxDate: Date | null
  docCurrency: string
  docRate: number
  projectCode: string | null
  attachmentsJson: string | null
}

/** Parse các trường B2B từ body. taxDate bỏ trống → mặc định = ngày chứng từ. */
function parseB2bHeader(body: Record<string, unknown>, fallbackDate: Date): B2bHeaderFields {
  const docRate = Number(body.docRate)
  return {
    salesPersonCode: intOrNull(body.salesPersonCode),
    paymentGroupCode: intOrNull(body.paymentGroupCode),
    shipToCode: strOrNull(body.shipToCode, 50),
    billToCode: strOrNull(body.billToCode, 50),
    contactPersonCode: intOrNull(body.contactPersonCode),
    numAtCard: strOrNull(body.numAtCard, 100),
    taxDate: dateOrNull(body.taxDate) ?? fallbackDate,
    docCurrency: (strOrNull(body.docCurrency, 3) ?? 'VND').toUpperCase(),
    docRate: Number.isFinite(docRate) && docRate > 0 ? docRate : 1,
    projectCode: strOrNull(body.projectCode, 50),
    attachmentsJson: parseAttachments(
      body.attachments !== undefined ? body.attachments : body.attachmentsJson,
    ),
  }
}

/** Dựng payload create cho 1 dòng (dùng chung POST / from-source / PATCH) */
function lineCreateData(l: any, i: number, withBatchNumber = false): Record<string, unknown> {
  return {
    lineNum: i + 1,
    itemCode: l.itemCode,
    itemName: l.itemName,
    uom: l.uom || 'kg',
    warehouseCode: (l.warehouseCode || '').trim() || null,
    taxCode: (l.taxCode?.trim() || null) as string | null,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
    discPct: l.discPct,
    discAmt: l.discAmt,
    vatPct: l.vatPct,
    vatAmt: l.vatAmt,
    grandTotal: l.grandTotal,
    isBomChild: l.isBomChild ?? false,
    bomGroupKey: l.bomGroupKey ?? null,
    bomEditable: l.bomEditable ?? true,
    bomQtyPerParent: l.bomQtyPerParent ?? null,
    sourceLineId: l.sourceLineId ?? null,
    // accountCode chỉ có cột trong DB của ArInvoiceLine (dòng hóa đơn) —
    // chỉ ghi khi input truyền (guard để các loại chứng từ khác không vỡ Prisma).
    ...(l.accountCode !== undefined
      ? { accountCode: (typeof l.accountCode === 'string' ? l.accountCode.trim() : '') || null }
      : {}),
    // batchNumber chỉ có cột trong DB của SalesReturnLine (dòng trả hàng) —
    // guard theo config loại chứng từ (Đợt 2).
    ...(withBatchNumber ? { batchNumber: strOrNull(l.batchNumber, 60) } : {}),
  }
}

type HeaderBody = {
  cardCode?: string
  cardName?: string
  docDate?: string
  docDueDate?: string
  remarks?: string
  warehouseCode?: string
  headerDiscPct?: number
  lines?: SalesDocLineInput[]
  /** Đợt 2 — Thông tin B2B / SAP B1 */
  salesPersonCode?: unknown
  paymentGroupCode?: unknown
  shipToCode?: unknown
  billToCode?: unknown
  contactPersonCode?: unknown
  numAtCard?: unknown
  taxDate?: unknown
  docCurrency?: unknown
  docRate?: unknown
  projectCode?: unknown
  attachments?: unknown
  attachmentsJson?: unknown
  /** Đợt 2 — số tiền đã thu (hóa đơn / ghi có / đặt cọc) */
  paidAmount?: unknown
}

// ==================== GET list ====================

/**
 * GET danh sách: filter (q theo số/tên/mã KH, status, khoảng ngày)
 * + phân trang. Khi đã cấu hình SAP B1 → gộp chứng từ live từ
 * Service Layer (WORKER C) với chứng từ local chưa đẩy — cùng quy
 * ước khử trùng như trang Đơn hàng (local đã synced + trùng DocEntry
 * thì ẩn bản local, giữ bản SAP).
 */
export async function salesDocList(req: NextRequest, cfg: SalesDocConfig) {
  try {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.view) {
    return NextResponse.json({ error: `Bạn không có quyền xem ${cfg.label.toLowerCase()}` }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const page = parsePageParam(sp.get('page'), 1, 1, 100000)
  const pageSize = parsePageParam(sp.get('pageSize'), 8, 5, 50)
  const q = (sp.get('q') ?? '').trim()
  const status = sp.get('status') ?? ''
  const from = sp.get('from') ?? ''
  const to = sp.get('to') ?? ''
  // Phase 2: lọc nháp — ?isDraft=true chỉ lấy nháp, ?isDraft=false chỉ lấy chính thức
  const isDraftParam = sp.get('isDraft') ?? ''
  const draftFilter = isDraftParam === 'true' ? true : isDraftParam === 'false' ? false : null

  // B1: cách ly theo database — user chỉ thấy chứng từ của DB mình đăng nhập
  // (kèm chứng từ NULL sapDatabaseId — tạo trước khi có multi-DB, coi như thuộc DB hiện tại)
  const s = await loadSapSettings(user.databaseId)
  const dbId = s?.dbId ?? null
  const where: Record<string, unknown> = {}
  const andConds: Record<string, unknown>[] = []
  if (dbId) andConds.push({ OR: [{ sapDatabaseId: dbId }, { sapDatabaseId: "" }] })
  // Phase 2: lọc nháp — ?isDraft=true chỉ lấy nháp, ?isDraft=false lấy chính thức
  // (NULL isDraft — chứng từ cũ trước Phase 2 — coi như chính thức)
  if (draftFilter === true) where.isDraft = true
  else if (draftFilter === false) andConds.push({ isDraft: false })
  if (q) {
    andConds.push({
      OR: [
        { docNum: isNaN(Number(q)) ? undefined : Number(q) },
        { cardName: { contains: q } },
        { cardCode: { contains: q } },
        // Đợt 2: tìm theo số PO của khách hàng (SAP NumAtCard)
        { numAtCard: { contains: q } },
      ].filter(Boolean),
    })
  }
  if (andConds.length > 0) where.AND = andConds
  if (status === 'Open' || status === 'Closed' || status === 'Cancelled') where.status = status
  if (from || to) {
    where.docDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
    }
  }

  // ---------- 1) Chứng từ SAP B1 live (WORKER C) ----------
  // Khi lọc nháp (isDraft) thì chỉ đọc local — SAP không có khái niệm nháp gộp ở đây
  let sapRows: SapDocRow[] = []
  let warning = ''
  let source: 'sap' | 'local' = 'local'
  if (isSapConfigured(s) && draftFilter === null) {
    const live = await fetchSapDocuments(cfg.entitySet, dbId)
    if (live.ok) {
      sapRows = live.rows
      source = 'sap'
    } else {
      // SAP lỗi → vẫn hiển thị chứng từ local, kèm cảnh báo
      warning = `Không truy vấn được SAP B1 (${live.error ?? 'lỗi không rõ'}) — đang hiển thị ${cfg.short} local`
    }
  }

  // ---------- 2) Chứng từ local (khử trùng với SAP theo DocEntry) ----------
  const localRows: any[] = await cfg.model.findMany({
    where,
    orderBy: { docNum: 'desc' },
    include: { lines: true },
  })
  const sapEntries = new Set(sapRows.map((r) => r.docEntry))
  const localOnly = localRows.filter(
    (o) => !(o.sapSyncStatus === 'synced' && o.sapDocEntry != null && sapEntries.has(o.sapDocEntry)),
  )

  // ---------- 3) Gộp + sắp xếp + phân trang trên máy chủ ----------
  // docNum null (nháp) xếp cuối — ?? 0 để sort không vỡ với null
  const merged = [
    ...sapRows.map((r) => ({ ...r, id: `sap-${r.docEntry}`, source: 'sap' as const })),
    ...localOnly.map((o) => ({ ...o, source: 'local' as const })),
  ].sort((a, b) => (b.docNum ?? 0) - (a.docNum ?? 0))

  const total = merged.length
  const data = merged.slice((page - 1) * pageSize, page * pageSize)

  return NextResponse.json({
    data,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    source,
    ...(warning ? { warning } : {}),
  })
  } catch (e) {
    console.error(`[salesDocList:${cfg.docType}]`, e)
    return NextResponse.json(
      { error: `Lỗi tải danh sách ${cfg.label.toLowerCase()}: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
}

// ==================== POST create ====================

/**
 * POST tạo chứng từ mới: cấp docNum từ dãy riêng (DocNumSequence),
 * tính totals qua @/lib/order-calc. Sau khi lưu local → đẩy SAP B1
 * (POST /{entitySet}) và cập nhật sapDocEntry/sapSyncStatus…
 */
// ==================== Đẩy SAP sau khi lưu local ====================

/**
 * Tải danh sách khấu trừ đặt cọc của hóa đơn để đẩy sang SAP
 * (DownPaymentsToDraw). Chỉ gồm các đặt cọc đã synced (có sapDocEntry) —
 * đặt cọc chưa lên SAP không thể tham chiếu DocEntry trên Service Layer.
 */
async function loadInvoiceDrawsForPush(
  invoiceId: string,
): Promise<Array<{ downPaymentDocEntry: number; drawAmount: number }>> {
  const draws = await prisma.downPaymentDraw.findMany({
    where: { invoiceId },
    include: { downPayment: { select: { sapDocEntry: true } } },
  })
  return draws
    .filter((d) => typeof d.downPayment?.sapDocEntry === 'number')
    .map((d) => ({
      downPaymentDocEntry: d.downPayment.sapDocEntry as number,
      drawAmount: Number(d.drawAmount),
    }))
}

/**
 * Đẩy chứng từ vừa lưu local sang SAP B1 (POST /{entitySet}), rồi cập nhật
 * sapDocEntry/sapDocNum/sapSyncStatus/sapSyncError/sapSyncedAt + sapLineNum
 * từng dòng (cần khi SỬA chứng từ). KHÔNG ném exception — lỗi đẩy chỉ ghi
 * vào sapSyncStatus='pending' để đẩy lại từ danh sách.
 * Trả về bản ghi đã làm mới + thông tin đẩy cho response API.
 */
async function pushSalesDocAfterCreate(
  cfg: SalesDocConfig,
  created: any,
  headerPct: number,
  docDbId: string | null,
): Promise<{ doc: any; sapStatus: string; sapError: string | null; sapDocNum: number | null }> {
  const push = await pushDocumentToSap({
    entitySet: cfg.entitySet,
    databaseId: docDbId,
    isDraft: created.isDraft === true,
    cardCode: created.cardCode,
    docDate: created.docDate.toISOString(),
    docDueDate: created.docDueDate.toISOString(),
    comments: created.remarks,
    headerDiscPct: headerPct,
    // Đợt 2+3 — Thông tin B2B / SAP B1 từ bản ghi DB → tầng payload
    // (sapDocHeaderExtras) chỉ gửi các trường có giá trị lên Service Layer
    salesPersonCode: created.salesPersonCode ?? null,
    paymentGroupCode: created.paymentGroupCode ?? null,
    shipToCode: created.shipToCode ?? null,
    billToCode: created.billToCode ?? null,
    contactPersonCode: created.contactPersonCode ?? null,
    numAtCard: created.numAtCard ?? null,
    taxDate: created.taxDate ?? null,
    docCurrency: created.docCurrency ?? null,
    docRate: created.docRate ?? null,
    projectCode: created.projectCode ?? null,
    // Phase 2: hóa đơn gửi thêm DocType/ReserveInvoice + DownPaymentsToDraw
    ...(cfg.docType === 'invoice'
      ? {
          invoiceDocType: (created.docType ?? 'Item') as 'Item' | 'Service' | 'Reserve',
          draws: await loadInvoiceDrawsForPush(created.id),
        }
      : {}),
    localId: created.id,
    lines: (created.lines as any[]).map((l) => ({
      itemCode: l.itemCode,
      ...bomLineFields(l),
      // Dòng hóa đơn dịch vụ: đẩy AccountCode thay vì ItemCode (chuẩn SAP B1)
      accountCode: l.accountCode ?? null,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct,
      uom: l.uom,
      taxCode: l.taxCode,
      warehouseCode: l.warehouseCode,
      // Đợt 2+3 — Số lô dòng trả hàng → DocumentLines.BatchNumbers
      batchNumber: l.batchNumber ?? null,
      // Copy-from: local id dòng nguồn → tầng push tra BaseType/BaseEntry/BaseLine
      sourceLineId: l.sourceLineId ?? null,
    })),
  })
  // Chỉ công nhận 'synced' khi SAP trả về DocEntry hợp lệ — thiếu DocEntry
  // thì giữ 'pending' để lần đẩy lại sau không bỏ qua SAP (tránh lệch lặng lẽ).
  const syncedOk = push.status === 'synced' && typeof push.docEntry === 'number'
  const finalStatus = !syncedOk && push.status === 'synced' ? 'pending' : push.status
  const finalError =
    !syncedOk && push.status === 'synced'
      ? 'SAP không trả về DocEntry — sẽ thử đẩy lại'
      : (push.error ?? null)
  const refreshed = await cfg.model.update({
    where: { id: created.id },
    data: {
      sapSyncStatus: finalStatus,
      sapSyncError: finalError,
      ...(syncedOk
        ? { sapDocEntry: push.docEntry, sapDocNum: push.docNum ?? null, sapSyncedAt: new Date() }
        : {}),
    },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  // Lưu LineNum do SAP cấp cho từng dòng — cần khi SỬA (PATCH)
  if (syncedOk && push.lineNums?.length) {
    const dbLines = [...refreshed.lines].sort((a: any, b: any) => a.lineNum - b.lineNum)
    await prisma.$transaction(
      dbLines.map((l: any, i: number) =>
        (prisma as any)[cfg.lineModelKey].update({
          where: { id: l.id },
          data: { sapLineNum: push.lineNums?.[i] ?? null },
        }),
      ),
    )
    const withLineNums = await cfg.model.findUnique({
      where: { id: created.id },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    return {
      doc: withLineNums ?? refreshed,
      sapStatus: finalStatus,
      sapError: finalError,
      sapDocNum: typeof push.docNum === 'number' ? push.docNum : null,
    }
  }
  return { doc: refreshed, sapStatus: finalStatus, sapError: finalError, sapDocNum: null }
}

/**
 * POST tạo chứng từ mới: cấp docNum từ dãy riêng (DocNumSequence),
 * tính totals qua @/lib/order-calc. Sau khi lưu local → đẩy SAP B1
 * (POST /{entitySet}) và cập nhật sapDocEntry/sapSyncStatus…
 *
 * Phase 2 — NHÁP: ?draft=true → lưu nháp (isDraft=true, docNum=null,
 * KHÔNG đẩy SAP). Chuyển chính thức bằng PATCH /[id]/finalize.
 * Hóa đơn: body.docType (Item|Service|Reserve), body.draws
 * [{downPaymentId, drawAmount}] — validate + trừ remainingAmount
 * trong cùng transaction.
 */
export async function salesDocCreate(req: NextRequest, cfg: SalesDocConfig) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.create) {
    return NextResponse.json({ error: `Bạn không có quyền tạo ${cfg.short}` }, { status: 403 })
  }

  try {
    const body = (await req.json()) as HeaderBody & Record<string, unknown>
    const { cardCode, cardName, docDate, docDueDate, remarks, warehouseCode, headerDiscPct, lines } = body

    if (!cardCode || !cardName) {
      return NextResponse.json({ error: 'Vui lòng chọn khách hàng (CardCode)' }, { status: 400 })
    }
    if (!docDate || !docDueDate) {
      return NextResponse.json({ error: 'Vui lòng chọn ngày chứng từ và ngày hết hạn' }, { status: 400 })
    }

    const { lines: validLines, error: linesError } = validateOrderLines(lines)
    if (linesError) {
      return NextResponse.json({ error: linesError }, { status: 400 })
    }
    // BOM: con phải thuộc công thức của cha; Production/Assembly khóa SL theo công thức
    const { error: bomError } = await normalizeBomLines(user.databaseId ?? null, validLines as any[])
    if (bomError) {
      return NextResponse.json({ error: bomError }, { status: 400 })
    }
    // Hóa đơn dịch vụ: mọi dòng phải có mã tài khoản (SAP: AccountCode) —
    // validate TRƯỚC khi cấp docNum để lỗi của user không đốt số chứng từ
    if (cfg.docType === 'invoice') {
      const effDocType = validInvoiceDocType((body as any).docType) ?? 'Item'
      const acctErr = validateServiceLineAccounts(effDocType, validLines)
      if (acctErr) {
        return NextResponse.json({ error: acctErr }, { status: 400 })
      }
    }

    const headerPct = Math.min(100, Math.max(0, Number(headerDiscPct) || 0))
    const calcLines = calcOrderLines(validLines, headerPct)
    const { totalBeforeDisc, discountAmt, headerDiscAmt, vatAmt, grandTotal } = orderTotals(calcLines)

    const s = await loadSapSettings(user.databaseId)
    const docDbId = s?.dbId ?? null
    // Phase 2: hóa đơn có draws → validate TRƯỚC khi cấp docNum
    // (lỗi validate của user không đốt số chứng từ)
    const useDraws = Boolean(cfg.hooks?.validateDraws) && body.draws !== undefined
    let parsedDraws: ParsedDraw[] = []
    if (useDraws) {
      try {
        parsedDraws = await cfg.hooks!.validateDraws!(prisma, body.draws, cardCode, grandTotal)
      } catch (e) {
        if (e instanceof SalesDocError) {
          return NextResponse.json({ error: e.message }, { status: e.status })
        }
        throw e
      }
    }
    // Phase 2: nháp → chưa cấp số thật (docNum=null), không đẩy SAP
    const isDraft = req.nextUrl.searchParams.get('draft') === 'true'
    const docNum = isDraft ? null : await nextDocNum(cfg.docType)

    // FK chứng từ nguồn (khi tạo trực tiếp từ 1 chứng từ nguồn)
    const sourceData: Record<string, string> = {}
    for (const fk of cfg.sourceFks) {
      const v = body[fk]
      if (typeof v === 'string' && v.trim()) sourceData[fk] = v.trim()
    }

    const extraFields = cfg.hooks?.extraCreateFields?.({ grandTotal, body }) ?? {}
    // Đợt 2 — Thông tin B2B / SAP B1 (taxDate mặc định = ngày chứng từ)
    const b2b = parseB2bHeader(body as Record<string, unknown>, new Date(docDate))
    // Đợt 2 — trạng thái thanh toán (hóa đơn / ghi có / đặt cọc)
    const paymentFields: Record<string, unknown> = cfg.supportsPayment
      ? (() => {
          const paid = Math.max(0, Number(body.paidAmount) || 0)
          return { paidAmount: paid, paymentStatus: derivePaymentStatus(paid, grandTotal) }
        })()
      : {}
    const createData = {
      docNum,
      isDraft,
      cardCode,
      cardName,
      docDate: new Date(docDate),
      docDueDate: new Date(docDueDate),
      remarks: remarks?.trim() || null,
      warehouseCode: warehouseCode?.trim() || null,
      totalBeforeDisc,
      discountAmt,
      headerDiscPct: headerPct,
      headerDiscAmt,
      vatAmt,
      grandTotal,
      createdBy: user.username,
      sapDatabaseId: docDbId,
      ...extraFields,
      ...b2b,
      ...paymentFields,
      ...sourceData,
      lines: { create: calcLines.map((l, i) => lineCreateData(l, i, cfg.lineBatchNumber === true)) },
    }
    const includeLines = { lines: { orderBy: { lineNum: 'asc' } } } as const

    // Hóa đơn có draws → ghi trong transaction để trừ remainingAmount
    // nguyên tử cùng lúc tạo chứng từ (đã validate ở trên)
    const created: any = useDraws
      ? await prisma.$transaction(async (tx: any) => {
          const doc = await tx[cfg.modelKey].create({ data: createData, include: includeLines })
          await cfg.hooks!.writeDraws!(tx, doc.id, parsedDraws)
          return doc
        })
      : await cfg.model.create({ data: createData, include: includeLines })

    // ---- Nháp: chỉ lưu local, không cấp số, không đẩy SAP ----
    if (isDraft) {
      return NextResponse.json(
        {
          ok: true,
          [cfg.resultKey]: created,
          isDraft: true,
          sapStatus: 'none',
          sapError: null,
          sapDocNum: null,
        },
        { status: 201 },
      )
    }
    // ---- Đẩy chứng từ sang SAP B1 (POST /{entitySet}). Luôn lưu local trước,
    // thất bại thì đánh dấu 'pending' để đẩy lại từ danh sách ----
    const pushed = await pushSalesDocAfterCreate(cfg, created, headerPct, docDbId)
    return NextResponse.json(
      {
        ok: true,
        [cfg.resultKey]: pushed.doc,
        sapStatus: pushed.sapStatus,
        sapError: pushed.sapError,
        sapDocNum: pushed.sapDocNum,
      },
      { status: 201 },
    )
  } catch (e) {
    console.error(`POST /api sales-ar ${cfg.docType}`, e)
    return NextResponse.json({ error: `Không thể tạo ${cfg.short}` }, { status: 500 })
  }
}

// ==================== GET detail ====================

/**
 * GET chi tiết 1 chứng từ local (kèm lines).
 * Chứng từ SAP live (id 'sap-<DocEntry>'): chi tiết Service Layer do
 * WORKER C bổ sung ở bước tích hợp — hiện tại báo rõ chưa hỗ trợ.
 */
export async function salesDocDetail(req: NextRequest, id: string, cfg: SalesDocConfig) {
  try {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.view) {
    return NextResponse.json({ error: `Bạn không có quyền xem ${cfg.short}` }, { status: 403 })
  }

  if (id.startsWith('sap-')) {
    return NextResponse.json(
      { error: `Chưa hỗ trợ xem chi tiết ${cfg.short} từ SAP B1 — sẽ bổ sung ở bước tích hợp Service Layer` },
      { status: 400 },
    )
  }

  const doc = await cfg.model.findUnique({
    where: { id },
    include: {
      lines: { orderBy: { lineNum: 'asc' } },
      // Phase 2: hóa đơn — kèm chi tiết khấu trừ đặt cọc (để UI chi tiết hiển thị)
      ...(cfg.docType === 'invoice'
        ? {
            draws: {
              include: {
                downPayment: { select: { id: true, docNum: true, cardCode: true, cardName: true } },
              },
            },
          }
        : {}),
    },
  })
  if (!doc) return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })
  // B1: cách ly DB — không cho xem chứng từ của database khác
  if (user.databaseId && doc.sapDatabaseId && doc.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })
  }
  return NextResponse.json({ ok: true, [cfg.resultKey]: doc })
  } catch (e) {
    console.error(`[salesDocDetail:${cfg.docType}]`, e)
    return NextResponse.json(
      { error: `Lỗi tải chi tiết ${cfg.short}: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    )
  }
}

// ==================== PATCH update ====================

/**
 * PATCH: 2 chế độ trong 1 endpoint (đều yêu cầu optimistic locking version)
 * - Đóng/mở/hủy nhanh: body { status: 'Open'|'Closed'|'Cancelled', version }
 * - Sửa toàn bộ: body { ..., lines, version } — chỉ khi đang Open.
 *   Nếu chứng từ đã synced lên SAP → PATCH /{entitySet}(DocEntry) sau khi lưu local.
 */
export async function salesDocUpdate(req: NextRequest, id: string, cfg: SalesDocConfig) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.edit) {
    return NextResponse.json({ error: `Bạn không có quyền sửa ${cfg.short}` }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as (HeaderBody & { status?: string; version?: number; draws?: unknown }) | null
  const status = body?.status
  const version = body?.version

  const doc = await cfg.model.findUnique({ where: { id } })
  if (!doc) return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })
  if (user.databaseId && doc.sapDatabaseId && doc.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })
  }
  // Optimistic locking: client BẮT BUỘC gửi đúng version đã đọc khi mở form
  if (typeof version !== 'number') {
    return NextResponse.json(
      { error: 'Thiếu version — vui lòng tải lại chứng từ', code: 'VERSION_REQUIRED' },
      { status: 400 },
    )
  }
  if (version !== doc.version) {
    return NextResponse.json(
      { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại chứng từ', code: 'VERSION_CONFLICT' },
      { status: 409 },
    )
  }

  // ---------- Chế độ 1: đóng/mở/hủy nhanh ----------
  if (status !== undefined && body?.lines === undefined) {
    if (status !== 'Open' && status !== 'Closed' && status !== 'Cancelled') {
      return NextResponse.json({ error: 'Trạng thái không hợp lệ' }, { status: 400 })
    }
    const updated = await cfg.model.update({
      where: { id },
      data: { status, version: { increment: 1 } },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    return NextResponse.json({ ok: true, [cfg.resultKey]: updated })
  }

  // ---------- Chế độ 2: sửa toàn bộ (chỉ khi đang Open) ----------
  if (doc.status !== 'Open') {
    return NextResponse.json({ error: `Chỉ có thể sửa ${cfg.short} đang ở trạng thái Open` }, { status: 400 })
  }
  const { cardCode, cardName, docDate, docDueDate, remarks, warehouseCode, headerDiscPct, lines } = body ?? {}
  if (!cardCode || !cardName) {
    return NextResponse.json({ error: 'Vui lòng chọn khách hàng (CardCode)' }, { status: 400 })
  }
  if (!docDate || !docDueDate) {
    return NextResponse.json({ error: 'Vui lòng chọn ngày chứng từ và ngày hết hạn' }, { status: 400 })
  }
  const { lines: validLines, error: linesError } = validateOrderLines(lines)
  if (linesError) {
    return NextResponse.json({ error: linesError }, { status: 400 })
  }
  // BOM: con phải thuộc công thức của cha; Production/Assembly khóa SL theo công thức
  const { error: bomError } = await normalizeBomLines((doc as any).sapDatabaseId ?? user.databaseId ?? null, validLines as any[])
  if (bomError) {
    return NextResponse.json({ error: bomError }, { status: 400 })
  }
  // Hóa đơn dịch vụ: mọi dòng phải có mã tài khoản (SAP: AccountCode)
  let effInvoiceDocType: 'Item' | 'Service' | 'Reserve' = 'Item'
  if (cfg.docType === 'invoice') {
    effInvoiceDocType = validInvoiceDocType((body as any)?.docType) ?? ((doc as any).docType ?? 'Item')
    const acctErr = validateServiceLineAccounts(effInvoiceDocType, validLines)
    if (acctErr) {
      return NextResponse.json({ error: acctErr }, { status: 400 })
    }
  }

  const headerPct = Math.min(100, Math.max(0, Number(headerDiscPct) || 0))
  const calcLines = calcOrderLines(validLines, headerPct)
  const { totalBeforeDisc, discountAmt, headerDiscAmt, vatAmt, grandTotal } = orderTotals(calcLines)

  // Giữ map LineNum do SAP cấp của các dòng cũ (bị xóa ở transaction dưới) —
  // cần để PATCH đúng dòng trên SAP.
  const curLines: any[] = await (prisma as any)[cfg.lineModelKey].findMany({
    where: { [cfg.lineFk]: id },
    orderBy: { lineNum: 'asc' },
  })
  const oldLineNums = new Map<number, number>()
  for (const l of curLines) {
    if (typeof l.sapLineNum === 'number') oldLineNums.set(l.lineNum, l.sapLineNum)
  }

  let updated: any
  try {
    updated = await prisma.$transaction(async (tx: any) => {
      await tx[cfg.lineModelKey].deleteMany({ where: { [cfg.lineFk]: id } })
      // Phase 2: trường header bổ sung theo loại chứng từ (vd docType hóa đơn)
      const extraUpdateFields = cfg.hooks?.extraUpdateFields?.(body ?? {}) ?? {}
      // Đợt 2 — Thông tin B2B / SAP B1 (taxDate mặc định = ngày chứng từ)
      const b2b = parseB2bHeader(body as Record<string, unknown>, new Date(docDate))
      // Đợt 2 — tầng thanh toán ghi paidAmount qua update → suy lại paymentStatus
      const paymentFields: Record<string, unknown> = {}
      if (cfg.supportsPayment && body?.paidAmount !== undefined) {
        const paid = Math.max(0, Number(body.paidAmount) || 0)
        paymentFields.paidAmount = paid
        paymentFields.paymentStatus = derivePaymentStatus(paid, grandTotal)
      }
      const doc = await tx[cfg.modelKey].update({
        where: { id },
        data: {
          cardCode,
          cardName,
          docDate: new Date(docDate),
          docDueDate: new Date(docDueDate),
          remarks: remarks?.trim() || null,
          warehouseCode: warehouseCode?.trim() || null,
          totalBeforeDisc,
          discountAmt,
          headerDiscPct: headerPct,
          headerDiscAmt,
          vatAmt,
          grandTotal,
          version: { increment: 1 },
          ...extraUpdateFields,
          ...b2b,
          ...paymentFields,
          lines: { create: calcLines.map((l, i) => lineCreateData(l, i, cfg.lineBatchNumber === true)) },
        },
        include: { lines: { orderBy: { lineNum: 'asc' } } },
      })
      // Phase 2: hóa đơn — body có key draws (kể cả []) → thay toàn bộ khấu trừ;
      // đặt cọc — tính lại remainingAmount theo tổng mới
      if (cfg.hooks?.validateDraws && body?.draws !== undefined) {
        await cfg.hooks.releaseDraws!(tx, id)
        const parsed = await cfg.hooks.validateDraws(tx, body.draws, cardCode, grandTotal)
        await cfg.hooks.writeDraws!(tx, id, parsed)
      }
      if (cfg.hooks?.afterFullUpdate) {
        await cfg.hooks.afterFullUpdate(tx, id, grandTotal)
      }
      return doc
    })
  } catch (e) {
    if (e instanceof SalesDocError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    throw e
  }

  // ---- Đẩy sửa sang SAP B1 (PATCH /{entitySet}(DocEntry)) nếu chứng từ đã synced ----
  let sapWarning: string | null = null
  if (doc.sapSyncStatus === 'synced' && typeof doc.sapDocEntry === 'number') {
    const s = await loadSapSettings(doc.sapDatabaseId)
    if (isSapConfigured(s)) {
      const newLines = [...updated.lines].sort((a: any, b: any) => a.lineNum - b.lineNum)
      const res = await patchDocumentToSap(s, {
        entitySet: cfg.entitySet,
        docEntry: doc.sapDocEntry,
        cardCode,
        docDate,
        docDueDate,
        comments: remarks ?? null,
        headerDiscPct: headerPct,
        // Địa chỉ giao/ghi hóa đơn + người liên hệ đã lưu → cập nhật lên SAP
        shipToCode: updated.shipToCode ?? null,
        billToCode: updated.billToCode ?? null,
        contactPersonCode: updated.contactPersonCode ?? null,
        lines: newLines.map((l: any) => ({
          // Dòng đã tồn tại trên SAP kèm LineNum cũ; dòng mới → null = thêm mới;
          // dòng bị bỏ khỏi danh sách sẽ bị XÓA (B1S-ReplaceCollectionsOnPatch)
          lineNum: oldLineNums.get(l.lineNum) ?? null,
          itemCode: l.itemCode,
          ...bomLineFields(l),
          // Dòng hóa đơn dịch vụ: đẩy AccountCode thay vì ItemCode (chuẩn SAP B1)
          accountCode: l.accountCode ?? null,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discPct: l.discPct,
          uom: l.uom,
          taxCode: l.taxCode,
          warehouseCode: l.warehouseCode,
        })),
        // Hóa đơn: báo loại chứng từ để tầng push chọn AccountCode/ItemCode cho dòng
        ...(cfg.docType === 'invoice' ? { invoiceDocType: effInvoiceDocType } : {}),
      })
      if (res.status === 'synced') {
        await cfg.model.update({
          where: { id },
          data: {
            sapSyncStatus: 'synced',
            sapSyncError: null,
            sapSyncedAt: new Date(),
            ...(typeof res.docNum === 'number' ? { sapDocNum: res.docNum } : {}),
          },
        })
        if (res.lineNums?.length) {
          await prisma.$transaction(
            newLines.map((l: any, i: number) =>
              (prisma as any)[cfg.lineModelKey].update({
                where: { id: l.id },
                data: { sapLineNum: res.lineNums?.[i] ?? null },
              }),
            ),
          )
        }
      } else {
        // PATCH bị SL từ chối — local đã lưu, ghi lỗi để user thấy và xử lý tay
        sapWarning = res.error ?? 'lỗi không rõ'
        await cfg.model.update({
          where: { id },
          data: { sapSyncError: `Sửa trên SAP B1 thất bại: ${sapWarning}` },
        })
      }
    }
  }
  return NextResponse.json({
    ok: true,
    [cfg.resultKey]: updated,
    ...(sapWarning ? { sapWarning } : {}),
  })
}

// ==================== DELETE ====================

/**
 * DELETE: không xóa chứng từ đã/đang đồng bộ SAP hoặc đã đóng —
 * tránh lệch dữ liệu giữa 2 hệ thống (giống rule của đơn hàng).
 */
export async function salesDocDelete(req: NextRequest, id: string, cfg: SalesDocConfig) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.delete) {
    return NextResponse.json({ error: `Bạn không có quyền xóa ${cfg.short}` }, { status: 403 })
  }

  try {
    const existing = await cfg.model.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: `Không tìm thấy ${cfg.short} cần xóa` }, { status: 404 })
    }
    if (user.databaseId && existing.sapDatabaseId && existing.sapDatabaseId !== user.databaseId) {
      return NextResponse.json({ error: `Không tìm thấy ${cfg.short} cần xóa` }, { status: 404 })
    }
    if (existing.sapSyncStatus === 'synced' || existing.sapSyncStatus === 'pending') {
      return NextResponse.json(
        { error: `Không thể xóa ${cfg.short} đã/đang đồng bộ SAP B1. Hãy xử lý chứng từ trên SAP trước.` },
        { status: 400 },
      )
    }
    if (existing.status === 'Closed') {
      return NextResponse.json(
        { error: `Không thể xóa ${cfg.short} đã đóng (Closed). Hãy mở lại trước khi xóa.` },
        { status: 400 },
      )
    }
    // Phase 2: chặn xóa theo rule loại chứng từ (vd đặt cọc đã bị khấu trừ)
    if (cfg.hooks?.checkDelete) {
      const blockMsg = await cfg.hooks.checkDelete(id)
      if (blockMsg) {
        return NextResponse.json({ error: blockMsg }, { status: 400 })
      }
    }
    // Phase 2: xóa hóa đơn có draws → hoàn lại remainingAmount cho các đặt cọc
    // trong cùng transaction với xóa chứng từ
    if (cfg.hooks?.releaseDraws) {
      await prisma.$transaction(async (tx: any) => {
        await cfg.hooks!.releaseDraws!(tx, id)
        await tx[cfg.modelKey].delete({ where: { id } })
      })
    } else {
      await cfg.model.delete({ where: { id } })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: `Không tìm thấy ${cfg.short} cần xóa` }, { status: 404 })
  }
}

// ==================== PATCH [id]/finalize ====================

/**
 * Phase 2 — Chuyển NHÁP thành chứng từ chính thức:
 * set isDraft=false + cấp docNum thật từ dãy riêng (DocNumSequence)
 * + đẩy SAP B1 (POST /{entitySet}) như khi tạo mới.
 * Yêu cầu optimistic locking (version) như PATCH sửa.
 * Route: PATCH /api/<docs>/:id/finalize — body { version }.
 */
export async function salesDocFinalize(req: NextRequest, id: string, cfg: SalesDocConfig) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[cfg.permModule]?.edit) {
    return NextResponse.json({ error: `Bạn không có quyền duyệt ${cfg.short}` }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as { version?: number } | null
  const version = body?.version

  const doc: any = await cfg.model.findUnique({
    where: { id },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })
  if (!doc) return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })
  // B1: cách ly DB
  if (user.databaseId && doc.sapDatabaseId && doc.sapDatabaseId !== user.databaseId) {
    return NextResponse.json({ error: `Không tìm thấy ${cfg.short}` }, { status: 404 })
  }
  if (typeof version !== 'number') {
    return NextResponse.json(
      { error: 'Thiếu version — vui lòng tải lại chứng từ', code: 'VERSION_REQUIRED' },
      { status: 400 },
    )
  }
  if (version !== doc.version) {
    return NextResponse.json(
      { error: 'Dữ liệu đã bị thay đổi bởi người khác — vui lòng tải lại chứng từ', code: 'VERSION_CONFLICT' },
      { status: 409 },
    )
  }
  if (!doc.isDraft) {
    return NextResponse.json({ error: `Chứng từ này không phải nháp — đã có số ${doc.docNum ?? ''}` }, { status: 400 })
  }
  if (doc.status !== 'Open') {
    return NextResponse.json({ error: `Chỉ có thể duyệt nháp đang ở trạng thái Open` }, { status: 400 })
  }
  if (!Array.isArray(doc.lines) || doc.lines.length === 0) {
    return NextResponse.json({ error: 'Nháp không có dòng hàng nào — không thể duyệt' }, { status: 400 })
  }

  // Cấp số thật từ dãy riêng + chuyển chính thức (1 transaction)
  const docNum = await nextDocNum(cfg.docType)
  const headerPct = Math.min(100, Math.max(0, Number(doc.headerDiscPct) || 0))
  const finalized = await cfg.model.update({
    where: { id },
    data: { isDraft: false, docNum, version: { increment: 1 } },
    include: { lines: { orderBy: { lineNum: 'asc' } } },
  })

  // ---- Đẩy chứng từ sang SAP B1 (POST /{entitySet}) như khi tạo mới ----
  const pushed = await pushSalesDocAfterCreate(cfg, finalized, headerPct, doc.sapDatabaseId ?? null)
  return NextResponse.json({
    ok: true,
    [cfg.resultKey]: pushed.doc,
    sapStatus: pushed.sapStatus,
    sapError: pushed.sapError,
    sapDocNum: pushed.sapDocNum,
  })
}

// ==================== POST from-source ====================

/** Mô tả 1 loại chứng từ nguồn cho copy-to */
export interface SourceSpec {
  sourceType: 'quotation' | 'order' | 'delivery' | 'invoice' | 'return'
  /** Prisma delegate của chứng từ nguồn */
  model: any
  /** FK trên chứng từ đích: 'sourceQuotationId' | ... */
  fkField: string
  /** Tên tiếng Việt: 'báo giá bán hàng' */
  label: string
}

export const SOURCE_QUOTATION: SourceSpec = {
  sourceType: 'quotation',
  model: prisma.quotation,
  fkField: 'sourceQuotationId',
  label: 'báo giá bán hàng',
}
export const SOURCE_ORDER: SourceSpec = {
  sourceType: 'order',
  model: prisma.salesOrder,
  fkField: 'sourceOrderId',
  label: 'đơn hàng bán',
}
export const SOURCE_DELIVERY: SourceSpec = {
  sourceType: 'delivery',
  model: prisma.delivery,
  fkField: 'sourceDeliveryId',
  label: 'phiếu giao hàng',
}
export const SOURCE_INVOICE: SourceSpec = {
  sourceType: 'invoice',
  model: prisma.arInvoice,
  fkField: 'sourceInvoiceId',
  label: 'hóa đơn bán hàng',
}
export const SOURCE_RETURN: SourceSpec = {
  sourceType: 'return',
  model: prisma.salesReturn,
  fkField: 'sourceReturnId',
  label: 'phiếu trả hàng bán',
}

/**
 * POST tạo chứng từ mới bằng cách sao chép từ chứng từ nguồn
 * (copy-to chuẩn SAP B1). Copy toàn bộ dòng (giữ giá/CK/thuế/kho +
 * cấu trúc BOM), gắn sourceLineId từng dòng (= BaseLine) và FK nguồn
 * (= BaseEntry). Giữ chiết khấu đầu chứng từ của nguồn.
 * Ngày chứng từ mới = hôm nay; giữ nguyên khoảng cách tới hạn của nguồn.
 * Chống bấm đúp: order lock + dedupeRequest (giống from-order).
 *
 * ?prefill=1 — chế độ "Sao chép từ": KHÔNG tạo chứng từ, chỉ trả về JSON
 * { ok: true, prefill: {...} } — dữ liệu đã validate/tính toán sẵn để form
 * tạo mới điền vào. Dùng bởi CopyFromPicker trên các form tạo chứng từ.
 */
export async function salesDocFromSource(req: NextRequest, target: SalesDocConfig, sources: SourceSpec[]) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions[target.permModule]?.create) {
    return NextResponse.json({ error: `Bạn không có quyền tạo ${target.short}` }, { status: 403 })
  }
  const rl = rateLimit(`${target.docType}:from-source:${user.id}`, 20, 5 * 60 * 1000)
  if (!rl.ok) {
    return NextResponse.json({ error: 'Thao tác quá nhanh — vui lòng thử lại sau' }, { status: 429 })
  }

  const body = (await req.json().catch(() => null)) as { sourceType?: unknown; sourceId?: unknown } | null
  const sourceType = String(body?.sourceType ?? '')
  const sourceId = String(body?.sourceId ?? '').trim()
  const spec = sources.find((s) => s.sourceType === sourceType)
  if (!spec || !sourceId) {
    return NextResponse.json({ error: 'Loại chứng từ nguồn không hợp lệ' }, { status: 400 })
  }

  const run = async (): Promise<{ body: unknown; status: number }> => {
    // Phase 2: ?draft=true → tạo bản nháp (chưa cấp số, không đẩy SAP)
    const isDraftCopy = req.nextUrl.searchParams.get('draft') === 'true'
    const src: any = await spec.model.findUnique({
      where: { id: sourceId },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    if (!src) {
      return { body: { error: `Không tìm thấy ${spec.label}` }, status: 404 }
    }
    // B1: cách ly DB
    if (user.databaseId && src.sapDatabaseId && src.sapDatabaseId !== user.databaseId) {
      return { body: { error: `Không tìm thấy ${spec.label}` }, status: 404 }
    }
    if (src.status === 'Cancelled') {
      return { body: { error: `Không thể tạo ${target.short} từ ${spec.label} đã hủy` }, status: 400 }
    }
    // Phase 2: không sao chép từ chứng từ đang là nháp — phải finalize nguồn trước
    if (src.isDraft === true) {
      return {
        body: { error: `Không thể tạo ${target.short} từ ${spec.label} đang là nháp — hãy duyệt nháp thành chính thức trước` },
        status: 400,
      }
    }
    if (!Array.isArray(src.lines) || src.lines.length === 0) {
      return { body: { error: `${spec.label} không có dòng hàng nào để sao chép` }, status: 400 }
    }

    const inputLines: SalesDocLineInput[] = src.lines.map((l: any) => ({
      itemCode: l.itemCode,
      itemName: l.itemName,
      uom: l.uom ?? '',
      warehouseCode: l.warehouseCode ?? undefined,
      taxCode: l.taxCode ?? undefined,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discPct: l.discPct ?? 0,
      vatPct: l.vatPct ?? 8,
      isBomChild: l.isBomChild ?? false,
      bomGroupKey: l.bomGroupKey ?? null,
      bomEditable: l.bomEditable ?? true,
      bomQtyPerParent: l.bomQtyPerParent ?? null,
      sourceLineId: l.id,
      // Giữ mã tài khoản khi sao chép sang hóa đơn (ArInvoiceLine mới có cột này)
      ...(target.docType === 'invoice' ? { accountCode: l.accountCode ?? null } : {}),
      // Đợt 2 — giữ Số lô khi sao chép sang phiếu trả hàng
      ...(target.lineBatchNumber ? { batchNumber: l.batchNumber ?? null } : {}),
    }))
    const { lines: validLines, error: linesError } = validateOrderLines(inputLines)
    if (linesError) {
      return { body: { error: linesError }, status: 400 }
    }

    const headerPct = Math.min(100, Math.max(0, Number(src.headerDiscPct) || 0))
    const calcLines = calcOrderLines(validLines, headerPct)
    const { totalBeforeDisc, discountAmt, headerDiscAmt, vatAmt, grandTotal } = orderTotals(calcLines)

    // ---- ?prefill=1: chế độ "Sao chép từ" — KHÔNG tạo chứng từ, chỉ trả
    // dữ liệu đã validate/tính toán để form điền vào (CopyFromPicker) ----
    if (req.nextUrl.searchParams.get('prefill') === '1') {
      const now0 = new Date()
      const spanMs0 = Math.max(0, new Date(src.docDueDate).getTime() - new Date(src.docDate).getTime())
      const rawLines = calcLines as unknown as Array<Record<string, unknown>>
      return {
        body: {
          ok: true,
          prefill: {
            cardCode: src.cardCode,
            cardName: src.cardName,
            docDate: now0.toISOString(),
            docDueDate: new Date(now0.getTime() + spanMs0).toISOString(),
            remarks: `Sao chép từ ${spec.label} #${src.docNum}`,
            headerDiscPct: headerPct,
            warehouseCode: src.warehouseCode ?? null,
            // Đợt 2 — Thông tin B2B / SAP B1 mang theo từ nguồn
            // (taxDate: form mặc định = ngày chứng từ mới → không mang theo)
            salesPersonCode: src.salesPersonCode ?? null,
            paymentGroupCode: src.paymentGroupCode ?? null,
            shipToCode: src.shipToCode ?? null,
            billToCode: src.billToCode ?? null,
            contactPersonCode: src.contactPersonCode ?? null,
            numAtCard: src.numAtCard ?? null,
            docCurrency: src.docCurrency ?? 'VND',
            docRate: src.docRate ?? 1,
            projectCode: src.projectCode ?? null,
            attachmentsJson: src.attachmentsJson ?? null,
            lines: rawLines.map((l) => ({
              itemCode: l.itemCode,
              itemName: l.itemName,
              uom: l.uom ?? '',
              warehouseCode: l.warehouseCode ?? null,
              taxCode: l.taxCode ?? null,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              discPct: l.discPct ?? 0,
              vatPct: l.vatPct ?? 8,
              isBomChild: l.isBomChild ?? false,
              bomGroupKey: l.bomGroupKey ?? null,
              bomEditable: l.bomEditable ?? true,
              bomQtyPerParent: l.bomQtyPerParent ?? null,
              sourceLineId: l.sourceLineId ?? null,
              // Giữ mã tài khoản khi "Sao chép từ" sang hóa đơn (prefill cho form)
              ...(target.docType === 'invoice' ? { accountCode: (l as any).accountCode ?? null } : {}),
              // Đợt 2 — giữ Số lô khi "Sao chép từ" sang phiếu trả hàng
              ...(target.lineBatchNumber ? { batchNumber: (l as any).batchNumber ?? null } : {}),
            })),
            sourceType: spec.sourceType,
            sourceId: src.id,
            sourceDocNum: src.docNum ?? null,
            sourceLabel: spec.label,
          },
        },
        status: 200,
      }
    }

    const docNum = isDraftCopy ? null : await nextDocNum(target.docType)
    const now = new Date()
    const spanMs = Math.max(0, new Date(src.docDueDate).getTime() - new Date(src.docDate).getTime())
    const extraFields = target.hooks?.extraCreateFields?.({ grandTotal, body: {} }) ?? {}
    // Đợt 2 — mang theo Thông tin B2B của chứng từ nguồn (taxDate: lấy của
    // nguồn, thiếu thì mặc định = ngày chứng từ mới)
    const srcB2b = parseB2bHeader(
      {
        salesPersonCode: src.salesPersonCode,
        paymentGroupCode: src.paymentGroupCode,
        shipToCode: src.shipToCode,
        billToCode: src.billToCode,
        contactPersonCode: src.contactPersonCode,
        numAtCard: src.numAtCard,
        taxDate: src.taxDate ? new Date(src.taxDate).toISOString().slice(0, 10) : undefined,
        docCurrency: src.docCurrency,
        docRate: src.docRate,
        projectCode: src.projectCode,
        attachmentsJson: src.attachmentsJson,
      },
      now,
    )

    const created = await target.model.create({
      data: {
        docNum,
        isDraft: isDraftCopy,
        cardCode: src.cardCode,
        cardName: src.cardName,
        docDate: now,
        docDueDate: new Date(now.getTime() + spanMs),
        remarks: `Sao chép từ ${spec.label} #${src.docNum}`,
        warehouseCode: src.warehouseCode ?? null,
        totalBeforeDisc,
        discountAmt,
        headerDiscPct: headerPct,
        headerDiscAmt,
        vatAmt,
        grandTotal,
        createdBy: user.username,
        sapDatabaseId: src.sapDatabaseId ?? null,
        ...extraFields,
        ...srcB2b,
        // Đợt 2 — chứng từ mới chưa có thanh toán: khởi tạo paidAmount=0/unpaid
        // cho các loại hỗ trợ thanh toán (hóa đơn / ghi có / đặt cọc)
        ...(target.supportsPayment ? { paidAmount: 0, paymentStatus: 'unpaid' } : {}),
        [spec.fkField]: src.id,
        lines: { create: calcLines.map((l, i) => lineCreateData(l, i, target.lineBatchNumber === true)) },
      },
      include: { lines: { orderBy: { lineNum: 'asc' } } },
    })
    // Phase 2: copy thành nháp → chỉ lưu local, không đẩy SAP
    if (isDraftCopy) {
      return {
        body: { ok: true, [target.resultKey]: created, isDraft: true, sapStatus: 'none', sapError: null, sapDocNum: null },
        status: 201,
      }
    }
    // ---- Đẩy chứng từ sang SAP B1 (POST /{entitySet}) sau khi lưu local ----
    const pushed = await pushSalesDocAfterCreate(
      target,
      created,
      headerPct,
      src.sapDatabaseId ?? null,
    )
    return {
      body: {
        ok: true,
        [target.resultKey]: pushed.doc,
        sapStatus: pushed.sapStatus,
        sapError: pushed.sapError,
        sapDocNum: pushed.sapDocNum,
      },
      status: 201,
    }
  }

  // Chế độ ?prefill=1 ("Sao chép từ") là chỉ-đọc: gọi run() trực tiếp,
  // không khóa và không dedupe (dedupe cache có thể trả nhầm kết quả
  // tạo-ngay của cùng nguồn trong 30s trước đó).
  if (req.nextUrl.searchParams.get('prefill') === '1') {
    const result = await run()
    return NextResponse.json(result.body, { status: result.status })
  }

  // Lock per-source: 2 request cùng nguồn không chạy song song
  const lockKey = `${target.docType}:from:${sourceType}:${sourceId}`
  if (!acquireOrderLock(lockKey)) {
    return NextResponse.json(
      { error: `Chứng từ này đang được tạo ${target.short} ở một phiên khác — vui lòng đợi` },
      { status: 409 },
    )
  }
  try {
    // Chống bấm đúp: 2 request giống nhau trong 30s chỉ tạo 1 chứng từ
    const dedupeKey = `${target.docType}:from-source:${user.id}:${sourceType}:${sourceId}`
    const { result, replayed } = await dedupeRequest(dedupeKey, run)
    return NextResponse.json(result.body, { status: replayed ? 200 : result.status })
  } finally {
    releaseOrderLock(lockKey)
  }
}
