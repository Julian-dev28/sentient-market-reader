/**
 * Local Kalshi credential store
 * ──────────────────────────────
 * Persists API key ID + PEM private key to `.kalshi-credentials.json`
 * in the project root. Gitignored. Checked first by kalshi-auth.ts
 * before falling back to KALSHI_API_KEY / KALSHI_PRIVATE_KEY_PATH env vars.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

const CREDS_FILE = join(process.cwd(), '.kalshi-credentials.json')

interface StoredCreds {
  apiKey: string
  privateKey: string  // full PEM content
}

export function readStoredCreds(): StoredCreds | null {
  if (!existsSync(CREDS_FILE)) return null
  try {
    return JSON.parse(readFileSync(CREDS_FILE, 'utf-8')) as StoredCreds
  } catch {
    return null
  }
}

export function writeStoredCreds(apiKey: string, privateKey: string): void {
  writeFileSync(CREDS_FILE, JSON.stringify({ apiKey, privateKey }, null, 2), 'utf-8')
}

export function deleteStoredCreds(): void {
  if (existsSync(CREDS_FILE)) unlinkSync(CREDS_FILE)
}

export function hasStoredCreds(): boolean {
  return !!readStoredCreds()
}
