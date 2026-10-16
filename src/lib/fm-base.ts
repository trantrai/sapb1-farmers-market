// ============================================================
// FARMERS MARKET — Base Workflow API: quản lý Access Token v2
// Token do admin nhập 1 lần ở màn hình Cài đặt, lưu mã hóa AES-256-GCM
// vào AppSettings.baseTokenEnc (đúng pattern SapDatabase.sapPassword).
// Việc gọi API Base nằm ở src/lib/fm-bom-import/base-client.ts.
// ============================================================

import { db as prisma } from './db'
import { decryptSecret, encryptSecret } from './fm-crypto'

export const BASE_WORKFLOW_BASE_URL = 'https://workflow.base.vn'
export const BASE_JOB_GET_PATH = '/extapi/v1/job/get'

/** Đọc Base Access Token v2 đã giải mã ('' nếu chưa cấu hình) */
export async function getBaseToken(): Promise<string> {
  const s = await prisma.appSettings.findUnique({ where: { id: 'main' } })
  return decryptSecret(s?.baseTokenEnc)
}

/** Có token không — để API/UI kiểm tra nhanh mà không lộ token */
export async function hasBaseToken(): Promise<boolean> {
  return (await getBaseToken()) !== ''
}

/**
 * Lưu Base Access Token v2 (mã hóa AES-GCM trước khi lưu).
 * Truyền chuỗi rỗng để xóa token.
 */
export async function setBaseToken(token: string): Promise<void> {
  const enc = token && token.trim() ? encryptSecret(token.trim()) : ''
  await prisma.appSettings.upsert({
    where: { id: 'main' },
    update: { baseTokenEnc: enc },
    create: { id: 'main', baseTokenEnc: enc },
  })
}
