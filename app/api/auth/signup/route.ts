import { NextRequest, NextResponse } from 'next/server'
import { Client, Account, ID } from 'node-appwrite'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { email, password, name } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
    }

    // Create user account (requires server API key)
    const adminClient = new Client()
      .setEndpoint(process.env.APPWRITE_ENDPOINT ?? 'https://cloud.appwrite.io/v1')
      .setProject(process.env.APPWRITE_PROJECT_ID ?? '')
      .setKey(process.env.APPWRITE_API_KEY ?? '')
    const adminAccount = new Account(adminClient)
    await adminAccount.create(ID.unique(), email, password, name ?? '')

    // Auto-login after signup
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
      maxAge: 60 * 60 * 24 * 30,
    })

    return res
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status  = message.includes('already exists') || message.includes('user_already_exists') ? 409 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
