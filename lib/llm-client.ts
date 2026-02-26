/**
 * Unified LLM Client
 * ──────────────────
 * Provider is set via AI_PROVIDER env var:
 *   anthropic  → Claude (ANTHROPIC_API_KEY)
 *   openai     → GPT-4o (OPENAI_API_KEY)
 *   grok       → Grok direct via xAI (XAI_API_KEY → api.x.ai/v1)
 *   openrouter → any model via OpenRouter (OPENROUTER_API_KEY + OPENROUTER_MODEL)
 *
 * ROMA modules call llmChat() / llmToolCall() — provider is injected at the call site.
 */

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

export type AIProvider = 'anthropic' | 'openai' | 'grok' | 'openrouter' | 'huggingface'
export type RomaMode = 'blitz' | 'sharp' | 'keen' | 'smart'

// ── ROMA Mode ────────────────────────────────────────────────────────────────
// ROMA_MODE controls which model tier every agent uses across the pipeline:
//
//   blitz — grok-3-mini-fast; same weights as mini but on faster infra (~5–15s)
//   sharp — grok-3-mini;      fastest non-premium model               (~10–20s)
//   keen  — grok-3-fast;      balanced speed and quality              (~20–40s)
//   smart — grok-3;           best quality within Grok 3 family       (~40–70s)
//
export const ROMA_MODE: RomaMode = (() => {
  const m = process.env.ROMA_MODE ?? 'keen'
  if (m === 'blitz' || m === 'sharp' || m === 'keen' || m === 'smart') return m
  console.warn(`[llm-client] Unknown ROMA_MODE "${m}", falling back to "keen"`)
  return 'keen'
})()

// ── Model mapping ────────────────────────────────────────────────────────────
// All model IDs can be overridden via environment variables — see .env.local.
//
// Speed reference per provider (single call, p50):
//
// ANTHROPIC
//   blitz: claude-haiku-4-5-20251001  ~2–5s   — blitz tier (haiku is already fastest)
//   fast:  claude-haiku-4-5-20251001  ~2–5s   — sharp tier
//   mid:   claude-haiku-4-5-20251001  ~2–5s   — keen tier
//   smart: claude-sonnet-4-6          ~10–20s  — smart tier
//
// OPENAI
//   blitz: gpt-4o-mini                ~3–8s   — blitz tier (mini is already fastest)
//   fast:  gpt-4o-mini                ~3–8s   — sharp tier
//   mid:   gpt-4o-mini                ~3–8s   — keen tier
//   smart: gpt-4o                     ~10–20s  — smart tier
//
// GROK (xAI)
//   blitz: grok-3-mini-fast           ~3–8s   — same weights as mini, faster inference infra
//   fast:  grok-3-mini                ~5–10s  — sharp tier
//   mid:   grok-3-fast                ~10–20s  — keen tier
//   smart: grok-3                     ~30–50s  — smart tier
//
// For openrouter: set OPENROUTER_MODEL (smart), OPENROUTER_MID_MODEL (keen), OPENROUTER_FAST_MODEL (sharp/blitz).
// For huggingface: set HF_API_KEY + optionally HF_BASE_URL (default: serverless inference API).
//   blitz: Llama-3.2-3B-Instruct  ~3–8s   — smallest, fastest
//   fast:  Llama-3.1-8B-Instruct  ~5–15s  — sharp tier
//   mid:   Llama-3.3-70B-Instruct ~15–40s — keen tier
//   smart: Llama-3.3-70B-Instruct ~15–40s — smart tier (same GPU, just more context)
export const PROVIDER_MODELS: Record<AIProvider, { blitz: string; fast: string; mid: string; smart: string; label: string }> = {
  anthropic: {
    blitz: process.env.ANTHROPIC_BLITZ_MODEL ?? 'claude-haiku-4-5-20251001',
    fast:  process.env.ANTHROPIC_FAST_MODEL  ?? 'claude-haiku-4-5-20251001',
    mid:   process.env.ANTHROPIC_MID_MODEL   ?? 'claude-haiku-4-5-20251001',
    smart: process.env.ANTHROPIC_SMART_MODEL ?? 'claude-sonnet-4-6',
    label: 'Claude',
  },
  openai: {
    blitz: process.env.OPENAI_BLITZ_MODEL ?? 'gpt-4o-mini',
    fast:  process.env.OPENAI_FAST_MODEL  ?? 'gpt-4o-mini',
    mid:   process.env.OPENAI_MID_MODEL   ?? 'gpt-4o-mini',
    smart: process.env.OPENAI_SMART_MODEL ?? 'gpt-4o',
    label: 'GPT-4o',
  },
  grok: {
    blitz: process.env.GROK_BLITZ_MODEL ?? 'grok-3-mini-fast',
    fast:  process.env.GROK_FAST_MODEL  ?? 'grok-3-mini',
    mid:   process.env.GROK_MID_MODEL   ?? 'grok-3-fast',
    smart: process.env.GROK_SMART_MODEL ?? 'grok-3',
    label: 'Grok',
  },
  openrouter: {
    blitz: process.env.OPENROUTER_BLITZ_MODEL ?? process.env.OPENROUTER_FAST_MODEL ?? process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5-20251001',
    fast:  process.env.OPENROUTER_FAST_MODEL  ?? process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5-20251001',
    mid:   process.env.OPENROUTER_MID_MODEL   ?? process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5-20251001',
    smart: process.env.OPENROUTER_MODEL       ?? 'anthropic/claude-sonnet-4-6',
    label: 'OpenRouter',
  },
  huggingface: {
    blitz: process.env.HF_BLITZ_MODEL ?? 'meta-llama/Llama-3.2-3B-Instruct',
    fast:  process.env.HF_FAST_MODEL  ?? 'meta-llama/Llama-3.1-8B-Instruct',
    mid:   process.env.HF_MID_MODEL   ?? 'meta-llama/Llama-3.3-70B-Instruct',
    smart: process.env.HF_SMART_MODEL ?? 'meta-llama/Llama-3.3-70B-Instruct',
    label: 'HuggingFace',
  },
}

// Remaps to the correct tier based on ROMA_MODE:
//   blitz → blitz (grok-3-mini-fast — same weights as mini, faster infra)
//   sharp → fast  (grok-3-mini)
//   keen  → mid   (grok-3-fast)
//   smart → smart (grok-3)
export function resolveModel(tier: 'fast' | 'smart', provider: AIProvider): string {
  const effectiveTier = ROMA_MODE === 'blitz' ? 'blitz' : ROMA_MODE === 'sharp' ? 'fast' : ROMA_MODE === 'keen' ? 'mid' : 'smart'
  return PROVIDER_MODELS[provider][effectiveTier]
}

// ── Singleton clients ────────────────────────────────────────────────────────
let _anthropic:     Anthropic | null = null
let _openai:        OpenAI | null = null
let _grok:          OpenAI | null = null
let _openrouter:    OpenAI | null = null
let _huggingface:   OpenAI | null = null

function anthropicClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _anthropic
}
function openaiClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return _openai
}
function grokClient(): OpenAI {
  if (!_grok) _grok = new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' })
  return _grok
}
function openrouterClient(): OpenAI {
  if (!_openrouter) _openrouter = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  })
  return _openrouter
}
function huggingfaceClient(): OpenAI {
  if (!_huggingface) _huggingface = new OpenAI({
    apiKey: process.env.HUGGINGFACE_API_KEY ?? process.env.HF_API_KEY,
    baseURL: process.env.HF_BASE_URL ?? 'https://api-inference.huggingface.co/v1',
  })
  return _huggingface
}

function oaiCompatClient(provider: 'openai' | 'grok' | 'openrouter' | 'huggingface'): OpenAI {
  if (provider === 'grok')         return grokClient()
  if (provider === 'openrouter')   return openrouterClient()
  if (provider === 'huggingface')  return huggingfaceClient()
  return openaiClient()
}

// ── Shared schema type ───────────────────────────────────────────────────────
export interface ToolSchema {
  properties: Record<string, unknown>
  required: string[]
}

// ── llmChat ──────────────────────────────────────────────────────────────────
/** Plain text completion — used by Executor and Aggregator */
export async function llmChat(opts: {
  prompt: string
  system?: string
  tier?: 'fast' | 'smart'
  maxTokens?: number
  provider: AIProvider
}): Promise<string> {
  const { prompt, system, tier = 'fast', maxTokens = 512, provider } = opts
  const model = resolveModel(tier, provider)

  if (provider === 'anthropic') {
    const res = await anthropicClient().messages.create({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    })
    const block = res.content.find(b => b.type === 'text')
    return block?.type === 'text' ? block.text : ''
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: prompt })

  const res = await oaiCompatClient(provider as 'openai' | 'grok' | 'openrouter' | 'huggingface').chat.completions.create({ model, max_tokens: maxTokens, messages })
  return res.choices[0]?.message?.content ?? ''
}

// ── llmToolCall ──────────────────────────────────────────────────────────────
/** Forced single-tool call — returns parsed JSON matching the schema */
export async function llmToolCall<T>(opts: {
  prompt: string
  toolName: string
  toolDescription: string
  schema: ToolSchema
  tier?: 'fast' | 'smart'
  maxTokens?: number
  provider: AIProvider
}): Promise<T> {
  const { prompt, toolName, toolDescription, schema, tier = 'fast', maxTokens = 1024, provider } = opts
  const model = resolveModel(tier, provider)
  const fullSchema = { type: 'object' as const, properties: schema.properties, required: schema.required }

  const timeout = 30_000  // 30s hard cap — extraction should never take this long

  if (provider === 'anthropic') {
    const res = await anthropicClient().messages.create(
      {
        model,
        max_tokens: maxTokens,
        tools: [{ name: toolName, description: toolDescription, input_schema: fullSchema }],
        tool_choice: { type: 'tool', name: toolName },
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: AbortSignal.timeout(timeout) },
    )
    const block = res.content.find(b => b.type === 'tool_use')
    if (!block || block.type !== 'tool_use') throw new Error(`No tool_use block from ${provider}`)
    return block.input as T
  }

  // HuggingFace: attempt tool_choice first; fall back to JSON-in-content for models
  // that don't support function calling (e.g. smaller Llama variants).
  if (provider === 'huggingface') {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }]
    try {
      const res = await huggingfaceClient().chat.completions.create(
        { model, max_tokens: maxTokens, tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: fullSchema } }], tool_choice: { type: 'function', function: { name: toolName } }, messages },
        { signal: AbortSignal.timeout(timeout) },
      )
      const tc = res.choices[0]?.message?.tool_calls?.[0] as { function: { arguments: string } } | undefined
      if (tc) return JSON.parse(tc.function.arguments) as T
    } catch { /* fall through to JSON extraction */ }
    // Fallback: ask for raw JSON in content
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema: ${JSON.stringify(fullSchema)}. No markdown, no explanation.`
    const fallback = await huggingfaceClient().chat.completions.create(
      { model, max_tokens: maxTokens, messages: [{ role: 'user', content: jsonPrompt }] },
      { signal: AbortSignal.timeout(timeout) },
    )
    const raw = fallback.choices[0]?.message?.content ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error(`HuggingFace: no JSON found in response`)
    return JSON.parse(jsonMatch[0]) as T
  }

  const res = await oaiCompatClient(provider as 'openai' | 'grok' | 'openrouter').chat.completions.create(
    {
      model,
      max_tokens: maxTokens,
      tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: fullSchema } }],
      tool_choice: { type: 'function', function: { name: toolName } },
      messages: [{ role: 'user', content: prompt }],
    },
    { signal: AbortSignal.timeout(timeout) },
  )
  const toolCall = res.choices[0]?.message?.tool_calls?.[0] as { function: { arguments: string } } | undefined
  if (!toolCall) throw new Error(`No tool_call from ${provider}`)
  return JSON.parse(toolCall.function.arguments) as T
}
