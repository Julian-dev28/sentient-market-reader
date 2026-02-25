import { llmChat, type AIProvider } from '../llm-client'

export async function execute(goal: string, context: string, provider: AIProvider): Promise<string> {
  return llmChat({
    provider,
    tier: 'fast',
    maxTokens: 512,
    system: 'You are the ROMA Executor in a Sentient GRID multi-agent trading system. Answer the specific analytical question directly and concisely using only the provided market data. Be precise about numbers and directional implications.',
    prompt: `Market data context:\n${context}\n\nAnalytical question:\n${goal}`,
  })
}
