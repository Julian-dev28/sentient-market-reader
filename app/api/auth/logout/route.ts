import { NextRequest, NextResponse } from 'next/server'
import { getAppwriteUserClient } from '@/lib/appwrite-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const sessionToken = req.cookies.get('appwrite-session')?.value
  if (sessionToken) {
    try {
      const { account } = getAppwriteUserClient(sessionToken)
      await account.deleteSession('current')
    } catch {
      // Session already invalid — still clear cookie
    }
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set('appwrite-session', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return res
}
