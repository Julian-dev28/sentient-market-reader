/**
 * Kalshi RSA-PSS Authentication
 * ──────────────────────────────
 * Signs requests using PKCS#8 / PKCS#1 RSA private key.
 * Required headers:
 *   KALSHI-ACCESS-KEY       — API key ID
 *   KALSHI-ACCESS-TIMESTAMP — Unix ms timestamp (as string)
 *   KALSHI-ACCESS-SIGNATURE — Base64 RSA-PSS signature
 *
 * Signature payload: `${timestamp}\n${method}\n${path}`
 */

import { readFileSync } from 'fs'
import { createSign, constants } from 'crypto'
import { join } from 'path'

function loadPrivateKey(): string {
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH
  if (!keyPath) return ''
  const resolved = keyPath.startsWith('./') || keyPath.startsWith('/')
    ? keyPath.startsWith('/') ? keyPath : join(process.cwd(), keyPath.slice(2))
    : join(process.cwd(), keyPath)
  try {
    return readFileSync(resolved, 'utf-8')
  } catch {
    return ''
  }
}

export function buildKalshiHeaders(method: string, path: string): Record<string, string> {
  const apiKey = process.env.KALSHI_API_KEY
  if (!apiKey) return {}

  const privateKey = loadPrivateKey()
  if (!privateKey) return {}

  const timestamp = String(Date.now())
  // Kalshi signing: direct concatenation, no separators
  const payload = `${timestamp}${method.toUpperCase()}${path}`

  try {
    const sign = createSign('RSA-SHA256')
    sign.update(payload)
    sign.end()
    const signature = sign.sign({
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }, 'base64')

    return {
      'KALSHI-ACCESS-KEY': apiKey,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'Accept': 'application/json',
    }
  } catch {
    return { 'Accept': 'application/json' }
  }
}

export function hasKalshiAuth(): boolean {
  return !!(process.env.KALSHI_API_KEY && process.env.KALSHI_PRIVATE_KEY_PATH)
}
