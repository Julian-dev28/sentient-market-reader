/**
 * ROMA Aggregator
 * ───────────────
 * Synthesizes all subtask results into the answer for the parent goal.
 * Produces the coherent upward-aggregation in the ROMA task tree.
 */
import { getClaudeClient } from '../claude-client'
import type { SubTask } from './types'

export async function aggregate(
  parentGoal: string,
  context: string,
  subtasks: SubTask[]
): Promise<string> {
  const client = getClaudeClient()

  const subtaskBlock = subtasks
    .map(t => `[${t.id}] ${t.goal}\n→ ${t.result ?? '(no result)'}`)
    .join('\n\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system:
      'You are the ROMA Aggregator in a Sentient GRID multi-agent trading system. ' +
      'Synthesize the subtask results into a comprehensive, coherent answer to the parent goal. ' +
      'Do not just summarize — integrate the findings and draw a unified conclusion.',
    messages: [
      {
        role: 'user',
        content: `Parent goal: "${parentGoal}"

Market context:
${context}

Subtask results:
${subtaskBlock}

Synthesize these into a complete answer to the parent goal. Be specific about numbers, directional signals, and trading implications.`,
      },
    ],
  })

  const text = response.content.find(b => b.type === 'text')
  return text?.type === 'text' ? text.text : '[Aggregator: no response]'
}
