import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const sp       = req.nextUrl.searchParams
  const days     = Math.max(1, Math.min(14, parseInt(sp.get('days') ?? '3', 10) || 3))
  const provider = sp.get('provider') ?? ''
  const romaMode = sp.get('romaMode') ?? 'blitz'
  const maxLlm   = Math.max(1, Math.min(50, parseInt(sp.get('maxLlm') ?? '20', 10) || 20))

  // Build Python URL with query params
  const pyUrl = new URL('http://localhost:8001/backtest')
  pyUrl.searchParams.set('days', String(days))
  if (provider) pyUrl.searchParams.set('provider', provider)
  pyUrl.searchParams.set('roma_mode', romaMode)
  pyUrl.searchParams.set('max_llm', String(maxLlm))

  // Forward x-provider-keys header if present (base64 JSON of {provider: apiKey})
  const headers: Record<string, string> = {}
  const providerKeys = req.headers.get('x-provider-keys')
  if (providerKeys) headers['x-provider-keys'] = providerKeys

  let pythonRes: Response
  try {
    pythonRes = await fetch(pyUrl.toString(), {
      headers,
      signal: AbortSignal.timeout(115_000),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Python service unavailable: ${msg}` }, { status: 503 })
  }

  if (!pythonRes.ok) {
    const body = await pythonRes.text().catch(() => '')
    return NextResponse.json(
      { error: `Backtest failed: ${body || pythonRes.statusText}` },
      { status: pythonRes.status },
    )
  }

  return NextResponse.json(await pythonRes.json())
}
