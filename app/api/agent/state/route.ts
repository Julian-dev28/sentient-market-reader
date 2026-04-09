import { NextResponse } from 'next/server'
import { serverAgent } from '@/lib/server-agent'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json(serverAgent.getState())
}
