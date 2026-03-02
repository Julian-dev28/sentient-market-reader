/**
 * Browser-side Appwrite client (appwrite SDK).
 * Singleton — safe to import from 'use client' components.
 */

import { Client, Account } from 'appwrite'

let _client: Client | null = null

export function getAppwriteClient(): Client {
  if (!_client) {
    _client = new Client()
      .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT ?? 'https://cloud.appwrite.io/v1')
      .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID ?? '')
  }
  return _client
}

export function getAppwriteAccount(): Account {
  return new Account(getAppwriteClient())
}
