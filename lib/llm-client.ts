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

// ── Default model per provider ────────────────────────────────────────────────
// Used when no model is selected via the UI picker (orModelOverride).
// Set via env vars — see .env.local. OpenRouter IDs use provider/model format.
const PROVIDER_MODELS: Record<AIProvider, { model: string; label: string }> = {
  anthropic:   { model: process.env.ANTHROPIC_MODEL   ?? 'claude-haiku-4-5-20251001', label: 'Claude' },
  openai:      { model: process.env.OPENAI_MODEL      ?? 'gpt-4o-mini',               label: 'GPT' },
  grok:        { model: process.env.GROK_MODEL        ?? 'grok-3-mini-fast',          label: 'Grok' },
  openrouter:  { model: process.env.OPENROUTER_MODEL  ?? 'google/gemini-2.5-flash',   label: 'OpenRouter' },
  huggingface: { model: process.env.HUGGINGFACE_MODEL ?? 'Qwen/Qwen2.5-7B-Instruct', label: 'HuggingFace' },
}

// Returns the model to use for a provider.
// `modelOverride` (from the UI picker) wins over the env-var default.
function resolveModel(_tier: 'fast' | 'smart' | undefined, provider: AIProvider, modelOverride?: string): string {
  return modelOverride ?? PROVIDER_MODELS[provider].model
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
    baseURL: process.env.HF_BASE_URL ?? 'https://router.huggingface.co/v1',
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
interface ToolSchema {
  properties: Record<string, unknown>
  required: string[]
}

// ── llmChat ──────────────────────────────────────────────────────────────────
/** Plain text completion — used by Executor and Aggregator */
async function llmChat(opts: {
  prompt: string
  system?: string
  tier?: 'fast' | 'smart'
  maxTokens?: number
  provider: AIProvider
  modelOverride?: string   // overrides env-var default (e.g. from UI model picker)
}): Promise<string> {
  const { prompt, system, tier = 'fast', maxTokens = 512, provider, modelOverride } = opts
  const model = resolveModel(tier, provider, modelOverride)

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
  modelOverride?: string   // overrides env-var default (e.g. from UI model picker)
  signal?: AbortSignal     // external abort (e.g. from HTTP request disconnect)
  timeoutMs?: number       // override default; scales with maxTokens if omitted
}): Promise<T> {
  const { prompt, toolName, toolDescription, schema, tier = 'fast', maxTokens = 1024, provider, modelOverride, signal: externalSignal, timeoutMs } = opts
  const model = resolveModel(tier, provider, modelOverride)
  const fullSchema = { type: 'object' as const, properties: schema.properties, required: schema.required }

  // Scale timeout: large responses (≥1024 tokens) get 60s; small extractions get 30s
  const timeout = timeoutMs ?? (maxTokens >= 1024 ? 60_000 : 30_000)
  const callSignal: AbortSignal = externalSignal
    ? (() => {
        const ctrl = new AbortController()
        const tid = setTimeout(() => ctrl.abort(new Error('llmToolCall timeout')), timeout)
        externalSignal.addEventListener('abort', () => { clearTimeout(tid); ctrl.abort(externalSignal.reason) }, { once: true })
        return ctrl.signal
      })()
    : AbortSignal.timeout(timeout)

  if (provider === 'anthropic') {
    const res = await anthropicClient().messages.create(
      {
        model,
        max_tokens: maxTokens,
        tools: [{ name: toolName, description: toolDescription, input_schema: fullSchema }],
        tool_choice: { type: 'tool', name: toolName },
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: callSignal },
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
        { signal: callSignal },
      )
      const tc = res.choices[0]?.message?.tool_calls?.[0] as { function: { arguments: string } } | undefined
      if (tc) return JSON.parse(tc.function.arguments) as T
    } catch { /* fall through to JSON extraction */ }
    // Fallback: ask for raw JSON in content
    const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema: ${JSON.stringify(fullSchema)}. No markdown, no explanation.`
    const fallback = await huggingfaceClient().chat.completions.create(
      { model, max_tokens: maxTokens, messages: [{ role: 'user', content: jsonPrompt }] },
      { signal: callSignal },
    )
    const raw = fallback.choices[0]?.message?.content ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error(`HuggingFace: no JSON found in response`)
    return JSON.parse(jsonMatch[0]) as T
  }

  const client = oaiCompatClient(provider as 'openai' | 'grok' | 'openrouter')

  const res = await client.chat.completions.create(
    {
      model,
      max_tokens: maxTokens,
      tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: fullSchema } }],
      tool_choice: { type: 'function', function: { name: toolName } },
      messages: [{ role: 'user', content: prompt }],
    },
    { signal: callSignal },
  )
  const toolCall = res.choices[0]?.message?.tool_calls?.[0] as { function: { arguments: string } } | undefined
  if (toolCall) return JSON.parse(toolCall.function.arguments) as T

  // Fallback 1: model returned JSON in content instead of tool_calls (common with reasoning models)
  const raw = res.choices[0]?.message?.content ?? ''
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]) as T } catch { /* fall through */ }
  }

  // Fallback 2: plain JSON prompt — no tools at all, just ask for the JSON directly
  const jsonPrompt = `${prompt}\n\nRespond with ONLY a valid JSON object matching this schema, no markdown:\n${JSON.stringify(fullSchema, null, 2)}`
  const res2 = await client.chat.completions.create(
    { model, max_tokens: Math.max(maxTokens, 512), messages: [{ role: 'user', content: jsonPrompt }] },
    { signal: callSignal },
  )
  const raw2 = res2.choices[0]?.message?.content ?? ''
  const jsonMatch2 = raw2.match(/\{[\s\S]*\}/)
  if (jsonMatch2) return JSON.parse(jsonMatch2[0]) as T

  throw new Error(`No tool_call from ${provider}`)
}
