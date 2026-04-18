import { NextResponse, type NextRequest } from 'next/server'
import { createSign, constants } from 'crypto'
import { Query, ID } from 'node-appwrite'
import { getAppwriteAdminClient, getAppwriteUserClient } from '@/lib/appwrite-server'
import { encrypt } from '@/lib/encryption'
import { readStoredCreds, writeStoredCreds, deleteStoredCreds, hasStoredCreds } from '@/lib/kalshi-credentials'

export const runtime = 'nodejs'

/** Resolve the session token and return the Appwrite user ID, or null in demo mode. */
async function getUserId(req: NextRequest): Promise<string | null> {
  if (!process.env.APPWRITE_PROJECT_ID) return null // demo mode — no auth
  const sessionToken = req.cookies.get('appwrite-session')?.value
    ?? req.headers.get('x-appwrite-session')
    ?? null
  if (!sessionToken) return null
  try {
    const { account } = getAppwriteUserClient(sessionToken)
    const user = await account.get()
    return user.$id
  } catch {
    return null
  }
}

/** GET — return connection status */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req)

  // Appwrite mode: look up per-user creds in DB
  if (userId) {
    const dbId  = process.env.APPWRITE_DB_ID
    const colId = process.env.APPWRITE_CREDS_COLLECTION
    if (!dbId || !colId) {
      return NextResponse.json({ connected: false, source: 'none' })
    }
    try {
      const { databases } = getAppwriteAdminClient()
      const result = await databases.listDocuments(dbId, colId, [
        Query.equal('userId', userId),
        Query.limit(1),
      ])
      if (!result.documents.length) {
        return NextResponse.json({ connected: false, source: 'none' })
      }
      const doc = result.documents[0]
      return NextResponse.json({ connected: true, source: 'db', apiKey: doc.kalshiApiKeyId as string })
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 })
    }
  }

  // Demo / dev mode: check local file store, then env vars
  const stored = readStoredCreds()
  if (stored) {
    return NextResponse.json({ connected: true, source: 'ui', apiKey: stored.apiKey })
  }
  const envConfigured = !!(process.env.KALSHI_API_KEY && process.env.KALSHI_PRIVATE_KEY_PATH)
  return NextResponse.json({ connected: envConfigured, source: envConfigured ? 'env' : 'none' })
}

/** POST — validate + save API key + PEM private key */
export async function POST(req: NextRequest) {
  let apiKey: string, privateKey: string
  try {
    const body = await req.json()
    apiKey     = String(body.apiKey ?? '').trim()
    privateKey = String(body.privateKey ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!apiKey)     return NextResponse.json({ error: 'apiKey is required' },     { status: 400 })
  if (!privateKey) return NextResponse.json({ error: 'privateKey is required' }, { status: 400 })

  const pem = privateKey.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!pem.includes('-----BEGIN') || !pem.includes('PRIVATE KEY-----')) {
    return NextResponse.json({ error: 'Private key must be a PEM file (-----BEGIN ... PRIVATE KEY-----)' }, { status: 400 })
  }

  // Validate by attempting a test sign
  try {
    const sign = createSign('RSA-SHA256')
    sign.update('test')
    sign.end()
    sign.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64')
  } catch (e) {
    return NextResponse.json({ error: `Invalid private key: ${String(e)}` }, { status: 400 })
  }

  const userId = await getUserId(req)

  // Appwrite mode: store encrypted in DB
  if (userId) {
    const dbId  = process.env.APPWRITE_DB_ID
    const colId = process.env.APPWRITE_CREDS_COLLECTION
    if (!dbId || !colId) {
      return NextResponse.json({ error: 'Appwrite DB not configured' }, { status: 500 })
    }
    try {
      const encryptedPrivateKey = encrypt(pem)
      const { databases } = getAppwriteAdminClient()
      const existing = await databases.listDocuments(dbId, colId, [
        Query.equal('userId', userId),
        Query.limit(1),
      ])
      if (existing.documents.length) {
        await databases.updateDocument(dbId, colId, existing.documents[0].$id, {
          kalshiApiKeyId: apiKey,
          encryptedPrivateKey,
        })
      } else {
        await databases.createDocument(dbId, colId, ID.unique(), {
          userId,
          kalshiApiKeyId: apiKey,
          encryptedPrivateKey,
        })
      }
      return NextResponse.json({ ok: true })
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 })
    }
  }

  // Demo / dev mode: save to local file
  writeStoredCreds(apiKey, pem)
  return NextResponse.json({ ok: true })
}

/** DELETE — remove stored credentials */
export async function DELETE(req: NextRequest) {
  const userId = await getUserId(req)

  if (userId) {
    const dbId  = process.env.APPWRITE_DB_ID
    const colId = process.env.APPWRITE_CREDS_COLLECTION
    if (dbId && colId) {
      try {
        const { databases } = getAppwriteAdminClient()
        const existing = await databases.listDocuments(dbId, colId, [
          Query.equal('userId', userId),
          Query.limit(1),
        ])
        if (existing.documents.length) {
          await databases.deleteDocument(dbId, colId, existing.documents[0].$id)
        }
      } catch (e) {
        console.error('[kalshi-connect] Failed to delete credentials from Appwrite DB:', e)
      }
    }
    return NextResponse.json({ ok: true })
  }

  if (hasStoredCreds()) deleteStoredCreds()
  return NextResponse.json({ ok: true })
}
