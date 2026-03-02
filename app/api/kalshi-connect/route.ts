import { NextResponse, type NextRequest } from 'next/server'
import { createSign, constants } from 'crypto'
import { readStoredCreds, writeStoredCreds, deleteStoredCreds, hasStoredCreds } from '@/lib/kalshi-credentials'

export const runtime = 'nodejs'

/** GET — return connection status (never returns the private key) */
export async function GET() {
  const stored = readStoredCreds()
  if (stored) {
    return NextResponse.json({ connected: true, source: 'ui', apiKey: stored.apiKey })
  }
  const envConfigured = !!(process.env.KALSHI_API_KEY && process.env.KALSHI_PRIVATE_KEY_PATH)
  return NextResponse.json({ connected: envConfigured, source: envConfigured ? 'env' : 'none' })
}

/** POST — validate + save API key ID + PEM private key */
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

  // Normalise PEM: ensure LF line endings and proper header/footer
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

  writeStoredCreds(apiKey, pem)
  return NextResponse.json({ ok: true })
}

/** DELETE — remove stored credentials */
export async function DELETE() {
  if (hasStoredCreds()) deleteStoredCreds()
  return NextResponse.json({ ok: true })
}
