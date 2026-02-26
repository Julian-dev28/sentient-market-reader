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

export type AIProvider = 'anthropic' | 'openai' | 'grok' | 'openrouter'
export type RomaMode = 'keen' | 'smart' | 'deep'

// ── ROMA Mode ────────────────────────────────────────────────────────────────
// ROMA_MODE controls which model tier every agent uses across the pipeline:
//
//   keen  — all agents forced to the fast model (~15–25s pipeline)
//            best for tight 5-min cycles or high-frequency signal checks
//
//   smart — fast agents use fast model, smart agents use smart model (~30–60s)
//            default; balanced cost/quality for 15-min prediction markets
//
//   deep  — all agents forced to the deep (frontier/reasoning) model (~60–120s)
//            best for longer-horizon research, not real-time trading
//
export const ROMA_MODE: RomaMode = (() => {
  const m = process.env.ROMA_MODE ?? 'smart'
  if (m === 'keen' || m === 'smart' || m === 'deep') return m
  console.warn(`[llm-client] Unknown ROMA_MODE "${m}", falling back to "smart"`)
  return 'smart'
})()

// ── Model mapping ────────────────────────────────────────────────────────────
// All model IDs can be overridden via environment variables — see .env.local.
//
// Speed reference per provider (single call, p50):
//
// ANTHROPIC
//   fast:  claude-haiku-4-5-20251001  ~2–5s   — best fast option
//   smart: claude-sonnet-4-6          ~10–20s  — default smart
//   deep:  claude-opus-4-6            ~20–40s  — max intelligence
//
// OPENAI
//   fast:  gpt-4o-mini                ~3–8s   — best fast option
//   smart: gpt-4o                     ~10–20s  — default smart
//   deep:  gpt-4o                     ~10–20s  — swap to o3-mini for reasoning
//
// GROK (xAI)
//   fast:  grok-3-fast                ~5–10s  — best fast option
//   smart: grok-4-0709                ~15–30s  — default smart
//   deep:  grok-4-0709                ~15–30s  — swap to grok-4-1-fast-reasoning if available
//
// For openrouter: set OPENROUTER_MODEL (smart/deep) and optionally OPENROUTER_FAST_MODEL.
export const PROVIDER_MODELS: Record<AIProvider, { fast: string; smart: string; deep: string; label: string }> = {
  anthropic: {
    fast:  process.env.ANTHROPIC_FAST_MODEL  ?? 'claude-haiku-4-5-20251001',
    smart: process.env.ANTHROPIC_SMART_MODEL ?? 'claude-sonnet-4-6',
    deep:  process.env.ANTHROPIC_DEEP_MODEL  ?? 'claude-opus-4-6',
    label: 'Claude',
  },
  openai: {
    fast:  process.env.OPENAI_FAST_MODEL  ?? 'gpt-4o-mini',
    smart: process.env.OPENAI_SMART_MODEL ?? 'gpt-4o',
    deep:  process.env.OPENAI_DEEP_MODEL  ?? 'gpt-4o',   // override to o3-mini if you have access
    label: 'GPT-4o',
  },
  grok: {
    fast:  process.env.GROK_FAST_MODEL  ?? 'grok-3-fast',
    smart: process.env.GROK_SMART_MODEL ?? 'grok-4-0709',
    deep:  process.env.GROK_DEEP_MODEL  ?? 'grok-4-0709', // override to grok-4-1-fast-reasoning if available
    label: 'Grok',
  },
  openrouter: {
    fast:  process.env.OPENROUTER_FAST_MODEL  ?? process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5-20251001',
    smart: process.env.OPENROUTER_MODEL       ?? 'anthropic/claude-sonnet-4-6',
    deep:  process.env.OPENROUTER_DEEP_MODEL  ?? process.env.OPENROUTER_MODEL ?? 'anthropic/claude-opus-4-6',
    label: 'OpenRouter',
  },
}

// Remaps the requested tier based on the active ROMA_MODE:
//   ultra-fast → always fast
//   normal     → pass-through (fast stays fast, smart stays smart)
//   deep       → always deep
export function resolveModel(tier: 'fast' | 'smart', provider: AIProvider): string {
  const effectiveTier = ROMA_MODE === 'keen' ? 'fast' : ROMA_MODE === 'deep' ? 'deep' : tier
  return PROVIDER_MODELS[provider][effectiveTier]
}

// ── Singleton clients ────────────────────────────────────────────────────────
let _anthropic:   Anthropic | null = null
let _openai:      OpenAI | null = null
let _grok:        OpenAI | null = null
let _openrouter:  OpenAI | null = null

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

function oaiCompatClient(provider: 'openai' | 'grok' | 'openrouter'): OpenAI {
  if (provider === 'grok')        return grokClient()
  if (provider === 'openrouter')  return openrouterClient()
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

  const res = await oaiCompatClient(provider).chat.completions.create({ model, max_tokens: maxTokens, messages })
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

  const res = await oaiCompatClient(provider).chat.completions.create(
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
