/**
 * Retrieves and decrypts a user's Kalshi credentials from Appwrite DB.
 * Falls back to env var credentials in dev/demo mode.
 */

import { Query } from 'node-appwrite'
import { getAppwriteAdminClient } from './appwrite-server'
import { decrypt } from './encryption'

export interface KalshiCreds {
  apiKeyId: string
  privateKey: string
}

export async function getUserKalshiCreds(userId: string): Promise<KalshiCreds | null> {
  const dbId  = process.env.APPWRITE_DB_ID
  const colId = process.env.APPWRITE_CREDS_COLLECTION
  if (!dbId || !colId) return null

  try {
    const { databases } = getAppwriteAdminClient()
    const result = await databases.listDocuments(dbId, colId, [
      Query.equal('userId', userId),
      Query.limit(1),
    ])
    if (!result.documents.length) return null
    const doc = result.documents[0]
    const privateKey = decrypt(doc.encryptedPrivateKey as string)
    return {
      apiKeyId: doc.kalshiApiKeyId as string,
      privateKey,
    }
  } catch {
    return null
  }
}

/** Falls back to env var credentials (dev mode / single-user). */
export function getEnvCreds(): KalshiCreds | null {
  const apiKeyId = process.env.KALSHI_API_KEY
  const keyPath  = process.env.KALSHI_PRIVATE_KEY_PATH
  if (!apiKeyId || !keyPath) return null

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require('fs') as typeof import('fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require('path') as typeof import('path')
    const resolved = keyPath.startsWith('/')
      ? keyPath
      : join(process.cwd(), keyPath.startsWith('./') ? keyPath.slice(2) : keyPath)
    const privateKey = readFileSync(resolved, 'utf-8')
    return { apiKeyId, privateKey }
  } catch {
    return null
  }
}
