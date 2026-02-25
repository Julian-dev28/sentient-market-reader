/**
 * ROMA Executor
 * ─────────────
 * Directly resolves an atomic analytical task.
 * Uses a fast model since each subtask is focused and narrow.
 */
import { getClaudeClient } from '../claude-client'

export async function execute(goal: string, context: string): Promise<string> {
  const client = getClaudeClient()

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system:
      'You are the ROMA Executor in a Sentient GRID multi-agent trading system. ' +
      'Answer the specific analytical question directly and concisely using only the provided market data. ' +
      'Be precise about numbers and directional implications.',
    messages: [
      {
        role: 'user',
        content: `Market data context:\n${context}\n\nAnalytical question:\n${goal}`,
      },
    ],
  })

  const text = response.content.find(b => b.type === 'text')
  return text?.type === 'text' ? text.text : '[Executor: no response]'
}
