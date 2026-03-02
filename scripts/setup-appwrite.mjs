#!/usr/bin/env node
/**
 * Appwrite project setup script for Sentient ROMA
 * ─────────────────────────────────────────────────
 * Run AFTER you have:
 *  1. Created a project at cloud.appwrite.io
 *  2. Created a server API key (any scope, or at minimum: databases.*)
 *  3. Added APPWRITE_PROJECT_ID, APPWRITE_API_KEY, APPWRITE_ENDPOINT to .env.local
 *
 * Usage:
 *   npm run setup-appwrite
 *
 * What it does:
 *  - Creates the "sentient-db" database
 *  - Creates the "kalshi_credentials" collection
 *  - Adds userId, kalshiApiKeyId, encryptedPrivateKey string attributes
 *  - Creates an index on userId for fast lookups
 *  - Prints the env vars to add to .env.local
 */

import { Client, Databases, ID } from 'node-appwrite'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

// Load .env.local
let env = {}
try {
  const raw = readFileSync(join(root, '.env.local'), 'utf-8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim()
    env[key] = val
  }
} catch {
  console.error('Could not read .env.local — make sure it exists at the project root.')
  process.exit(1)
}

const ENDPOINT   = env.APPWRITE_ENDPOINT   ?? 'https://cloud.appwrite.io/v1'
const PROJECT_ID = env.APPWRITE_PROJECT_ID ?? ''
const API_KEY    = env.APPWRITE_API_KEY    ?? ''

if (!PROJECT_ID) {
  console.error('APPWRITE_PROJECT_ID is not set in .env.local')
  process.exit(1)
}
if (!API_KEY) {
  console.error('APPWRITE_API_KEY is not set in .env.local')
  process.exit(1)
}

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY)

const databases = new Databases(client)

const DB_ID  = 'sentient-db'
const COL_ID = 'kalshi_credentials'

async function run() {
  console.log(`\nConnecting to Appwrite at ${ENDPOINT}`)
  console.log(`Project: ${PROJECT_ID}\n`)

  // ── Create database ──────────────────────────────────────────────────────
  let dbId = DB_ID
  try {
    const db = await databases.create(DB_ID, 'Sentient DB')
    dbId = db.$id
    console.log(`✓ Created database: ${dbId}`)
  } catch (err) {
    if (String(err).includes('already exists') || String(err).includes('409')) {
      console.log(`  Database "${DB_ID}" already exists — skipping`)
    } else {
      throw err
    }
  }

  // ── Create collection ────────────────────────────────────────────────────
  try {
    await databases.createCollection(
      DB_ID,
      COL_ID,
      'Kalshi Credentials',
      [`read("users")`, `create("users")`, `update("users")`, `delete("users")`],
    )
    console.log(`✓ Created collection: ${COL_ID}`)
  } catch (err) {
    if (String(err).includes('already exists') || String(err).includes('409')) {
      console.log(`  Collection "${COL_ID}" already exists — skipping`)
    } else {
      throw err
    }
  }

  // ── Attributes ───────────────────────────────────────────────────────────
  const attrs = [
    { key: 'userId',               size: 36,   required: true  },
    { key: 'kalshiApiKeyId',       size: 128,  required: true  },
    { key: 'encryptedPrivateKey',  size: 8192, required: true  },
  ]

  for (const { key, size, required } of attrs) {
    try {
      await databases.createStringAttribute(DB_ID, COL_ID, key, size, required)
      console.log(`✓ Attribute: ${key}`)
    } catch (err) {
      if (String(err).includes('already exists') || String(err).includes('409')) {
        console.log(`  Attribute "${key}" already exists — skipping`)
      } else {
        console.warn(`  Warning: could not create attribute "${key}": ${err}`)
      }
    }
    // Small delay to avoid race condition (Appwrite processes attrs async)
    await new Promise(r => setTimeout(r, 500))
  }

  // ── Index on userId ──────────────────────────────────────────────────────
  try {
    await databases.createIndex(DB_ID, COL_ID, 'userId_idx', 'key', ['userId'])
    console.log(`✓ Index on userId`)
  } catch (err) {
    if (String(err).includes('already exists') || String(err).includes('409')) {
      console.log(`  Index already exists — skipping`)
    } else {
      console.warn(`  Warning: could not create index: ${err}`)
    }
  }

  // ── Generate encryption key ───────────────────────────────────────────────
  const { randomBytes } = await import('crypto')
  const encKey = randomBytes(32).toString('hex')

  console.log('\n─────────────────────────────────────────────────────────────')
  console.log('Setup complete! Add these to your .env.local:\n')
  console.log(`APPWRITE_DB_ID=${DB_ID}`)
  console.log(`APPWRITE_CREDS_COLLECTION=${COL_ID}`)
  if (!env.ENCRYPTION_KEY) {
    console.log(`ENCRYPTION_KEY=${encKey}   # generated — keep this secret!`)
  } else {
    console.log(`# ENCRYPTION_KEY already set`)
  }
  console.log('\nAlso ensure NEXT_PUBLIC_APPWRITE_PROJECT_ID and NEXT_PUBLIC_APPWRITE_ENDPOINT are set.')
  console.log('─────────────────────────────────────────────────────────────\n')
}

run().catch(err => {
  console.error('\nSetup failed:', err)
  process.exit(1)
})
