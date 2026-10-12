import { NextResponse } from 'next/server'
import { db as prisma } from '@/lib/db'
import { ensureSapDatabases } from '@/lib/sap-service-layer'

// GET /api/auth/databases — PUBLIC (dùng cho dropdown chọn database ở màn đăng nhập).
// Chỉ trả id/label/isDefault — KHÔNG trả thông tin kết nối.
export async function GET() {
  try {
    await ensureSapDatabases()
    const list = await prisma.sapDatabase.findMany({
      select: { id: true, label: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json({ databases: list })
  } catch {
    return NextResponse.json({ databases: [] })
  }
}
