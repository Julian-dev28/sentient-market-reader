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

// ── Model mapping ────────────────────────────────────────────────────────────
// All model IDs can be overridden via environment variables — see .env.local.
//
// Latest model recommendations (as of Feb 2026):
//
// ANTHROPIC
//   fast:  claude-haiku-4-5-20251001  — current default, still best fast option
//   smart: claude-sonnet-4-6          — current default; claude-opus-4-6 is available
//                                       for max intelligence (higher cost)
//
// OPENAI
//   fast:  gpt-4o-mini                — current default; gpt-5-mini available if you
//                                       have access (faster, cheaper than gpt-5)
//   smart: gpt-4o                     — current default; gpt-5 / gpt-5.2 available
//                                       for access-approved accounts
//
// GROK (xAI)
//   fast:  grok-3-fast                — current default; grok-4-1-fast-non-reasoning
//                                       reported available with 2M context window
//   smart: grok-3                     — current default; grok-4-0709 / grok-4-1-fast-reasoning
//                                       available for latest frontier performance
//
// For openrouter: set OPENROUTER_MODEL (smart) and optionally OPENROUTER_FAST_MODEL.
export const PROVIDER_MODELS: Record<AIProvider, { fast: string; smart: string; label: string }> = {
  anthropic: {
    fast:  process.env.ANTHROPIC_FAST_MODEL  ?? 'claude-haiku-4-5-20251001',
    smart: process.env.ANTHROPIC_SMART_MODEL ?? 'claude-sonnet-4-6',
    label: 'Claude',
  },
  openai: {
    fast:  process.env.OPENAI_FAST_MODEL  ?? 'gpt-4o-mini',
    smart: process.env.OPENAI_SMART_MODEL ?? 'gpt-4o',
    label: 'GPT-4o',
  },
  grok: {
    fast:  process.env.GROK_FAST_MODEL  ?? 'grok-3-fast',
    smart: process.env.GROK_SMART_MODEL ?? 'grok-3',
    label: 'Grok',
  },
  openrouter: {
    fast:  process.env.OPENROUTER_FAST_MODEL  ?? process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5-20251001',
    smart: process.env.OPENROUTER_MODEL       ?? 'anthropic/claude-sonnet-4-6',
    label: 'OpenRouter',
  },
}

export function resolveModel(tier: 'fast' | 'smart', provider: AIProvider): string {
  return PROVIDER_MODELS[provider][tier]
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
