import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Cache the model list for 10 minutes to avoid hammering OpenRouter
let _cache: { models: OpenRouterModel[]; fetchedAt: number } | null = null  // reset on deploy
const CACHE_TTL_MS = 10 * 60 * 1000

export interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  pricing: { prompt: string; completion: string }
}

export async function GET() {
  try {
    if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json({ models: _cache.models })
    }

    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://sentient-roma.app',
      },
      cache: 'no-store',
    })

    if (!res.ok) {
      throw new Error(`OpenRouter models API ${res.status}`)
    }

    const data = await res.json()
    const raw: OpenRouterModel[] = (data.data ?? [])
      // Only LLM chat models that output text — exclude image/video/audio/embedding gen
      .filter((m: { id: string; name: string; architecture?: { modality?: string; output_modalities?: string[] } }) => {
        // Drop pricing variants
        if (m.id.includes(':nitro') || m.id.includes(':floor') || m.id.includes(':extended')) return false
        // Use output_modalities array when available (most reliable)
        const outputMods: string[] = m.architecture?.output_modalities ?? []
        if (outputMods.length > 0) {
          return outputMods.includes('text') && !outputMods.some(o => o === 'image' || o === 'video' || o === 'audio')
        }
        // Fall back to modality string — must end in "->text" or just be "text"
        const modality = m.architecture?.modality ?? 'text->text'
        if (modality.includes('->image') || modality.includes('->video') || modality.includes('->audio')) return false
        if (!modality.includes('text')) return false
        // Name-based catch-all for anything that slipped through
        const nameLower = m.name.toLowerCase()
        if (/\b(image|video|vision|dall-e|stable.diffusion|flux|midjourney|sora|whisper|tts|embed)\b/.test(nameLower)) return false
        return true
      })
      .map((m: { id: string; name: string; context_length: number; pricing: { prompt: string; completion: string } }) => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: { prompt: m.pricing?.prompt ?? '0', completion: m.pricing?.completion ?? '0' },
      }))
      .sort((a: OpenRouterModel, b: OpenRouterModel) => a.id.localeCompare(b.id))

    _cache = { models: raw, fetchedAt: Date.now() }
    return NextResponse.json({ models: raw })
  } catch (err) {
    return NextResponse.json({ error: String(err), models: [] }, { status: 500 })
  }
}
