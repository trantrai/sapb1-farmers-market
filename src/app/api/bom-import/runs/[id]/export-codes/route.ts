// ============================================================
// GET /api/bom-import/runs/[id]/export-codes — xuất file Excel BOM gốc
// đã điền mã cha (F4-export).
// - Đọc file IN-1 (File BOM) đã ingest từ đĩa, parse lại để lấy đúng
//   số dòng Excel thật của từng mã cha (rowNo canonical = dòng Excel thật).
// - Map mã đã sinh (sidecar.generatedCodes, key theo rowNo lúc sinh —
//   sort tăng dần = đúng thứ tự cha trong file) vào dòng Excel tương ứng.
// - Ghi mã vào cột D (Mã hàng), giữ nguyên toàn bộ nội dung còn lại.
// - Trả về file .xlsx dạng attachment. Chỉ đọc, không ghi B1/Base.
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import { db as prisma } from '@/lib/db'
import { getSessionUser, unauthorized } from '@/lib/fm-auth'
import { getBomImportDir } from '@/lib/fm-bom-import/base-client'
import { parseMd05FromBuffer } from '@/lib/fm-bom-import/parser-md05'
import { fillParentCodes } from '@/lib/fm-bom-import/export-codes'
import { parseSourceFiles, readSidecar } from '../../../_lib'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  if (!user.permissions.bomImport?.view) {
    return NextResponse.json({ error: 'Bạn không có quyền xuất file Import BOM' }, { status: 403 })
  }
  const { id } = await params
  const run = await prisma.importRun.findUnique({ where: { id } })
  if (!run) return NextResponse.json({ error: 'Không tìm thấy run' }, { status: 404 })
  if (run.status !== 'validated') {
    return NextResponse.json({ error: 'Run chưa parse xong — không thể xuất file' }, { status: 409 })
  }

  const sidecar = await readSidecar(run)
  if (!sidecar) {
    return NextResponse.json({ error: 'Run chưa có dữ liệu parse — hãy parse lại' }, { status: 409 })
  }
  const codes = sidecar.generatedCodes ?? {}
  const codeKeys = Object.keys(codes)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  if (codeKeys.length === 0) {
    return NextResponse.json(
      { error: 'Chưa sinh mã cha — hãy nhập "Mã cha đầu tiên" và bấm "Sinh mã" trước' },
      { status: 409 },
    )
  }

  // File BOM gốc (IN-1) đã ingest
  const in1 = parseSourceFiles(run).find((f) => f.input === 'IN-1')
  if (!in1) return NextResponse.json({ error: 'Không tìm thấy file BOM gốc (IN-1)' }, { status: 404 })
  const abs = path.join(getBomImportDir(), ...in1.relPath.split('/'))
  let buf: Buffer
  try {
    buf = await fs.readFile(abs)
  } catch {
    return NextResponse.json({ error: 'Không đọc được file BOM gốc trên đĩa' }, { status: 404 })
  }

  // Parse lại để lấy đúng số dòng Excel thật của từng cha
  let parents: { rowNo: number }[]
  try {
    parents = parseMd05FromBuffer(buf).parents
  } catch (e) {
    return NextResponse.json(
      { error: `Parse lại file BOM gốc thất bại: ${e instanceof Error ? e.message : String(e)}` },
      { status: 422 },
    )
  }
  if (parents.length !== codeKeys.length) {
    return NextResponse.json(
      {
        error: `Số mã đã sinh (${codeKeys.length}) không khớp số mã cha trong file (${parents.length}) — hãy parse lại run`,
      },
      { status: 409 },
    )
  }

  const wb = XLSX.read(buf, { type: 'buffer' })
  const { filled, skipped } = fillParentCodes(
    wb,
    parents.map((p, i) => ({ rowNo: p.rowNo, code: codes[codeKeys[i]] })),
  )
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as number[]
  const body = new Blob([new Uint8Array(bytes)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const base = in1.filename.replace(/\.xlsx?$/i, '')
  const filename = `${base}_dien-ma-cha.xlsx`
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Filled-Count': String(filled),
      'X-Skipped-Count': String(skipped.length),
    },
  })
}
