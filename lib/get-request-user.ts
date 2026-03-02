/**
 * Extracts the Appwrite session from a Next.js API request and returns
 * resolved Kalshi credentials (user's DB creds or env var fallback).
 */

import { type NextRequest } from 'next/server'
import { getAppwriteUserClient } from './appwrite-server'
import { getUserKalshiCreds, getEnvCreds, type KalshiCreds } from './get-user-kalshi-creds'

export async function getRequestCreds(req: NextRequest): Promise<KalshiCreds | null> {
  // Session token from HttpOnly cookie (set at login) or forwarded header
  const sessionToken = req.cookies.get('appwrite-session')?.value
    ?? req.headers.get('x-appwrite-session')
    ?? null

  if (sessionToken && process.env.APPWRITE_PROJECT_ID) {
    try {
      const { account } = getAppwriteUserClient(sessionToken)
      const user = await account.get()
      const creds = await getUserKalshiCreds(user.$id)
      if (creds) return creds
    } catch {
      // Session invalid or DB not configured — fall through
    }
  }

  // Dev / demo fallback: env var credentials
  return getEnvCreds()
}
