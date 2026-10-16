// ============================================================
// POST /api/bom-import/runs/[id]/codes — sinh mã cha (F4, Q1/ADR-003)
// Body: { firstCode: string }
// - Mã đầu giữ nguyên; các mã sau tăng dần theo phần số cuối (giữ
//   zero-padding); không có phần số cuối → thêm "-001", "-002"…
// - Kiểm tra trùng: trong đợt + GET /Items trên B1. B1 chưa sẵn sàng
//   (chưa có B1 test) → degrade graceful: warning, KHÔNG chặn flow.
// - Idempotent: cùng firstCode → trả lại mã đã sinh, không sinh mới.
// - Mã đã chốt lưu vào sidecar.generatedCodes (Sprint 3 dùng cho apply).
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { generateParentCodes } from '@/lib/fm-bom-import/parent-codes'
import { readSidecar, writeSidecar } from '../../../_lib'
import { isSapConfigured, loadSapSettings, sapGet } from '@/lib/sap-service-layer'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.create) {
    return NextResponse.json({ error: 'Bạn không có quyền sinh mã cha' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })
  if (run.status !== 'validated') {
    return NextResponse.json({ error: `Run chưa parse xong (trạng thái: ${run.status})` }, { status: 409 })
  }

  let body: { firstCode?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body không phải JSON' }, { status: 400 })
  }
  const firstCode = String(body.firstCode ?? '').normalize('NFC').trim()
  if (!firstCode) {
    return NextResponse.json({ error: 'Thiếu "Mã cha đầu tiên"' }, { status: 400 })
  }

  const sidecar = await readSidecar(run)
  if (!sidecar?.canonical) {
    return NextResponse.json({ error: 'Chưa có dữ liệu canonical — hãy chạy parse lại' }, { status: 409 })
  }
  const parents = sidecar.canonical.parents
  if (parents.length === 0) {
    return NextResponse.json({ error: 'Đợt này không có mã cha nào' }, { status: 400 })
  }

  // Idempotent: cùng mã đầu → dùng lại dãy đã sinh
  const existing = sidecar.generatedCodes
  const existingCodes = parents.map((p) => existing[p.rowNo]).filter(Boolean)
  if (existingCodes.length === parents.length && existing[parents[0].rowNo] === firstCode) {
    return NextResponse.json({
      runId: id,
      codes: parents.map((p) => ({ rowNo: p.rowNo, code: existing[p.rowNo] })),
      reused: true,
      warnings: [],
      note: 'Dùng lại dãy mã đã sinh trước đó (idempotent)',
    })
  }

  // Kiểm tra trùng trên B1 — degrade graceful khi B1 chưa sẵn sàng
  const dupWarnings: string[] = []
  let existsFn: ((code: string) => Promise<boolean>) | undefined
  try {
    const cfg = await loadSapSettings(run.sapDatabaseId)
    if (isSapConfigured(cfg)) {
      existsFn = async (code: string) => {
        const r = await sapGet(cfg, `/Items('${encodeURIComponent(code)}')`, {}, { audit: 'off', retryOf: id })
        if (r.ok) return true
        if (r.status === 404) return false
        throw new Error(r.error ?? `B1 trả HTTP ${r.status}`)
      }
      // Probe 1 lần để biết B1 có trả lời không (trước khi sinh hàng loạt)
      await existsFn(firstCode)
    } else {
      dupWarnings.push('Chưa cấu hình kết nối SAP B1 — bỏ qua kiểm tra trùng mã trên B1')
    }
  } catch (e) {
    dupWarnings.push(
      `Không kiểm tra được trùng mã trên SAP B1 (${(e as Error).message}) — tiếp tục sinh mã, không chặn flow`,
    )
    existsFn = undefined
  }

  let result: Awaited<ReturnType<typeof generateParentCodes>>
  try {
    result = await generateParentCodes(firstCode, { count: parents.length, exists: existsFn })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }

  const generatedCodes: Record<number, string> = {}
  parents.forEach((p, idx) => {
    generatedCodes[p.rowNo] = result.codes[idx]
  })
  await writeSidecar(run, { generatedCodes })

  return NextResponse.json({
    runId: id,
    codes: parents.map((p) => ({ rowNo: p.rowNo, code: generatedCodes[p.rowNo] })),
    reused: false,
    warnings: [...dupWarnings, ...result.warnings],
    dupChecked: result.dupChecked,
  })
}
