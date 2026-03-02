import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/** GET — return current env config (secrets redacted to presence flags) */
export async function GET() {
  const kalshiApiKey = process.env.KALSHI_API_KEY
  const orKey        = process.env.OPENROUTER_API_KEY
  const xaiKey       = process.env.XAI_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  return NextResponse.json({
    aiProvider:       process.env.AI_PROVIDER        || null,
    romaMode:         process.env.ROMA_MODE           || null,
    romaMaxDepth:     process.env.ROMA_MAX_DEPTH      || null,
    pythonRomaUrl:    process.env.PYTHON_ROMA_URL     || null,
    openrouterKeySet: !!orKey,
    openrouterKeyHint: orKey ? `${orKey.slice(0, 8)}…` : null,
    xaiKeySet:        !!xaiKey,
    anthropicKeySet:  !!anthropicKey,
    kalshiApiKey:     kalshiApiKey ? `${kalshiApiKey.slice(0, 8)}…` : null,
    kalshiKeyPath:    process.env.KALSHI_PRIVATE_KEY_PATH || null,
  })
}
