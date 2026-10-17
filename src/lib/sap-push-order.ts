// ============================================================
// ĐẨY SALE ORDER SANG SAP B1 (POST /Orders → bảng ORDR/RDR1)
// Quy tắc: 
//  - Chưa cấu hình Service Layer → status 'none' (đơn chỉ lưu local)
//  - Đẩy thành công → 'synced' + lưu DocEntry/DocNum do SAP cấp
//  - Đẩy thất bại  → 'pending' + lưu thông báo lỗi (đơn vẫn lưu local,
//                     có thể bấm "Đẩy lại" trong danh sách đơn hàng)
// ============================================================
// LƯU Ý: Logic dùng chung đã tách sang './sap-push-document'.
// File này chỉ là lớp tương thích — giữ nguyên mọi export cũ để không
// vỡ code đang dùng (routes, sap-push-delivery…).
// ============================================================

import type { SapConfig } from './sap-service-layer'
import {
  pushDocumentToSap,
  patchDocumentToSap,
  buildSapDocPayload,
  UDF_LOCAL_ID,
  type SapPushLine,
  type SapPushInput,
  type SapPushResult,
  type SapPatchInput,
} from './sap-push-document'

// Giữ nguyên mọi export cũ (re-export)
export { UDF_LOCAL_ID }
export type { SapPushLine, SapPushInput, SapPushResult, SapPatchInput }

/** Dựng payload POST /Orders theo cấu trúc Document SAP B1 (OData v2) */
export function buildSapOrderPayload(input: SapPushInput, withUdf = false) {
  return buildSapDocPayload(input, withUdf)
}

/**
 * Đẩy đơn hàng sang SAP B1. KHÔNG bao giờ ném exception — luôn trả về
 * SapPushResult để luồng lưu đơn local không bao giờ bị chặn bởi SAP.
 */
export async function pushOrderToSap(input: SapPushInput): Promise<SapPushResult> {
  return pushDocumentToSap({ ...input, entitySet: 'Orders' })
}

/**
 * Sửa chứng từ Sale Order đang Open trên SAP B1 (PATCH /Orders(DocEntry)).
 * KHÔNG bao giờ ném exception. Trả về status 'synced' (OK) hoặc 'error'.
 */
export async function patchOrderToSap(settings: SapConfig, input: SapPatchInput): Promise<SapPushResult> {
  return patchDocumentToSap(settings, { ...input, entitySet: 'Orders' })
}
