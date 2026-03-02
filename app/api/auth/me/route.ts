import { NextRequest, NextResponse } from 'next/server'
import { getAppwriteUserClient } from '@/lib/appwrite-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // Demo mode: Appwrite not configured — return a demo user so app still works
  if (!process.env.APPWRITE_PROJECT_ID) {
    return NextResponse.json({ id: 'demo', email: 'demo@local', name: 'Demo' })
  }

  const sessionToken = req.cookies.get('appwrite-session')?.value
    ?? req.headers.get('x-appwrite-session')
    ?? null

  if (!sessionToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    const { account } = getAppwriteUserClient(sessionToken)
    const user = await account.get()
    return NextResponse.json({ id: user.$id, email: user.email, name: user.name })
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
  }
}
