/**
 * Server-side Appwrite client factory (node-appwrite).
 * Used in API routes.
 */

import { Client, Account, Databases } from 'node-appwrite'

function baseClient(): Client {
  const client = new Client()
  client
    .setEndpoint(process.env.APPWRITE_ENDPOINT ?? 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_PROJECT_ID ?? '')
  return client
}

/** Admin client: uses server API key — for DB reads/writes from API routes. */
export function getAppwriteAdminClient() {
  const client = baseClient()
  client.setKey(process.env.APPWRITE_API_KEY ?? '')
  return {
    client,
    databases: new Databases(client),
    account: new Account(client),
  }
}

/** User client: validates a session token — for reading current user identity. */
export function getAppwriteUserClient(sessionToken: string) {
  const client = baseClient()
  client.setSession(sessionToken)
  return {
    client,
    account: new Account(client),
  }
}
