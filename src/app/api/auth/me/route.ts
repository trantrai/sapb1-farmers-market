import { getSessionUser, unauthorized } from '@/lib/fm-auth'

export async function GET(req: Request) {
  const user = await getSessionUser(req)
  if (!user) return unauthorized()
  return Response.json({ user })
}
