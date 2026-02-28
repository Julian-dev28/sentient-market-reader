import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const base = process.env.PYTHON_SERVICE_URL ?? 'http://localhost:8001'
    const res = await fetch(`${base}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return NextResponse.json({ status: 'error', error: `HTTP ${res.status}` }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ status: 'offline' }, { status: 503 })
  }
}
