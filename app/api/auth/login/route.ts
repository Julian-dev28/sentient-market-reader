import { NextRequest, NextResponse } from 'next/server'
import { Client, Account } from 'node-appwrite'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
    }

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_ENDPOINT ?? 'https://cloud.appwrite.io/v1')
      .setProject(process.env.APPWRITE_PROJECT_ID ?? '')

    const account = new Account(client)
    const session = await account.createEmailPasswordSession(email, password)

    const res = NextResponse.json({
      userId:       session.userId,
      sessionId:    session.$id,
      sessionToken: session.secret,
    })

    res.cookies.set('appwrite-session', session.secret, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 days
    })

    return res
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status  = message.includes('Invalid credentials') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
